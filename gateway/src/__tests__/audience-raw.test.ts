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
const { defaultFanOut, defaultFanOutBatch } = vi.hoisted(() => {
  const defaultFanOut = async (event: { id: string }) => [
    { relay: "wss://stub", status: "accepted" as const, accepted: true, message: "OK" },
    {
      relay: "wss://stub2",
      status: "accepted" as const,
      accepted: true,
      message: `OK ${event.id.slice(0, 8)}`,
    },
  ];
  const defaultFanOutBatch = (events: readonly { id: string }[]) => Promise.all(events.map(defaultFanOut));
  return { defaultFanOut, defaultFanOutBatch };
});
vi.mock("../publish", () => {
  const fanOutBatch = vi.fn(defaultFanOutBatch);
  return {
    fanOut: vi.fn(defaultFanOut),
    fanOutBatch,
    // The detailed variant (used by deliverMemberWraps) goes through the
    // mocked fanOutBatch, so tests can drive and inspect both through it.
    fanOutBatchDetailed: vi.fn(async (events: readonly { id: string }[]) => ({
      acks: await fanOutBatch(events as never),
      relays: [],
    })),
    enqueueRelayRetries: vi.fn(async () => {}),
    rateLimitCheck: vi.fn(() => ({ ok: true as const })),
  };
});

import { handleAudienceRawRequest, type AudienceRawEnv } from "../audience-raw";
import { enqueueRelayRetries, fanOut, fanOutBatch, type RelayResult } from "../publish";

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

