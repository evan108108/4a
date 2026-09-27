// GET /v0/audience/:slug/inbox — receive-time cursor contract.
//
// Drives the real §2.5 pipeline (NIP-17 unwrap → kind:30521 grant lookup →
// NIP-44 decrypt) with a stubbed relay-pool DO and a stubbed KMS derivation,
// and checks the additive paging fields: per-item received_at, next_since
// (inclusive), next_cursor (exclusive, via ?cursor=) and has_more.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.mock("../publish", () => ({
  fanOut: vi.fn(async () => []),
  rateLimitCheck: vi.fn(() => ({ ok: true as const })),
}));

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

const CALLER_PRIV = randomBytes(32);
const CALLER_PUB = bytesToHex(schnorr.getPublicKey(CALLER_PRIV));

// runInbox zero-fills the derived priv when it finishes, so hand out a copy.
vi.mock("../kms", async (orig) => ({
  ...(await orig<typeof import("../kms")>()),
  deriveNostrKey: vi.fn(async () => ({ secretKey: CALLER_PRIV.slice(), publicKey: CALLER_PUB })),
}));
vi.mock("../auth", async (orig) => ({
  ...(await orig<typeof import("../auth")>()),
  verifyJwt: vi.fn(async () => ({ provider: "google", oauth_id: "u1" })),
}));

import { __audienceRoutes, handleAudienceRequest, type AudienceEnv } from "../audience";
import { buildEncryptedVariant, buildKeyGrant } from "../lib/audience-events";
import { encrypt as nip44Encrypt, encryptString as nip44EncryptString } from "../lib/nip44";
import { wrap as giftWrap } from "../lib/nip17";
import { signEventWithRawKey } from "../lib/sign";
import type { NostrEvent, StoredWrap, WrapPage } from "../relay-pool";
import type { AuthClaims } from "../auth";

const kp = () => {
  const priv = randomBytes(32);
  return { priv, pub: bytesToHex(schnorr.getPublicKey(priv)) };
};

const SLUG = "room";
const AUD = kp();
const EPOCH = kp();
const PUBLISHER = kp();
const CLAIMS = { provider: "google", oauth_id: "u1" } as AuthClaims;

const cursorOf = (receivedAt: number, id: string) => `${String(receivedAt).padStart(12, "0")}:${id}`;

function makeWorld() {
  // Founding-style grant: aud_id → caller, carrying the epoch priv.
  const grant = signEventWithRawKey(
    buildKeyGrant({
      audIdPub: AUD.pub,
      slug: SLUG,
      epoch: 1,
      recipientPub: CALLER_PUB,
      ciphertext: nip44Encrypt(EPOCH.priv, AUD.priv, CALLER_PUB),
    }),
    AUD.priv,
  );
  const wraps: StoredWrap[] = [];
  const stub = {
    async getObject(kind: number, pubkey: string, d: string): Promise<NostrEvent | null> {
      if (kind === 30521 && pubkey === AUD.pub && d === `${SLUG}:1:${CALLER_PUB}`) return grant;
      return null;
    },
    async listGiftWrapPage(
      _recipient: string,
      opts: { sinceUnix?: number; afterCursor?: string; limit?: number } = {},
    ): Promise<WrapPage> {
      const limit = opts.limit ?? 100;
      const sorted = [...wraps].sort((a, b) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0));
      const filtered = sorted.filter((w) =>
        opts.afterCursor !== undefined
          ? w.cursor > opts.afterCursor
          : opts.sinceUnix === undefined || w.receivedAt >= opts.sinceUnix,
      );
      const entries = filtered.slice(0, limit);
      return { entries, exhausted: entries.length < limit };
    },
  };
  const env = {
    RELAY_POOL: { idFromName: () => "main", get: () => stub },
  } as unknown as AudienceEnv;

  // Publish one message to the caller, received at `receivedAt`.
  function deliver(receivedAt: number, opts: { slug?: string; n?: number } = {}): string {
    const slug = opts.slug ?? SLUG;
    const rumor = signEventWithRawKey(
      buildEncryptedVariant({
        kind: 30510,
        audIdPub: AUD.pub,
        slug,
        epoch: 1,
        members: [PUBLISHER.pub, CALLER_PUB],
        dTag: `msg-${opts.n ?? receivedAt}`,
        alt: "test message",
        ciphertext: nip44EncryptString(JSON.stringify({ n: opts.n ?? 0 }), PUBLISHER.priv, EPOCH.pub),
      }),
      PUBLISHER.priv,
    );
    const w = giftWrap(rumor as NostrEvent, PUBLISHER.priv, CALLER_PUB);
    wraps.push({ event: w, receivedAt, cursor: cursorOf(receivedAt, w.id) });
    return rumor.id;
  }
  return { env, deliver, wraps };
}

