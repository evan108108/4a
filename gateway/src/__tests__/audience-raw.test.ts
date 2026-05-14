// Unit tests for the raw-* sibling audience endpoints (T2a). The routes
// fan out to live Nostr relays in production; here we stub `fanOut` and the
// RELAY_POOL DO so the tests stay hermetic and fast.
//
// Coverage focus: auth failure paths (NIP-98), per-endpoint validation
// errors, and the happy path for /create (the rest follow the same shape).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
} from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  buildAudienceClaim,
  buildAudienceDeclaration,
  buildKeyGrant,
} from "../lib/audience-events";
import { signEventWithRawKey } from "../lib/sign";
import type { SignedEvent } from "../kms";
import type { NostrEvent } from "../relay-pool";

// Stub publish.ts entirely. Importing the real module would transitively load
// relay-pool.ts, which imports `cloudflare:workers` and is unavailable under
// the Node test runner.
vi.mock("../publish", () => ({
  fanOut: vi.fn(async (event: SignedEvent) => [
    { relay: "wss://stub", status: "accepted" as const, accepted: true, message: "OK" },
    {
      relay: "wss://stub2",
      status: "accepted" as const,
      accepted: true,
      message: `OK ${event.id.slice(0, 8)}`,
    },
  ]),
  rateLimitCheck: vi.fn(() => ({ ok: true as const })),
}));

import { handleAudienceRawRequest, type AudienceRawEnv } from "../audience-raw";

// ─── helpers ───────────────────────────────────────────────────────────────

function makeKeypair(): { priv: Uint8Array; pub: string } {
  const priv = randomBytes(32);
  const pub = bytesToHex(schnorr.getPublicKey(priv));
  return { priv, pub };
}

function buildNip98AuthEvent(
  url: string,
  method: string,
  bodyBytes: Uint8Array,
  priv: Uint8Array,
): { header: string; pubkey: string } {
  const pubkey = bytesToHex(schnorr.getPublicKey(priv));
  const payloadHash = bytesToHex(sha256(bodyBytes));
  const created_at = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
    ["payload", payloadHash],
  ];
  const serialized = JSON.stringify([0, pubkey, created_at, 27235, tags, ""]);
  const idBytes = sha256(new TextEncoder().encode(serialized));
  const id = bytesToHex(idBytes);
  const sig = bytesToHex(schnorr.sign(idBytes, priv));
  const event = { id, pubkey, created_at, kind: 27235, tags, content: "", sig };
  const b64 = btoa(JSON.stringify(event));
  return { header: `Nostr ${b64}`, pubkey };
}

function makeRequest(
  url: string,
  method: string,
  bodyJson: unknown,
  authPriv: Uint8Array,
  bodyOverride?: Uint8Array,
): Request {
  const bodyBytes = bodyOverride ?? new TextEncoder().encode(JSON.stringify(bodyJson));
  const { header } = buildNip98AuthEvent(url, method, bodyBytes, authPriv);
  return new Request(url, {
    method,
    headers: { Authorization: header, "content-type": "application/json" },
    body: bodyBytes,
  });
}

interface StubDO {
  events: Map<string, NostrEvent>;
  getObject(kind: number, pubkey: string, d: string): Promise<NostrEvent | null>;
  storeAudienceEvent(event: NostrEvent): Promise<{ ok: boolean }>;
  storeGiftWrap(event: NostrEvent, recipient: string): Promise<{ ok: boolean }>;
}

function makeStubEnv(): { env: AudienceRawEnv; stub: StubDO } {
  const stub: StubDO = {
    events: new Map(),
    async getObject(kind, pubkey, d) {
      return stub.events.get(`${kind}:${pubkey.toLowerCase()}:${d}`) ?? null;
    },
    async storeAudienceEvent(event) {
      const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
      stub.events.set(`${event.kind}:${event.pubkey.toLowerCase()}:${dTag}`, event);
      return { ok: true };
    },
    async storeGiftWrap() {
      return { ok: true };
    },
  };
  const namespace = {
    idFromName: (_: string) => ({ name: "main" }),
    get: (_id: unknown) => stub,
  } as unknown as DurableObjectNamespace;
  const env = {
    RELAY_POOL: namespace,
  } as unknown as AudienceRawEnv;
  return { env, stub };
}

