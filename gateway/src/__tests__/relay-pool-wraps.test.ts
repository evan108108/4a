// RelayPool gift-wrap / hook-wrap listing — bounded, receive-time-ordered
// range reads (no full-prefix storage.list per call), legacy-key handling,
// and the paging cursor used by /inbox and the SSE stream.

import { describe, expect, it, vi } from "vitest";

// relay-pool.ts imports `cloudflare:workers`; stub the DO base so we can
// instantiate RelayPool directly (same pattern as artifacts-storage.test.ts).
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { signEventWithRawKey } from "../lib/sign";
import { RelayPool, type NostrEvent } from "../relay-pool";

interface ListOpts {
  prefix?: string;
  start?: string;
  startAfter?: string;
  end?: string;
  limit?: number;
}

// In-memory storage with Durable Object list() semantics: keys sorted
// lexicographically; `start` inclusive, `startAfter` exclusive, `end`
// exclusive; `limit` caps the result.
function makeStorage() {
  const map = new Map<string, unknown>();
  const listCalls: ListOpts[] = [];
  return {
    map,
    listCalls,
    async get(key: string) {
      return map.get(key);
    },
    async put(key: string, value: unknown) {
      map.set(key, value);
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
    async list<T>(opts: ListOpts = {}) {
      listCalls.push(opts);
      const keys = [...map.keys()].sort();
      const out = new Map<string, T>();
      for (const k of keys) {
        if (opts.prefix && !k.startsWith(opts.prefix)) continue;
        if (opts.start !== undefined && k < opts.start) continue;
        if (opts.startAfter !== undefined && k <= opts.startAfter) continue;
        if (opts.end !== undefined && k >= opts.end) continue;
        out.set(k, map.get(k) as T);
        if (opts.limit !== undefined && out.size >= opts.limit) break;
      }
      return out;
    },
  };
}

function makePool() {
  const storage = makeStorage();
  const pool = new RelayPool({ storage } as never, {} as never);
  return { pool, storage };
}

const RCPT = bytesToHex(schnorr.getPublicKey(randomBytes(32)));
const pad = (n: number) => String(n).padStart(12, "0");

function fakeWrap(id: string, createdAt: number): NostrEvent {
  return {
    id,
    pubkey: "e".repeat(64),
    created_at: createdAt,
    kind: 1059,
    tags: [["p", RCPT]],
    content: "x",
    sig: "f".repeat(128),
  };
}

// Seed a wrap exactly as storeGiftWrap would (current shape) or as the
// pre-7ab9d47 code did (legacy: key ts = created_at, no _receivedAt).
function seed(
  storage: ReturnType<typeof makeStorage>,
  prefix: "giftwrap:" | "hookwrap:",
  id: string,
  keyTs: number,
  opts: { legacy?: boolean; createdAt?: number } = {},
) {
  const ev = fakeWrap(id, opts.createdAt ?? keyTs - 86_400);
  const value = opts.legacy ? ev : { ...ev, _receivedAt: keyTs };
  storage.map.set(`${prefix}${RCPT}:${pad(keyTs)}:${id}`, value);
}

const id = (c: string) => c.repeat(64);

describe("RelayPool.listGiftWraps — bounded range read", () => {
  it("returns wraps received at or after `since`, in receive order, via one bounded list", async () => {
    const { pool, storage } = makePool();
    seed(storage, "giftwrap:", id("1"), 1_000);
    seed(storage, "giftwrap:", id("2"), 2_000);
    seed(storage, "giftwrap:", id("3"), 2_000);
    seed(storage, "giftwrap:", id("4"), 3_000);
    // another recipient's wrap must never leak in
    storage.map.set(`giftwrap:${"a".repeat(64)}:${pad(2_500)}:${id("9")}`, fakeWrap(id("9"), 1));

    const out = await pool.listGiftWraps(RCPT, 2_000, 100);
    expect(out.map((e) => e.id)).toEqual([id("2"), id("3"), id("4")]);
    // _receivedAt is internal and never returned
    expect(out.every((e) => !("_receivedAt" in e))).toBe(true);

    expect(storage.listCalls).toHaveLength(1);
    const call = storage.listCalls[0]!;
    expect(call.prefix).toBe(`giftwrap:${RCPT}:`);
    expect(call.start).toBe(`giftwrap:${RCPT}:${pad(2_000)}`);
    expect(call.limit).toBe(100);
  });

  it("respects limit and caps it at the page maximum", async () => {
    const { pool, storage } = makePool();
    for (let i = 0; i < 5; i++) seed(storage, "giftwrap:", String(i).repeat(64), 1_000 + i);
    expect(await pool.listGiftWraps(RCPT, undefined, 2)).toHaveLength(2);
    await pool.listGiftWraps(RCPT, undefined, 50_000);
    expect(storage.listCalls.at(-1)!.limit).toBe(1000);
  });

  it("legacy wraps (no _receivedAt; key ts = created_at) are ordered and filtered by the key ts", async () => {
    const { pool, storage } = makePool();
    seed(storage, "giftwrap:", id("a"), 1_500, { legacy: true, createdAt: 1_500 });
    seed(storage, "giftwrap:", id("b"), 2_500);
    // Before the fix a legacy wrap was returned for EVERY since value.
    expect((await pool.listGiftWraps(RCPT, 2_000)).map((e) => e.id)).toEqual([id("b")]);
    expect((await pool.listGiftWraps(RCPT, 1_000)).map((e) => e.id)).toEqual([id("a"), id("b")]);
    expect((await pool.listGiftWraps(RCPT)).map((e) => e.id)).toEqual([id("a"), id("b")]);
  });

  it("round-trips a real signed wrap through storeGiftWrap (keyed by receive time, not created_at)", async () => {
    const { pool, storage } = makePool();
    const now = Math.floor(Date.now() / 1000);
    const wrap = signEventWithRawKey(
      { kind: 1059, created_at: now - 2 * 86_400, tags: [["p", RCPT]], content: "sealed" },
      randomBytes(32),
    );
    expect((await pool.storeGiftWrap(wrap, RCPT)).ok).toBe(true);
    // A since just before "now" still finds it despite the 2-day backdate.
    const out = await pool.listGiftWraps(RCPT, now - 5);
    expect(out.map((e) => e.id)).toEqual([wrap.id]);
    const [key] = [...storage.map.keys()];
    expect(key!.startsWith(`giftwrap:${RCPT}:`)).toBe(true);
    expect(Number(key!.split(":")[2])).toBeGreaterThanOrEqual(now);
  });
});

describe("RelayPool.listHookWraps — bounded range read", () => {
  it("filters by receive time with a bounded list and ignores audience wraps", async () => {
    const { pool, storage } = makePool();
    const now = Math.floor(Date.now() / 1000);
    seed(storage, "hookwrap:", id("1"), now - 60);
    seed(storage, "hookwrap:", id("2"), now - 10);
    seed(storage, "giftwrap:", id("3"), now - 5);
    const out = await pool.listHookWraps(RCPT, now - 30);
    expect(out.map((e) => e.id)).toEqual([id("2")]);
    const readCall = storage.listCalls.find((c) => c.start !== undefined);
    expect(readCall?.prefix).toBe(`hookwrap:${RCPT}:`);
    expect(readCall?.start).toBe(`hookwrap:${RCPT}:${pad(now - 30)}`);
    expect(readCall?.limit).toBe(100);
  });
});
