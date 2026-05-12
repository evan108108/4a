// Unit tests for GET /v0/audience/by-invite-pub/<invite_pub>.
//
// The route reads from a `pinv:<invite_pub>` reverse index that
// RelayPool.storeAudienceEvent maintains for every kind:30520 publish. These
// tests construct that index by hand inside a stub DO so they don't need a
// live Workers runtime.

import { describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

import { buildAudienceDeclaration } from "../lib/audience-events";
import { signEventWithRawKey } from "../lib/sign";
import type { SignedEvent } from "../kms";
import type { NostrEvent } from "../relay-pool";

vi.mock("../publish", () => ({
  fanOut: vi.fn(async () => []),
  rateLimitCheck: vi.fn(() => ({ ok: true as const })),
}));

import { handleAudienceByInvitePubRequest, type AudienceByInvitePubEnv } from "../audience-by-invite-pub";

interface IndexEntry {
  audIdPub: string;
  slug: string;
  status: "active" | "removed";
}

interface StubDO {
  events: Map<string, NostrEvent>;
  index: Map<string, IndexEntry>;
  getDeclarationByInvitePub(invitePub: string): Promise<
    | { status: "active"; event: NostrEvent; audIdPub: string; slug: string }
    | { status: "removed"; audIdPub: string; slug: string }
    | { status: "not_found" }
  >;
}

function makeStubEnv(): { env: AudienceByInvitePubEnv; stub: StubDO } {
  const stub: StubDO = {
    events: new Map(),
    index: new Map(),
    async getDeclarationByInvitePub(invitePub) {
      const key = invitePub.toLowerCase();
      const entry = stub.index.get(key);
      if (!entry) return { status: "not_found" };
      if (entry.status === "removed") {
        return { status: "removed", audIdPub: entry.audIdPub, slug: entry.slug };
      }
      const event = stub.events.get(`30520:${entry.audIdPub}:${entry.slug}`);
      if (!event) {
        return { status: "removed", audIdPub: entry.audIdPub, slug: entry.slug };
      }
      const stillPending = event.tags.some((t) => {
        if (t[0] !== "fa:pending") return false;
        const v = t[1] ?? "";
        const idx = v.indexOf(":");
        return idx >= 0 && v.slice(0, idx).toLowerCase() === key;
      });
      if (!stillPending) {
        return { status: "removed", audIdPub: entry.audIdPub, slug: entry.slug };
      }
      return { status: "active", event, audIdPub: entry.audIdPub, slug: entry.slug };
    },
  };
  const namespace = {
    idFromName: (_: string) => ({ name: "main" }),
    get: (_id: unknown) => stub,
  } as unknown as DurableObjectNamespace;
  const env = { RELAY_POOL: namespace } as unknown as AudienceByInvitePubEnv;
  return { env, stub };
}

function makeKeypair(): { priv: Uint8Array; pub: string } {
  const priv = randomBytes(32);
  const pub = bytesToHex(schnorr.getPublicKey(priv));
  return { priv, pub };
}

function buildDeclWithPending(
  slug: string,
  founderPub: string,
  pendingPubs: string[],
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
    pending: pendingPubs.map((p) => ({
      invitePub: p,
      expirationUnix: Math.floor(Date.now() / 1000) + 3600,
    })),
  });
  const declaration = signEventWithRawKey(declTpl, audId.priv);
  return { audId, declaration };
}

describe("handleAudienceByInvitePubRequest", () => {
  it("returns the declaration on hit", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const invite = makeKeypair();
    const slug = "studio-room";
    const built = buildDeclWithPending(slug, founder.pub, [invite.pub]);
    stub.events.set(`30520:${built.audId.pub}:${slug}`, built.declaration);
    stub.index.set(invite.pub.toLowerCase(), {
      audIdPub: built.audId.pub,
      slug,
      status: "active",
    });

    const url = `https://api.4a4.ai/v0/audience/by-invite-pub/${invite.pub}`;
    const req = new Request(url, { method: "GET" });
    const res = await handleAudienceByInvitePubRequest(req, invite.pub, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      audience_address: string;
      aud_id_pub: string;
      slug: string;
      declaration: NostrEvent;
    };
    expect(body.ok).toBe(true);
    expect(body.aud_id_pub).toBe(built.audId.pub);
    expect(body.slug).toBe(slug);
    expect(body.declaration.id).toBe(built.declaration.id);
    expect(body.audience_address).toBe(`30520:${built.audId.pub}:${slug}`);
  });

  it("returns 404 when invite_pub has never been seen", async () => {
    const { env } = makeStubEnv();
    const stranger = makeKeypair();
    const url = `https://api.4a4.ai/v0/audience/by-invite-pub/${stranger.pub}`;
    const req = new Request(url, { method: "GET" });
    const res = await handleAudienceByInvitePubRequest(req, stranger.pub, env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns 410 when invite_pub was once pending but was removed", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const invite = makeKeypair();
    const slug = "rotated-room";
    const built = buildDeclWithPending(slug, founder.pub, []);
    stub.events.set(`30520:${built.audId.pub}:${slug}`, built.declaration);
    stub.index.set(invite.pub.toLowerCase(), {
      audIdPub: built.audId.pub,
      slug,
      status: "removed",
    });

    const url = `https://api.4a4.ai/v0/audience/by-invite-pub/${invite.pub}`;
    const req = new Request(url, { method: "GET" });
    const res = await handleAudienceByInvitePubRequest(req, invite.pub, env);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; aud_id_pub: string; slug: string };
    expect(body.error).toBe("invite_gone");
    expect(body.aud_id_pub).toBe(built.audId.pub);
    expect(body.slug).toBe(slug);
  });

  it("returns 410 when index says active but declaration no longer pending", async () => {
    // Simulates a slightly stale index — the declaration has been re-published
    // (e.g. another rotate dropped this invite_pub) but the cleanup in
    // updatePendingInviteIndex hasn't yet flipped status. The defensive
    // re-confirm in getDeclarationByInvitePub should downgrade to "removed".
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const invite = makeKeypair();
    const slug = "stale-index-room";
    // Declaration carries no pending entries.
    const built = buildDeclWithPending(slug, founder.pub, []);
    stub.events.set(`30520:${built.audId.pub}:${slug}`, built.declaration);
    // Index still says "active".
    stub.index.set(invite.pub.toLowerCase(), {
      audIdPub: built.audId.pub,
      slug,
      status: "active",
    });

    const url = `https://api.4a4.ai/v0/audience/by-invite-pub/${invite.pub}`;
    const req = new Request(url, { method: "GET" });
    const res = await handleAudienceByInvitePubRequest(req, invite.pub, env);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invite_gone");
  });

  it("returns 400 on malformed invite_pub", async () => {
    const { env } = makeStubEnv();
    const url = `https://api.4a4.ai/v0/audience/by-invite-pub/notahex`;
    const req = new Request(url, { method: "GET" });
    const res = await handleAudienceByInvitePubRequest(req, "notahex", env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("returns 405 on non-GET methods", async () => {
    const { env } = makeStubEnv();
    const invite = makeKeypair();
    const url = `https://api.4a4.ai/v0/audience/by-invite-pub/${invite.pub}`;
    const req = new Request(url, { method: "POST" });
    const res = await handleAudienceByInvitePubRequest(req, invite.pub, env);
    expect(res.status).toBe(405);
  });
});