// Build a complete declaration + founding-grant pair signed with consistent
// keys for the /create happy path and the lookup-cache seed for other routes.
function buildRoom(
  slug: string,
  founderPub: string,
): {
  audId: { priv: Uint8Array; pub: string };
  epochPub: string;
  declaration: SignedEvent;
  founding_grant: SignedEvent;
} {
  const audId = makeKeypair();
  const epoch = makeKeypair();
  const declTpl = buildAudienceDeclaration({
    audIdPub: audId.pub,
    slug,
    name: slug,
    epoch: 1,
    epochPub: epoch.pub,
    members: [founderPub],
  });
  const declaration = signEventWithRawKey(declTpl, audId.priv);
  // The founding grant content is opaque ciphertext — for unit tests we just
  // need *valid NIP-44 v2 structurally*. The keygrant validator's structural
  // check uses lib/nip44.isStructurallyValid; we feed a real-shaped payload.
  const grantTpl = buildKeyGrant({
    audIdPub: audId.pub,
    slug,
    epoch: 1,
    recipientPub: founderPub,
    ciphertext: fakeNip44V2Ciphertext(),
  });
  const founding_grant = signEventWithRawKey(grantTpl, audId.priv);
  return { audId, epochPub: epoch.pub, declaration, founding_grant };
}