interface InboxBody {
  items: { event_id: string; received_at: number; payload: { n: number } }[];
  next_since: number | null;
  next_cursor: string | null;
  has_more: boolean;
  since: number | null;
}

async function inbox(env: AudienceEnv, opts: { since?: number; cursor?: string; limit?: number } = {}) {
  const res = await __audienceRoutes.runInbox(SLUG, opts.since, opts.cursor, opts.limit ?? 50, CLAIMS, env);
  expect(res.status).toBe(200);
  return (await res.json()) as InboxBody;
}

describe("audience inbox — receive-time cursor", () => {
  let world: ReturnType<typeof makeWorld>;
  beforeEach(() => {
    world = makeWorld();
  });

  it("returns received_at per item, next_since / next_cursor at the last wrap examined, has_more=false when drained", async () => {
    world.deliver(1_000, { n: 1 });
    world.deliver(1_010, { n: 2 });
    const body = await inbox(world.env);
    expect(body.items.map((i) => i.payload.n)).toEqual([1, 2]);
    expect(body.items.map((i) => i.received_at)).toEqual([1_000, 1_010]);
    expect(body.next_since).toBe(1_010);
    expect(body.next_cursor).toBe(world.wraps[1]!.cursor);
    expect(body.has_more).toBe(false);
  });

  it("?cursor pages exactly: no duplicates, no skips, even when every wrap shares one second", async () => {
    for (let n = 1; n <= 5; n++) world.deliver(2_000, { n }); // same receive second
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const body = await inbox(world.env, { cursor, limit: 2 });
      seen.push(...body.items.map((i) => i.payload.n));
      pages++;
      if (!body.has_more) break;
      cursor = body.next_cursor!;
      expect(pages).toBeLessThan(10);
    }
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toBe(3);
  });

  it("?since=next_since is inclusive (re-returns the boundary wrap; clients dedupe by event_id)", async () => {
    world.deliver(3_000, { n: 1 });
    world.deliver(3_005, { n: 2 });
    world.deliver(3_009, { n: 3 });
    const first = await inbox(world.env, { limit: 2 });
    expect(first.items.map((i) => i.payload.n)).toEqual([1, 2]);
    expect(first.next_since).toBe(3_005);
    expect(first.has_more).toBe(true);
    const second = await inbox(world.env, { since: first.next_since!, limit: 2 });
    expect(second.items.map((i) => i.payload.n)).toEqual([2, 3]);
  });

  it("wraps for other audiences are consumed (the cursor moves past them)", async () => {
    world.deliver(4_000, { slug: "other-room", n: 9 });
    world.deliver(4_001, { slug: "other-room", n: 9 });
    const mine = world.deliver(4_002, { n: 1 });
    const body = await inbox(world.env, { limit: 1 });
    expect(body.items.map((i) => i.event_id)).toEqual([mine]);
    expect(body.next_cursor).toBe(world.wraps[2]!.cursor);
    expect(body.has_more).toBe(false);
  });

  it("stops at the limit*4 examine budget and reports has_more with a cursor past what was examined", async () => {
    for (let i = 0; i < 6; i++) world.deliver(5_000 + i, { slug: "other-room" });
    world.deliver(5_010, { n: 1 });
    const first = await inbox(world.env, { limit: 1 }); // budget = 4 wraps
    expect(first.items).toEqual([]);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBe(world.wraps[3]!.cursor);
    const second = await inbox(world.env, { cursor: first.next_cursor!, limit: 1 });
    expect(second.items.map((i) => i.payload.n)).toEqual([1]);
    expect(second.has_more).toBe(false);
  });

  it("empty inbox keeps the caller's cursor (next_since = since)", async () => {
    const body = await inbox(world.env, { since: 7_000 });
    expect(body.items).toEqual([]);
    expect(body.next_since).toBe(7_000);
    expect(body.next_cursor).toBeNull();
    expect(body.has_more).toBe(false);
  });

  it("the route rejects a malformed ?cursor with 400 and passes a valid one through", async () => {
    world.deliver(8_000, { n: 1 });
    const url = (q: string) => `https://api.4a4.ai/v0/audience/${SLUG}/inbox?${q}`;
    const bad = await handleAudienceRequest(
      new Request(url("cursor=not-a-cursor"), { headers: { Authorization: "Bearer x" } }),
      world.env,
    );
    expect(bad.status).toBe(400);
    const ok = await handleAudienceRequest(
      new Request(url(`cursor=${cursorOf(7_999, "0".repeat(64))}`), { headers: { Authorization: "Bearer x" } }),
      world.env,
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as InboxBody).items.map((i) => i.payload.n)).toEqual([1]);
  });
});