describe("handleAudienceRawRequest — /grant with updated_declaration (new members)", () => {
  const SLUG = "room-succ";
  const url = "https://api.4a4.ai/v0/audience/raw/grant";

  // A cached room whose declaration is 100s old, so a successor signed "now"
  // is strictly newer.
  function seedRoom() {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const service = makeKeypair(); // e.g. hs's service member
    const audId = makeKeypair();
    const epoch = makeKeypair();
    const cachedCreatedAt = Math.floor(Date.now() / 1000) - 100;
    const declaration = signEventWithRawKey(
      buildAudienceDeclaration({
        audIdPub: audId.pub,
        slug: SLUG,
        name: SLUG,
        epoch: 1,
        epochPub: epoch.pub,
        members: [founder.pub, service.pub],
        createdAt: cachedCreatedAt,
      }),
      audId.priv,
    );
    return { env, stub, founder, service, audId, epochPub: epoch.pub, declaration, cachedCreatedAt };
  }

  function successor(
    room: ReturnType<typeof seedRoom>,
    over: {
      members?: string[];
      epoch?: number;
      epochPub?: string;
      createdAt?: number;
      status?: "closed";
      signer?: Uint8Array;
    },
  ): SignedEvent {
    return signEventWithRawKey(
      buildAudienceDeclaration({
        audIdPub: room.audId.pub,
        slug: SLUG,
        name: SLUG,
        epoch: over.epoch ?? 1,
        epochPub: over.epochPub ?? room.epochPub,
        members: over.members ?? [room.founder.pub, room.service.pub],
        createdAt: over.createdAt ?? Math.floor(Date.now() / 1000),
        ...(over.status ? { status: over.status } : {}),
      }),
      over.signer ?? room.audId.priv,
    );
  }

  function grantFor(room: ReturnType<typeof seedRoom>, granterPriv: Uint8Array, recipientPub: string): SignedEvent {
    return signEventWithRawKey(
      buildKeyGrant({
        audIdPub: room.audId.pub,
        slug: SLUG,
        epoch: 1,
        recipientPub,
        ciphertext: fakeNip44V2Ciphertext(),
      }),
      granterPriv,
    );
  }

  async function post(room: ReturnType<typeof seedRoom>, callerPriv: Uint8Array, body: Record<string, unknown>) {
    const req = makeRequest(url, "POST", { audience_address: `30520:${room.audId.pub}:${SLUG}`, ...body }, callerPriv);
    return handleAudienceRawRequest(req, room.env);
  }

  beforeEach(() => {
    vi.mocked(fanOut).mockClear();
  });

  it("hs scenario: cached member S grants new pubkey N with updated_declaration (members + N, later created_at) → 200, declaration published before grant", async () => {
    const room = seedRoom();
    await room.stub.storeAudienceEvent(room.declaration);
    const newbie = makeKeypair();
    const updated = successor(room, { members: [room.founder.pub, room.service.pub, newbie.pub] });
    const grant = grantFor(room, room.service.priv, newbie.pub);

    const res = await post(room, room.service.priv, { grant, updated_declaration: updated });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; grant_event_id: string; declaration_event_id: string };
    expect(body.ok).toBe(true);
    expect(body.grant_event_id).toBe(grant.id);
    expect(body.declaration_event_id).toBe(updated.id);

    const published = vi.mocked(fanOut).mock.calls.map((c) => (c[0] as SignedEvent).id);
    expect(published).toEqual([updated.id, grant.id]);
    // cache now holds the successor declaration
    expect((await room.stub.getObject(30520, room.audId.pub, SLUG))?.id).toBe(updated.id);
  });

  it("new member WITHOUT updated_declaration → 400 (unchanged behaviour)", async () => {
    const room = seedRoom();
    await room.stub.storeAudienceEvent(room.declaration);
    const newbie = makeKeypair();
    const res = await post(room, room.service.priv, { grant: grantFor(room, room.service.priv, newbie.pub) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/not a current member or pending invite/);
    expect(vi.mocked(fanOut)).not.toHaveBeenCalled();
  });

  it("existing member grant without updated_declaration still → 200", async () => {
    const room = seedRoom();
    await room.stub.storeAudienceEvent(room.declaration);
    const grant = grantFor(room, room.founder.priv, room.service.pub);
    const res = await post(room, room.founder.priv, { grant });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { declaration_event_id: string };
    expect(body.declaration_event_id).toBe(room.declaration.id);
    expect(vi.mocked(fanOut).mock.calls.map((c) => (c[0] as SignedEvent).id)).toEqual([grant.id]);
  });

  it("re-sending the identical cached declaration is a no-op (only the grant is published)", async () => {
    const room = seedRoom();
    await room.stub.storeAudienceEvent(room.declaration);
    const grant = grantFor(room, room.founder.priv, room.service.pub);
    const res = await post(room, room.founder.priv, { grant, updated_declaration: room.declaration });
    expect(res.status).toBe(200);
    expect(vi.mocked(fanOut).mock.calls.map((c) => (c[0] as SignedEvent).id)).toEqual([grant.id]);
  });

  it("anti-self-promotion: a non-member granter can't add itself via updated_declaration → 400", async () => {
    const room = seedRoom();
    await room.stub.storeAudienceEvent(room.declaration);
    const outsider = makeKeypair();
    const newbie = makeKeypair();
    // Even a genuine aud_id-signed successor that lists the outsider does not
    // authorise the outsider as a granter.
    const updated = successor(room, {
      members: [room.founder.pub, room.service.pub, outsider.pub, newbie.pub],
    });
    const res = await post(room, outsider.priv, {
      grant: grantFor(room, outsider.priv, newbie.pub),
      updated_declaration: updated,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/granter is not a current member/);
    expect(vi.mocked(fanOut)).not.toHaveBeenCalled();
  });

  const bad: Array<[string, (r: ReturnType<typeof seedRoom>, newbie: string) => SignedEvent, RegExp]> = [
    ["drops a member", (r, n) => successor(r, { members: [r.service.pub, n] }), /drops 1 current member/],
    ["changes the epoch", (r, n) => successor(r, { members: [r.founder.pub, r.service.pub, n], epoch: 2 }), /epoch \(2\) must equal the current epoch/],
    ["changes the epoch pubkey", (r, n) => successor(r, { members: [r.founder.pub, r.service.pub, n], epochPub: makeKeypair().pub }), /keep the current fa:epoch-pubkey/],
    ["is signed by the wrong key", (r, n) => successor(r, { members: [r.founder.pub, r.service.pub, n], signer: makeKeypair().priv }), /must be signed by aud_id/],
    ["is not newer than the cached declaration", (r, n) => successor(r, { members: [r.founder.pub, r.service.pub, n], createdAt: r.cachedCreatedAt }), /must be newer than the current declaration/],
    ["closes the audience", (r, n) => successor(r, { members: [r.founder.pub, r.service.pub, n], status: "closed" }), /must not close the audience/],
  ];
  for (const [what, make, msg] of bad) {
    it(`updated_declaration that ${what} → 400, nothing published`, async () => {
      const room = seedRoom();
      await room.stub.storeAudienceEvent(room.declaration);
      const newbie = makeKeypair();
      const res = await post(room, room.service.priv, {
        grant: grantFor(room, room.service.priv, newbie.pub),
        updated_declaration: make(room, newbie.pub),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toMatch(msg);
      expect(vi.mocked(fanOut)).not.toHaveBeenCalled();
    });
  }

  it("if no relay accepts the updated_declaration → 502 and the grant is NOT published", async () => {
    const room = seedRoom();
    await room.stub.storeAudienceEvent(room.declaration);
    const newbie = makeKeypair();
    vi.mocked(fanOut).mockImplementationOnce(async () => [
      { relay: "wss://stub", status: "rejected" as const, accepted: false, message: "nope" },
    ] as never);
    const res = await post(room, room.service.priv, {
      grant: grantFor(room, room.service.priv, newbie.pub),
      updated_declaration: successor(room, { members: [room.founder.pub, room.service.pub, newbie.pub] }),
    });
    expect(res.status).toBe(502);
    expect(vi.mocked(fanOut)).toHaveBeenCalledTimes(1);
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
// ─── batched relay fan-out (2026-09-27) ────────────────────────────────────
//
// publish-wraps and rotate's grants[] published one event at a time; a
// 40-wrap publish-wraps call took ~3.5 min. They now hand every event to
// fanOutBatch in one call (one socket per relay; the socket-level behaviour
// is tested in relay-fanout-timeout.test.ts), keep request order, cache wraps
// before the relay fan-out, and queue transient relay failures for retry.

describe("handleAudienceRawRequest — batched relay fan-out", () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const acceptedAcks = (id: string): RelayResult[] => [
    { relay: "wss://stub", status: "accepted", accepted: true, message: "OK" },
    { relay: "wss://stub2", status: "accepted", accepted: true, message: `OK ${id.slice(0, 8)}` },
  ];

  beforeEach(() => {
    vi.mocked(fanOut).mockClear();
    vi.mocked(fanOutBatch).mockClear();
    vi.mocked(enqueueRelayRetries).mockClear();
  });
  afterEach(() => {
    vi.mocked(fanOut).mockImplementation(defaultFanOut);
    vi.mocked(fanOutBatch).mockImplementation(defaultFanOutBatch);
  });

  // A room whose declaration lists `members` (founder first), cached in the stub.
  function seedRoom(stub: StubDO, slug: string, members: string[], epoch = 1) {
    const audId = makeKeypair();
    const declaration = signEventWithRawKey(
      buildAudienceDeclaration({ audIdPub: audId.pub, slug, name: slug, epoch, epochPub: makeKeypair().pub, members }),
      audId.priv,
    );
    stub.events.set(`30520:${audId.pub}:${slug}`, declaration);
    return { audId, address: `30520:${audId.pub}:${slug}` };
  }

  function wrapFor(recipient: string): SignedEvent {
    return signEventWithRawKey(
      { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [["p", recipient]], content: fakeNip44V2Ciphertext() },
      makeKeypair().priv,
    );
  }

  async function publishWraps(env: AudienceRawEnv, callerPriv: Uint8Array, address: string, wraps: SignedEvent[]) {
    const url = "https://api.4a4.ai/v0/audience/raw/publish-wraps";
    const res = await handleAudienceRawRequest(
      makeRequest(url, "POST", { audience_address: address, gift_wraps: wraps }, callerPriv),
      env,
    );
    return {
      status: res.status,
      body: (await res.json()) as {
        ok: true;
        audience_address: string;
        epoch: number;
        gift_wraps: { recipient: string; event_id: string; relay_acks: RelayResult[] }[];
      },
    };
  }

  it("publish-wraps: all wraps go to the relays in ONE batch, in request order", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const others = [makeKeypair(), makeKeypair()];
    const room = seedRoom(stub, "batch", [founder.pub, ...others.map((o) => o.pub)]);
    const recipients = Array.from({ length: 40 }, (_, i) => [founder.pub, others[0]!.pub, others[1]!.pub][i % 3]!);
    const wraps = recipients.map(wrapFor);

    const { status, body } = await publishWraps(env, founder.priv, room.address, wraps);
    expect(status).toBe(200);
    expect(vi.mocked(fanOut)).not.toHaveBeenCalled();
    expect(vi.mocked(fanOutBatch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fanOutBatch).mock.calls[0]![0].map((e) => e.id)).toEqual(wraps.map((w) => w.id));
    // Response shape and order unchanged; each wrap gets its own acks.
    expect(body).toMatchObject({ ok: true, audience_address: room.address, epoch: 1 });
    expect(body.gift_wraps.map((g) => g.event_id)).toEqual(wraps.map((w) => w.id));
    expect(body.gift_wraps.map((g) => g.recipient)).toEqual(recipients);
    expect(body.gift_wraps.map((g) => g.relay_acks)).toEqual(wraps.map((w) => acceptedAcks(w.id)));
  });

  it("publish-wraps: logs ONE structured timing line per request", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const room = seedRoom(stub, "timing", [founder.pub]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const wraps = [wrapFor(founder.pub), wrapFor(founder.pub)];
    const { status } = await publishWraps(env, founder.priv, room.address, wraps);
    expect(status).toBe(200);
    const lines = log.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((l) => l.includes("audience.wraps.timing"));
    log.mockRestore();
    expect(lines).toHaveLength(1);
    const t = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(t).toMatchObject({ msg: "audience.wraps.timing", route: "audience/raw/publish-wraps", slug: "timing", wraps: 2, relays: [] });
    for (const phase of ["total_ms", "lookup_ms", "validate_ms", "cache_ms", "fanout_ms", "retry_ms"]) {
      expect(typeof t[phase]).toBe("number");
    }
  });

  it("publish-wraps: caches every wrap before the relay batch, even if no relay accepts, and queues retries per wrap", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const room = seedRoom(stub, "cache", [founder.pub]);
    const log: string[] = [];
    stub.storeGiftWrap = async (event, recipient) => {
      await sleep(5); // a slow cache must still finish before the relays
      log.push(`store:${event.id}:${recipient}`);
      return { ok: true };
    };
    const retrying = (id: string): RelayResult[] => [
      { relay: "wss://stub", status: "rate-limited-retrying", accepted: false, message: "timeout waiting for OK" },
      { relay: "wss://stub2", status: "failed-permanent", accepted: false, message: `blocked ${id.slice(0, 4)}` },
    ];
    vi.mocked(fanOutBatch).mockImplementation(async (events) => {
      log.push("relays");
      return events.map((e) => retrying(e.id));
    });
    const wraps = [wrapFor(founder.pub), wrapFor(founder.pub), wrapFor(founder.pub)];

    const { status, body } = await publishWraps(env, founder.priv, room.address, wraps);
    expect(status).toBe(200);
    expect(log.slice(0, 3).sort()).toEqual(wraps.map((w) => `store:${w.id}:${founder.pub}`).sort());
    expect(log[3]).toBe("relays");
    expect(body.gift_wraps.map((g) => g.relay_acks)).toEqual(wraps.map((w) => retrying(w.id)));
    // One retry hand-off per wrap, with that wrap's acks, in order.
    expect(vi.mocked(enqueueRelayRetries).mock.calls.map(([, e, acks]) => [e.id, acks])).toEqual(
      wraps.map((w) => [w.id, retrying(w.id)]),
    );
  });

  it("rotate: declaration first, then all grants in ONE batch; order, accepted and retries per grant", async () => {
    const { env, stub } = makeStubEnv();
    const caller = makeKeypair();
    const audId = makeKeypair();
    const members = Array.from({ length: 12 }, () => makeKeypair().pub);
    const declaration = signEventWithRawKey(
      buildAudienceDeclaration({ audIdPub: audId.pub, slug: "rot-par", name: "rot-par", epoch: 2, epochPub: makeKeypair().pub, members }),
      audId.priv,
    );
    const grants = members.map((m) =>
      signEventWithRawKey(
        buildKeyGrant({ audIdPub: audId.pub, slug: "rot-par", epoch: 2, recipientPub: m, ciphertext: fakeNip44V2Ciphertext() }),
        audId.priv,
      ),
    );
    const order: string[] = [];
    vi.mocked(fanOut).mockImplementation(async (e) => {
      order.push(`single:${e.id}`);
      return acceptedAcks(e.id);
    });
    // Grant 3 is rejected everywhere; odd grants lose one relay to a timeout.
    vi.mocked(fanOutBatch).mockImplementation(async (events) => {
      order.push("batch");
      return events.map((e, i): RelayResult[] =>
        i === 3
          ? [{ relay: "wss://stub", status: "failed-permanent", accepted: false, message: "blocked" }]
          : i % 2 === 1
            ? [{ relay: "wss://stub", status: "rate-limited-retrying", accepted: false }, acceptedAcks(e.id)[1]!]
            : acceptedAcks(e.id),
      );
    });

    const url = "https://api.4a4.ai/v0/audience/raw/rotate";
    const res = await handleAudienceRawRequest(
      makeRequest(url, "POST", { audience_address: `30520:${audId.pub}:rot-par`, declaration, grants }, caller.priv),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      epoch: number;
      grants: { recipient: string; event_id: string; accepted: boolean; relay_acks: RelayResult[] }[];
    };
    expect(order).toEqual([`single:${declaration.id}`, "batch"]);
    expect(vi.mocked(fanOutBatch).mock.calls[0]![0].map((e) => e.id)).toEqual(grants.map((g) => g.id));
    expect(body.epoch).toBe(2);
    expect(body.grants.map((g) => g.event_id)).toEqual(grants.map((g) => g.id));
    expect(body.grants.map((g) => g.recipient)).toEqual(members);
    expect(body.grants.map((g) => g.accepted)).toEqual(grants.map((_, i) => i !== 3));
    // Every publish (declaration + 12 grants) goes through the retry hand-off.
    expect(vi.mocked(enqueueRelayRetries)).toHaveBeenCalledTimes(1 + grants.length);
    // Accepted grants are cached; the rejected one isn't.
    const cached = (g: SignedEvent) => stub.events.get(`${g.kind}:${g.pubkey}:${g.tags.find((t) => t[0] === "d")![1]}`)?.id === g.id;
    expect(grants.map(cached)).toEqual(grants.map((_, i) => i !== 3));
  });

  it("process-claims: keeps the declaration's pending order", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const audId = makeKeypair();
    const invites = [makeKeypair(), makeKeypair(), makeKeypair()];
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const declaration = signEventWithRawKey(
      buildAudienceDeclaration({
        audIdPub: audId.pub,
        slug: "pc",
        name: "pc",
        epoch: 1,
        epochPub: makeKeypair().pub,
        members: [founder.pub],
        pending: invites.map((i) => ({ invitePub: i.pub, expirationUnix: exp })),
      }),
      audId.priv,
    );
    await stub.storeAudienceEvent(declaration);
    // Claims for invites 0 and 2 (not 1); the first read is the slowest.
    const claims = [0, 2].map((n) => {
      const claimer = makeKeypair();
      const claim = signEventWithRawKey(
        buildAudienceClaim({ audIdPub: audId.pub, slug: "pc", epoch: 1, invitePub: invites[n]!.pub, inviterPub: founder.pub, claimPub: claimer.pub, expiration: exp }),
        invites[n]!.priv,
      );
      stub.events.set(`30522:${invites[n]!.pub}:pc:1:${invites[n]!.pub}`, claim);
      return { invite_pub: invites[n]!.pub, claim_pubkey: claimer.pub, claim_event_id: claim.id };
    });
    const getObject = stub.getObject.bind(stub);
    stub.getObject = async (kind, pubkey, d) => {
      if (kind === 30522 && pubkey === invites[0]!.pub) await sleep(30);
      return getObject(kind, pubkey, d);
    };

    const url = "https://api.4a4.ai/v0/audience/raw/process-claims";
    const res = await handleAudienceRawRequest(
      makeRequest(url, "POST", { audience_address: `30520:${audId.pub}:pc` }, founder.priv),
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { claimed: unknown[] }).claimed).toEqual(claims);
  });
});

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