// Minimum-length structurally-valid NIP-44 v2 ciphertext (base64). Per
// lib/nip44.isStructurallyValid: byte 0 = 0x02, total length within bounds.
// We don't decrypt in tests, so any well-shaped blob suffices.
function fakeNip44V2Ciphertext(): string {
  const buf = new Uint8Array(99);
  buf[0] = 0x02;
  // pad with deterministic bytes so each call produces the same ciphertext.
  for (let i = 1; i < buf.length; i++) buf[i] = i & 0xff;
  // base64 encode
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
  return btoa(bin);
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe("handleAudienceRawRequest — auth", () => {
  it("rejects missing Authorization header with 401", async () => {
    const { env } = makeStubEnv();
    const req = new Request("https://api.4a4.ai/v0/audience/raw/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_authorization_header");
  });

  it("rejects mismatched HTTP method tag", async () => {
    const { env } = makeStubEnv();
    const caller = makeKeypair();
    const url = "https://api.4a4.ai/v0/audience/raw/create";
    const bodyBytes = new TextEncoder().encode("{}");
    // Build an auth event with method=GET but send POST.
    const { header } = buildNip98AuthEvent(url, "GET", bodyBytes, caller.priv);
    const req = new Request(url, {
      method: "POST",
      headers: { Authorization: header, "content-type": "application/json" },
      body: bodyBytes,
    });
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("method_mismatch");
  });

  it("rejects payload-hash mismatch", async () => {
    const { env } = makeStubEnv();
    const caller = makeKeypair();
    const url = "https://api.4a4.ai/v0/audience/raw/create";
    const truthful = new TextEncoder().encode("{}");
    const { header } = buildNip98AuthEvent(url, "POST", truthful, caller.priv);
    // Send a different body than the one the auth event committed to.
    const tampered = new TextEncoder().encode('{"x":1}');
    const req = new Request(url, {
      method: "POST",
      headers: { Authorization: header, "content-type": "application/json" },
      body: tampered,
    });
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("payload_hash_mismatch");
  });

  it("returns 405 for non-POST methods", async () => {
    const { env } = makeStubEnv();
    const req = new Request("https://api.4a4.ai/v0/audience/raw/create", {
      method: "GET",
    });
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 404 for unknown raw subpaths", async () => {
    const { env } = makeStubEnv();
    const caller = makeKeypair();
    const url = "https://api.4a4.ai/v0/audience/raw/nonexistent";
    const req = makeRequest(url, "POST", {}, caller.priv);
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(404);
  });
});

describe("handleAudienceRawRequest — /create", () => {
  let env: AudienceRawEnv;
  let stub: StubDO;
  const caller = makeKeypair();

  beforeEach(() => {
    const made = makeStubEnv();
    env = made.env;
    stub = made.stub;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: validates and fans out declaration + founding grant", async () => {
    const room = buildRoom("studio-room", caller.pub);
    const url = "https://api.4a4.ai/v0/audience/raw/create";
    const req = makeRequest(
      url,
      "POST",
      { declaration: room.declaration, founding_grant: room.founding_grant },
      caller.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      declaration_event_id: string;
      founding_grant_event_id: string;
    };
    expect(body.ok).toBe(true);
    expect(body.declaration_event_id).toBe(room.declaration.id);
    expect(body.founding_grant_event_id).toBe(room.founding_grant.id);
    // Cache populated.
    expect(stub.events.size).toBeGreaterThan(0);
  });

  it("rejects when caller_pubkey is not a member of the declaration", async () => {
    // Founder is someone else; caller is not in the declaration.
    const otherFounder = makeKeypair();
    const room = buildRoom("studio-room", otherFounder.pub);
    const url = "https://api.4a4.ai/v0/audience/raw/create";
    const req = makeRequest(
      url,
      "POST",
      { declaration: room.declaration, founding_grant: room.founding_grant },
      caller.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toMatch(/caller_pubkey must appear as a member/);
  });

  it("rejects when founding_grant.pubkey != declaration.pubkey", async () => {
    const room = buildRoom("studio-room", caller.pub);
    // Re-sign the grant with a different key than aud_id.
    const wrongSigner = makeKeypair();
    const grantTpl = {
      created_at: room.founding_grant.created_at,
      kind: room.founding_grant.kind,
      tags: room.founding_grant.tags,
      content: room.founding_grant.content,
    };
    const badGrant = signEventWithRawKey(grantTpl, wrongSigner.priv);
    const url = "https://api.4a4.ai/v0/audience/raw/create";
    const req = makeRequest(
      url,
      "POST",
      { declaration: room.declaration, founding_grant: badGrant },
      caller.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(400);
  });

  it("rejects a tampered declaration signature", async () => {
    const room = buildRoom("studio-room", caller.pub);
    const tampered: SignedEvent = {
      ...room.declaration,
      sig: "0".repeat(128),
    };
    const url = "https://api.4a4.ai/v0/audience/raw/create";
    const req = makeRequest(
      url,
      "POST",
      { declaration: tampered, founding_grant: room.founding_grant },
      caller.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/schnorr signature/);
  });
});

describe("handleAudienceRawRequest — /grant", () => {
  it("requires grant.pubkey == caller_pubkey", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const room = buildRoom("room-grant", founder.pub);
    // seed declaration into cache
    await stub.storeAudienceEvent(room.declaration);

    // A different caller posts a grant signed by a third-party priv.
    const caller = makeKeypair();
    const intruder = makeKeypair();
    const grantTpl = buildKeyGrant({
      audIdPub: room.audId.pub,
      slug: "room-grant",
      epoch: 1,
      recipientPub: founder.pub,
      ciphertext: fakeNip44V2Ciphertext(),
    });
    const intruderGrant = signEventWithRawKey(grantTpl, intruder.priv);

    const url = "https://api.4a4.ai/v0/audience/raw/grant";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${room.audId.pub}:room-grant`,
        grant: intruderGrant,
      },
      caller.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/grant must be signed by the caller/);
  });

  it("returns 404 if the audience declaration is not cached", async () => {
    const { env } = makeStubEnv();
    const caller = makeKeypair();
    const audId = makeKeypair();
    const grantTpl = buildKeyGrant({
      audIdPub: audId.pub,
      slug: "missing",
      epoch: 1,
      recipientPub: caller.pub,
      ciphertext: fakeNip44V2Ciphertext(),
    });
    const grant = signEventWithRawKey(grantTpl, caller.priv);
    const url = "https://api.4a4.ai/v0/audience/raw/grant";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${audId.pub}:missing`,
        grant,
      },
      caller.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(404);
  });
});

describe("handleAudienceRawRequest — /publish-wraps", () => {
  it("rejects gift-wraps addressing non-members", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const room = buildRoom("wrap-room", founder.pub);
    await stub.storeAudienceEvent(room.declaration);

    // Build a gift-wrap addressed to a stranger.
    const stranger = makeKeypair();
    const wrapTpl = {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", stranger.pub]],
      content: fakeNip44V2Ciphertext(),
    };
    const ephemeral = makeKeypair();
    const wrap = signEventWithRawKey(wrapTpl, ephemeral.priv);

    const url = "https://api.4a4.ai/v0/audience/raw/publish-wraps";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${room.audId.pub}:wrap-room`,
        gift_wraps: [wrap],
      },
      founder.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/non-member/);
  });

  it("happy path: fans out wraps for a current member", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const room = buildRoom("wrap-room-ok", founder.pub);
    await stub.storeAudienceEvent(room.declaration);

    const wrapTpl = {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", founder.pub]],
      content: fakeNip44V2Ciphertext(),
    };
    const ephemeral = makeKeypair();
    const wrap = signEventWithRawKey(wrapTpl, ephemeral.priv);

    const url = "https://api.4a4.ai/v0/audience/raw/publish-wraps";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${room.audId.pub}:wrap-room-ok`,
        gift_wraps: [wrap],
      },
      founder.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      epoch: number;
      gift_wraps: { recipient: string; event_id: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.epoch).toBe(1);
    expect(body.gift_wraps).toHaveLength(1);
    expect(body.gift_wraps[0]!.recipient).toBe(founder.pub);
    expect(body.gift_wraps[0]!.event_id).toBe(wrap.id);
  });
});

describe("handleAudienceRawRequest — /process-claims", () => {
  it("returns 404 if the audience declaration is not cached", async () => {
    const { env } = makeStubEnv();
    const caller = makeKeypair();
    const audId = makeKeypair();
    const url = "https://api.4a4.ai/v0/audience/raw/process-claims";
    const req = makeRequest(
      url,
      "POST",
      { audience_address: `30520:${audId.pub}:no-room` },
      caller.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(404);
  });

  it("returns claimed=[] when no fa:pending entries exist", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const room = buildRoom("no-claims", founder.pub);
    await stub.storeAudienceEvent(room.declaration);

    const url = "https://api.4a4.ai/v0/audience/raw/process-claims";
    const req = makeRequest(
      url,
      "POST",
      { audience_address: `30520:${room.audId.pub}:no-claims` },
      founder.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; claimed: unknown[] };
    expect(body.claimed).toEqual([]);
  });
});

describe("handleAudienceRawRequest — /claim", () => {
  it("rejects a malformed claim event", async () => {
    const { env } = makeStubEnv();
    const caller = makeKeypair();
    const audId = makeKeypair();
    // A claim with the wrong kind.
    const fakeTpl = {
      kind: 1, // not 30522
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: "",
    };
    const claim = signEventWithRawKey(fakeTpl, caller.priv);
    const url = "https://api.4a4.ai/v0/audience/raw/claim";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${audId.pub}:r`,
        claim,
      },
      caller.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(400);
  });
});

describe("handleAudienceRawRequest — /rotate", () => {
  it("rejects when declaration.pubkey != aud_id (audience_address pubkey)", async () => {
    const { env } = makeStubEnv();
    const caller = makeKeypair();
    const audId = makeKeypair();
    const wrongSigner = makeKeypair();
    const epoch = makeKeypair();
    const declTpl = buildAudienceDeclaration({
      audIdPub: audId.pub,
      slug: "rot",
      name: "rot",
      epoch: 2,
      epochPub: epoch.pub,
      members: [caller.pub],
    });
    // Sign with wrong key — declaration.pubkey will be wrongSigner.pub.
    const declaration = signEventWithRawKey(declTpl, wrongSigner.priv);
    const url = "https://api.4a4.ai/v0/audience/raw/rotate";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${audId.pub}:rot`,
        declaration,
        grants: [],
      },
      caller.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/declaration must be signed by aud_id/);
  });
});

describe("handleAudienceRawRequest — /invite", () => {
  it("rejects when invite_pub is not in the declaration's fa:pending", async () => {
    const { env } = makeStubEnv();
    const founder = makeKeypair();
    const room = buildRoom("inv-room", founder.pub);
    // Re-sign declaration with no pending entries (room as built has none).
    const url = "https://api.4a4.ai/v0/audience/raw/invite";
    const invitePub = bytesToHex(schnorr.getPublicKey(randomBytes(32)));
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${room.audId.pub}:inv-room`,
        declaration: room.declaration,
        invite_pub: invitePub,
        invite_priv_4ainv: "4ainv1placeholderkey",
      },
      founder.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/fa:pending/);
  });
});

// Smoke test: claim event that is structurally well-formed (passes
// validateAudienceClaimEvent without lookup) but has no cached declaration.
describe("handleAudienceRawRequest — /claim wellformed without cache", () => {
  it("publishes when the cache is empty (validator runs without lookup)", async () => {
    const { env } = makeStubEnv();
    const audId = makeKeypair();
    const invite = makeKeypair();
    const claimer = makeKeypair();
    const inviter = makeKeypair();
    const claimTpl = buildAudienceClaim({
      audIdPub: audId.pub,
      slug: "rsvp",
      epoch: 1,
      invitePub: invite.pub,
      inviterPub: inviter.pub,
      claimPub: claimer.pub,
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    const claim = signEventWithRawKey(claimTpl, invite.priv);
    const url = "https://api.4a4.ai/v0/audience/raw/claim";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${audId.pub}:rsvp`,
        claim,
      },
      invite.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; claim_event_id: string };
    expect(body.claim_event_id).toBe(claim.id);
  });
});

// Closed-room guard wiring — verifies that the raw routes refuse mutating
// operations when the cached kind:30520 carries fa:status=closed. The guard
// itself is unit-tested in audience-closed-guard.test.ts; here we only
// confirm each route reaches that path. See sonata-studio-room-lifecycle §5.
describe("handleAudienceRawRequest — closed-room guard", () => {
  /** Seed a closed kind:30520 declaration into the stub cache. */
  function seedClosedRoom(
    slug: string,
    stub: StubDO,
    founderPub: string,
  ): { audId: { priv: Uint8Array; pub: string }; declaration: SignedEvent } {
    const audId = makeKeypair();
    const epoch = makeKeypair();
    const declTpl = buildAudienceDeclaration({
      audIdPub: audId.pub,
      slug,
      name: slug,
      epoch: 1,
      epochPub: epoch.pub,
      members: [founderPub],
    });
    declTpl.tags.push(["fa:status", "closed"]);
    declTpl.tags.push(["fa:closed-at", String(Math.floor(Date.now() / 1000))]);
    const declaration = signEventWithRawKey(declTpl, audId.priv);
    stub.events.set(`30520:${audId.pub.toLowerCase()}:${slug}`, declaration);
    return { audId, declaration };
  }

  it("/grant on a closed room returns 403 closed_room", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const { audId } = seedClosedRoom("closed-room", stub, founder.pub);
    const grantTpl = buildKeyGrant({
      audIdPub: audId.pub,
      slug: "closed-room",
      epoch: 1,
      recipientPub: founder.pub,
      ciphertext: fakeNip44V2Ciphertext(),
    });
    const grant = signEventWithRawKey(grantTpl, founder.priv);
    const url = "https://api.4a4.ai/v0/audience/raw/grant";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${audId.pub}:closed-room`,
        grant,
      },
      founder.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; operation: string };
    expect(body.error).toBe("closed_room");
    expect(body.operation).toBe("grant");
  });

  it("/publish-wraps on a closed room returns 403 closed_room", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const { audId } = seedClosedRoom("closed-wraps", stub, founder.pub);
    const wrapTpl = {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", founder.pub]],
      content: fakeNip44V2Ciphertext(),
    };
    const ephemeral = makeKeypair();
    const wrap = signEventWithRawKey(wrapTpl, ephemeral.priv);
    const url = "https://api.4a4.ai/v0/audience/raw/publish-wraps";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${audId.pub}:closed-wraps`,
        gift_wraps: [wrap],
      },
      founder.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("closed_room");
  });

  it("/claim with fa:status=left passes the closed-room guard", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const { audId } = seedClosedRoom("closed-leave", stub, founder.pub);
    // Build a leave claim: signing pubkey == claim-pubkey, d-tag with the
    // "left:" segment per §4.2. The validator dispatch added in step 3 will
    // accept this; here we only verify the guard does NOT reject up-front.
    // (validateAudienceClaimEvent will reject because the d-tag shape isn't
    // the legacy join form, but the status before that is what we test.)
    const leaveTpl = {
      kind: 30522,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", `closed-leave:1:left:${founder.pub}`],
        ["fa:context", "https://4a4.ai/ns/v0"],
        ["alt", "leave audience closed-leave epoch 1"],
        ["a", `30520:${audId.pub}:closed-leave`],
        ["fa:epoch", "1"],
        ["fa:status", "left"],
        ["fa:claim-pubkey", founder.pub],
      ],
      content: JSON.stringify({
        "@context": "https://4a4.ai/ns/v0",
        "@type": "AudienceClaim",
        audience: "closed-leave",
        epoch: 1,
        claimPubkey: founder.pub,
        status: "left",
      }),
    };
    const leave = signEventWithRawKey(leaveTpl, founder.priv);
    const url = "https://api.4a4.ai/v0/audience/raw/claim";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${audId.pub}:closed-leave`,
        claim: leave,
      },
      founder.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    // The guard passes (no 403 closed_room); validator may still reject for
    // d-tag shape, which is a separate concern wired up in step 3.
    expect(res.status).not.toBe(403);
    if (res.status === 400) {
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toBe("closed_room");
    }
  });
});

// Tests for the new /v0/audience/raw/publish-declaration route added by the
// closed-room work (used by boot / close / reopen in later steps).
describe("handleAudienceRawRequest — /publish-declaration", () => {
  it("rejects when declaration.pubkey != aud_id", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const room = buildRoom("pubd-room", founder.pub);
    await stub.storeAudienceEvent(room.declaration);
    // Craft a declaration signed by a wrong key.
    const wrongSigner = makeKeypair();
    const tpl = buildAudienceDeclaration({
      audIdPub: room.audId.pub,
      slug: "pubd-room",
      name: "pubd-room",
      epoch: 1,
      epochPub: room.epochPub,
      members: [founder.pub],
    });
    const bad = signEventWithRawKey(tpl, wrongSigner.priv);
    const url = "https://api.4a4.ai/v0/audience/raw/publish-declaration";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${room.audId.pub}:pubd-room`,
        declaration: bad,
      },
      founder.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/signed by aud_id/);
  });

  it("publishes a re-signed declaration for boot/close/reopen", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const room = buildRoom("pubd-ok", founder.pub);
    await stub.storeAudienceEvent(room.declaration);
    // Re-emit with fa:status=closed (founder closing the room).
    const tpl = buildAudienceDeclaration({
      audIdPub: room.audId.pub,
      slug: "pubd-ok",
      name: "pubd-ok",
      epoch: 1,
      epochPub: room.epochPub,
      members: [founder.pub],
    });
    tpl.tags.push(["fa:status", "closed"]);
    tpl.tags.push(["fa:closed-at", String(Math.floor(Date.now() / 1000))]);
    tpl.created_at = room.declaration.created_at + 1;
    const closedDecl = signEventWithRawKey(tpl, room.audId.priv);
    const url = "https://api.4a4.ai/v0/audience/raw/publish-declaration";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${room.audId.pub}:pubd-ok`,
        declaration: closedDecl,
      },
      founder.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; declaration_event_id: string };
    expect(body.declaration_event_id).toBe(closedDecl.id);
  });

  it("rejects roster changes while the audience remains closed", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const other = makeKeypair();
    // Seed an already-closed declaration with one member.
    const audId = makeKeypair();
    const epochKp = makeKeypair();
    const closedTpl = buildAudienceDeclaration({
      audIdPub: audId.pub,
      slug: "locked",
      name: "locked",
      epoch: 1,
      epochPub: epochKp.pub,
      members: [founder.pub],
    });
    closedTpl.tags.push(["fa:status", "closed"]);
    closedTpl.tags.push(["fa:closed-at", String(Math.floor(Date.now() / 1000))]);
    const closedSigned = signEventWithRawKey(closedTpl, audId.priv);
    await stub.storeAudienceEvent(closedSigned);
    // Attempt to publish a new closed declaration that adds another member.
    const reshapeTpl = buildAudienceDeclaration({
      audIdPub: audId.pub,
      slug: "locked",
      name: "locked",
      epoch: 1,
      epochPub: epochKp.pub,
      members: [founder.pub, other.pub],
    });
    reshapeTpl.tags.push(["fa:status", "closed"]);
    reshapeTpl.tags.push(["fa:closed-at", String(Math.floor(Date.now() / 1000))]);
    reshapeTpl.created_at = closedSigned.created_at + 1;
    const reshape = signEventWithRawKey(reshapeTpl, audId.priv);
    const url = "https://api.4a4.ai/v0/audience/raw/publish-declaration";
    const req = makeRequest(
      url,
      "POST",
      {
        audience_address: `30520:${audId.pub}:locked`,
        declaration: reshape,
      },
      founder.priv,
    );
    const res = await handleAudienceRawRequest(req, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("closed_room_roster_locked");
  });
});

// Sanity: helpers above use the shared fakeNip44V2Ciphertext; this guards
// against accidental decoding by the structural check.
describe("test helpers", () => {
  it("fakeNip44V2Ciphertext starts with the v2 version byte", () => {
    const b = fakeNip44V2Ciphertext();
    const decoded = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    expect(decoded[0]).toBe(0x02);
  });
  it("hexToBytes round trip", () => {
    const k = randomBytes(32);
    expect(bytesToHex(hexToBytes(bytesToHex(k)))).toBe(bytesToHex(k));
  });
});
