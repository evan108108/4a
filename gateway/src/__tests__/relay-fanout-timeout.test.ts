// Relay fan-out must be bounded per relay. Regression for the 2026-09-27
// custodial-audience stalls (61–79 s): nos.lol's nginx intermittently holds the
// WebSocket upgrade for 60 s, and the upgrade fetch had no timeout, so one
// relay held Promise.all in fanOut until it gave up. These tests stub fetch so
// a relay never answers the upgrade and check that every path returns within
// the connect bound, hands the relay to the retry queue, and (for the audience
// wrap path) caches wraps before and independently of the relay fan-out.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// relay-pool.ts imports `cloudflare:workers`; stub the DO base (same pattern
// as relay-pool-wraps.test.ts).
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

import {
  batchOkWindowMs,
  enqueueRelayRetries,
  fanOut,
  fanOutBatch,
  COOLDOWN_SKIP_MESSAGE,
  RELAY_BATCH_OK_MAX_MS,
  RELAY_BATCH_OK_PER_EVENT_MS,
  RELAY_CONNECT_TIMEOUT_MS,
  RELAY_EVENT_GAP_MS,
  RELAY_MAX_UNACKED,
  resetRelayCooldowns,
  RELAY_OK_TIMEOUT_MS,
  type RelayResult,
} from "../publish";
import { connectRelaySocket, RelayConnectTimeoutError } from "../lib/relay-connect";
import { deliverMemberWraps } from "../audience";
import { RELAY_COOLDOWN_MS, RELAYS, RelayPool } from "../relay-pool";
import { signEventWithRawKey } from "../lib/sign";
import type { SignedEvent } from "../kms";

const HUNG_RELAY = "wss://nos.lol";

type Listener = (ev: { data?: unknown }) => void;

// Minimal stand-in for a Workers WebSocket. "ok" answers every EVENT with an
// OK frame on the next tick; "silent" accepts the EVENT and never answers;
// "reverse" collects what arrives within REVERSE_DELAY_MS and answers it last
// EVENT first, with the event id in the OK message; "slow" answers each EVENT
// after SLOW_DELAY_MS. `skip` ids are never answered; after `throttleAfter`
// accepted events, every further EVENT gets damus's ban message. Records send
// times and the most EVENTs ever left unanswered at once.
const REVERSE_DELAY_MS = 120;
const SLOW_DELAY_MS = 1_000;
const DAMUS_BAN = "banned: too many rate-limit violations, try again later";
type FakeBehavior = "ok" | "silent" | "reverse" | "slow";
class FakeWebSocket {
  listeners: Record<string, Listener[]> = {};
  accepted = false;
  closed = false;
  sent: string[] = [];
  sentAt: number[] = [];
  unacked = 0;
  peakUnacked = 0;
  private burst: string[] = [];
  private okCount = 0;
  constructor(
    private readonly behavior: FakeBehavior = "ok",
    private readonly skip: ReadonlySet<string> = new Set(),
    private readonly throttleAfter = Infinity,
  ) {}
  accept() {
    this.accepted = true;
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    const [, event] = JSON.parse(data) as [string, { id: string }];
    this.sent.push(event.id);
    this.sentAt.push(Date.now());
    this.peakUnacked = Math.max(this.peakUnacked, ++this.unacked);
    if (this.behavior === "silent" || this.skip.has(event.id)) return;
    if (this.behavior === "reverse") {
      if (this.burst.push(event.id) === 1) {
        setTimeout(() => {
          for (const id of this.burst.splice(0).reverse()) this.ok(id, true, `ok:${id.slice(-4)}`);
        }, REVERSE_DELAY_MS);
      }
      return;
    }
    const throttled = this.okCount >= this.throttleAfter;
    if (!throttled) this.okCount++;
    setTimeout(
      () => this.ok(event.id, !throttled, throttled ? DAMUS_BAN : ""),
      this.behavior === "slow" ? SLOW_DELAY_MS : 0,
    );
  }
  close() {
    this.closed = true;
  }
  private ok(id: string, accepted: boolean, message: string) {
    this.unacked--;
    this.emit("message", { data: JSON.stringify(["OK", id, accepted, message]) });
  }
  emit(type: string, ev: { data?: unknown }) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

// fetch stub: the hung relay never answers the upgrade (and ignores abort,
// the worst case); every other relay upgrades immediately and ACKs.
function stubRelays(
  opts: {
    hung?: string[];
    silent?: string[];
    reverse?: string[];
    slow?: string[];
    skip?: { relay: string; ids: string[] };
    throttle?: { relay: string; after: number };
  } = {},
) {
  const https = (r: string) => r.replace(/^wss:/, "https:");
  const hung = new Set((opts.hung ?? [HUNG_RELAY]).map(https));
  const silent = new Set((opts.silent ?? []).map(https));
  const reverse = new Set((opts.reverse ?? []).map(https));
  const slow = new Set((opts.slow ?? []).map(https));
  const sockets: FakeWebSocket[] = [];
  const socketsByRelay = new Map<string, FakeWebSocket[]>();
  const fetchMock = vi.fn((url: string) => {
    if (hung.has(url)) return new Promise<never>(() => {});
    const skip = opts.skip && https(opts.skip.relay) === url ? new Set(opts.skip.ids) : undefined;
    const throttleAfter = opts.throttle && https(opts.throttle.relay) === url ? opts.throttle.after : Infinity;
    const behavior: FakeBehavior = silent.has(url) ? "silent" : reverse.has(url) ? "reverse" : slow.has(url) ? "slow" : "ok";
    const ws = new FakeWebSocket(behavior, skip, throttleAfter);
    const relay = url.replace(/^https:/, "wss:");
    socketsByRelay.set(relay, [...(socketsByRelay.get(relay) ?? []), ws]);
    sockets.push(ws);
    return Promise.resolve({ webSocket: ws } as unknown as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, sockets, socketsByRelay };
}

function makeEvent(id = "a".repeat(64)): SignedEvent {
  return {
    id,
    pubkey: "b".repeat(64),
    kind: 1059,
    created_at: 1_790_000_000,
    tags: [],
    content: "",
    sig: "c".repeat(128),
  } as SignedEvent;
}

function makeRelayPoolEnv(opts: { enqueueThrows?: boolean } = {}) {
  const enqueued: { id: string; relays: string[] }[] = [];
  const throttledCalls: { id: string; throttled: string[] }[] = [];
  const stub = {
    async enqueueRetry(event: SignedEvent, relays: string[], throttled: string[] = []) {
      if (opts.enqueueThrows) throw new Error("DO unavailable");
      enqueued.push({ id: event.id, relays });
      throttledCalls.push({ id: event.id, throttled });
    },
  };
  const env = {
    RELAY_POOL: {
      idFromName: () => "main",
      get: () => stub,
    },
  } as never;
  return { env, enqueued, throttledCalls };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  resetRelayCooldowns();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connectRelaySocket", () => {
  it("rejects with RelayConnectTimeoutError when the upgrade never answers", async () => {
    stubRelays({ hung: ["wss://hung.example"] });
    const p = connectRelaySocket("https://hung.example", 100);
    const assertion = expect(p).rejects.toBeInstanceOf(RelayConnectTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it("closes a socket that upgrades after the deadline instead of leaking it", async () => {
    const late = new FakeWebSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve({ webSocket: late } as unknown as Response), 5_000),
          ),
      ),
    );
    const p = connectRelaySocket("https://slow.example", 100);
    const assertion = expect(p).rejects.toBeInstanceOf(RelayConnectTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(late.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(late.closed).toBe(true);
  });

  it("passes an abort signal to fetch", async () => {
    const { fetchMock } = stubRelays({ hung: [] });
    await connectRelaySocket("https://relay.example", 100);
    const init = fetchMock.mock.calls[0]?.[1 as never] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("fanOut with a relay that hangs on the upgrade", () => {
  it("returns within the connect bound and still counts the other relays", async () => {
    stubRelays();
    const started = Date.now();
    let settled = false;
    const p = fanOut(makeEvent()).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(RELAY_CONNECT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const results = await p;

    expect(Date.now() - started).toBeLessThanOrEqual(RELAY_CONNECT_TIMEOUT_MS);
    expect(results).toHaveLength(RELAYS.length);
    const hung = results.find((r) => r.relay === HUNG_RELAY)!;
    expect(hung.status).toBe("rate-limited-retrying");
    expect(hung.accepted).toBe(false);
    expect(hung.message).toMatch(/timeout connecting to relay/);
    const others = results.filter((r) => r.relay !== HUNG_RELAY);
    expect(others.every((r) => r.status === "accepted")).toBe(true);
  });

  it("bounds a relay that upgrades but never sends OK by the OK timeout", async () => {
    stubRelays({ hung: [], silent: ["wss://relay.damus.io"] });
    const p = fanOut(makeEvent());
    await vi.advanceTimersByTimeAsync(RELAY_OK_TIMEOUT_MS);
    const results = await p;
    const silent = results.find((r) => r.relay === "wss://relay.damus.io")!;
    expect(silent.status).toBe("rate-limited-retrying");
    expect(silent.message).toBe("timeout waiting for OK");
  });
});

// A Workers invocation gets 6 simultaneous open connections and queues the
// rest with their connect timers already running, so a big batch must not
// open a socket per (event, relay).
describe("fanOutBatch (one socket per relay)", () => {
  const events = (n: number) => Array.from({ length: n }, (_, i) => makeEvent((i + 1).toString(16).padStart(64, "0")));

  it("sends 40 events over RELAYS.length sockets and maps out-of-order OKs to the right event", async () => {
    const { fetchMock, sockets } = stubRelays({ hung: [], reverse: [...RELAYS] });
    const batch = events(40);
    const p = fanOutBatch(batch);
    await vi.advanceTimersByTimeAsync(batchOkWindowMs(40));
    const results = await p;

    expect(fetchMock).toHaveBeenCalledTimes(RELAYS.length);
    expect(RELAYS.length).toBeLessThanOrEqual(6);
    for (const ws of sockets) {
      expect(ws.sent).toEqual(batch.map((e) => e.id));
      expect(ws.closed).toBe(true);
    }
    expect(results).toHaveLength(40);
    results.forEach((acks, i) => {
      expect(acks.map((a) => a.relay)).toEqual([...RELAYS]);
      for (const a of acks) {
        expect(a).toEqual({ relay: a.relay, status: "accepted", accepted: true, message: `ok:${batch[i]!.id.slice(-4)}` });
      }
    });
  });

  it("a relay that never OKs some events: only those events, on that relay, go to retry", async () => {
    const batch = events(10);
    const unanswered = batch.filter((_, i) => i % 3 === 0).map((e) => e.id);
    const { fetchMock } = stubRelays({ hung: [], skip: { relay: "wss://relay.damus.io", ids: unanswered } });
    const { env, enqueued } = makeRelayPoolEnv();
    const stub = { storeGiftWrap: async () => ({ ok: true }) as never };

    const p = deliverMemberWraps(
      batch.map((e) => ({ recipient: "e".repeat(64), wrapSigned: e })),
      stub as never,
      env,
    );
    await vi.advanceTimersByTimeAsync(batchOkWindowMs(batch.length));
    const { results } = await p;

    expect(fetchMock).toHaveBeenCalledTimes(RELAYS.length);
    results.forEach((r, i) => {
      const damus = r.acks.find((a) => a.relay === "wss://relay.damus.io")!;
      if (unanswered.includes(batch[i]!.id)) {
        expect(damus).toMatchObject({ status: "rate-limited-retrying", message: "timeout waiting for OK" });
      } else {
        expect(damus.status).toBe("accepted");
      }
      expect(r.acks.filter((a) => a.relay !== "wss://relay.damus.io").every((a) => a.accepted)).toBe(true);
    });
    expect(enqueued).toEqual(unanswered.map((id) => ({ id, relays: ["wss://relay.damus.io"] })));
  });

  it("a hung connect is still bounded at RELAY_CONNECT_TIMEOUT_MS for the whole batch", async () => {
    stubRelays();
    const started = Date.now();
    let settled = false;
    const p = fanOutBatch(events(40)).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(RELAY_CONNECT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const results = await p;

    expect(Date.now() - started).toBeLessThanOrEqual(RELAY_CONNECT_TIMEOUT_MS);
    for (const acks of results) {
      const hung = acks.find((a) => a.relay === HUNG_RELAY)!;
      expect(hung.status).toBe("rate-limited-retrying");
      expect(hung.message).toMatch(/timeout connecting to relay/);
      expect(acks.filter((a) => a.relay !== HUNG_RELAY).every((a) => a.accepted)).toBe(true);
    }
  });

  it("a relay that upgrades but stays silent is bounded by the batch OK window", async () => {
    stubRelays({ hung: [], silent: ["wss://nostr.mom"] });
    const batch = events(40);
    let settled = false;
    const p = fanOutBatch(batch).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(batchOkWindowMs(40) - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const results = await p;
    for (const acks of results) {
      expect(acks.find((a) => a.relay === "wss://nostr.mom")).toMatchObject({
        status: "rate-limited-retrying",
        message: "timeout waiting for OK",
      });
    }
  });

  it("batchOkWindowMs: one event keeps the single OK timeout; big batches cap out", () => {
    expect(batchOkWindowMs(1)).toBe(RELAY_OK_TIMEOUT_MS);
    expect(batchOkWindowMs(40)).toBe(RELAY_OK_TIMEOUT_MS + 39 * (RELAY_EVENT_GAP_MS + RELAY_BATCH_OK_PER_EVENT_MS));
    expect(batchOkWindowMs(10_000)).toBe(RELAY_BATCH_OK_MAX_MS);
  });

  it("an empty batch opens no sockets", async () => {
    const { fetchMock } = stubRelays({ hung: [] });
    expect(await fanOutBatch([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Pacing and cool-down (2026-09-27): relay.damus.io banned the gateway's
// egress ("banned: too many rate-limit violations") for a 20-event burst.
describe("fanOutBatch pacing and cool-down", () => {
  const events = (n: number) => Array.from({ length: n }, (_, i) => makeEvent((i + 1).toString(16).padStart(64, "0")));
  const DAMUS = "wss://relay.damus.io";

  it(`spaces EVENT frames at least RELAY_EVENT_GAP_MS (${RELAY_EVENT_GAP_MS} ms) apart on every socket`, async () => {
    // The design floor: damus banned the gateway for an unpaced burst.
    expect(RELAY_EVENT_GAP_MS).toBeGreaterThanOrEqual(50);
    const { sockets } = stubRelays({ hung: [] });
    const p = fanOutBatch(events(20));
    await vi.advanceTimersByTimeAsync(batchOkWindowMs(20));
    const results = await p;
    expect(results.every((acks) => acks.every((a) => a.accepted))).toBe(true);
    for (const ws of sockets) {
      expect(ws.sent).toHaveLength(20);
      const gaps = ws.sentAt.slice(1).map((t, i) => t - ws.sentAt[i]!);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(RELAY_EVENT_GAP_MS);
    }
  });

  it(`never leaves more than RELAY_MAX_UNACKED (${RELAY_MAX_UNACKED}) EVENTs unanswered on a slow relay`, async () => {
    const { socketsByRelay } = stubRelays({ hung: [], slow: [DAMUS] });
    const batch = events(12);
    const p = fanOutBatch(batch);
    await vi.advanceTimersByTimeAsync(batchOkWindowMs(12));
    const results = await p;
    const ws = socketsByRelay.get(DAMUS)![0]!;
    expect(ws.peakUnacked).toBe(RELAY_MAX_UNACKED);
    expect(ws.sent).toEqual(batch.map((e) => e.id));
    // Ack mapping is unchanged by pacing.
    results.forEach((acks) => expect(acks.find((a) => a.relay === DAMUS)!.status).toBe("accepted"));
  });

  it("stops sending to a relay that bans us mid-batch, cools it down, and tells the retry queue", async () => {
    const { socketsByRelay, fetchMock } = stubRelays({ hung: [], throttle: { relay: DAMUS, after: 3 } });
    const { env, enqueued, throttledCalls } = makeRelayPoolEnv();
    const batch = events(20);
    const stub = { storeGiftWrap: async () => ({ ok: true }) as never };
    const p = deliverMemberWraps(batch.map((e) => ({ recipient: "e".repeat(64), wrapSigned: e })), stub as never, env);
    await vi.advanceTimersByTimeAsync(batchOkWindowMs(20));
    const { results, timing } = await p;

    const ws = socketsByRelay.get(DAMUS)![0]!;
    // 3 accepted, then the ban: nothing is sent after the first ban reply.
    expect(ws.sent.length).toBeLessThan(batch.length);
    const damus = results.map((r) => r.acks.find((a) => a.relay === DAMUS)!);
    expect(damus.slice(0, 3).every((a) => a.accepted)).toBe(true);
    expect(damus.slice(3).every((a) => a.status === "rate-limited-retrying")).toBe(true);
    const unsent = damus.slice(ws.sent.length);
    expect(unsent.length).toBeGreaterThan(0);
    expect(unsent.every((a) => a.message === `not sent: relay rate-limited us (${DAMUS_BAN})`)).toBe(true);
    // Other relays are unaffected.
    expect(results.every((r) => r.acks.filter((a) => a.relay !== DAMUS).every((a) => a.accepted))).toBe(true);
    // Each unaccepted wrap is queued for damus only, flagged as throttled.
    expect(enqueued.map((e) => e.id)).toEqual(batch.slice(3).map((e) => e.id));
    expect(throttledCalls.every((c) => c.throttled.join() === DAMUS)).toBe(true);
    // The timing names the relay that stopped early.
    expect(timing.relays.find((r) => r.relay === DAMUS)).toMatchObject({ stopped: "throttled", accepted: 3, sent: ws.sent.length });
    expect(timing.wraps).toBe(20);

    // The next publish skips damus without opening a socket...
    fetchMock.mockClear();
    const next = fanOutBatch(events(2));
    await vi.advanceTimersByTimeAsync(batchOkWindowMs(2));
    const nextAcks = await next;
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain("https://relay.damus.io");
    expect(nextAcks[0]!.find((a) => a.relay === DAMUS)).toMatchObject({
      status: "rate-limited-retrying",
      message: COOLDOWN_SKIP_MESSAGE,
    });
    // ...and the skip itself does not extend the DO cool-down.
    const skipped = makeRelayPoolEnv();
    await enqueueRelayRetries(skipped.env, batch[0]!, nextAcks[0]!);
    expect(skipped.throttledCalls).toEqual([{ id: batch[0]!.id, throttled: [] }]);

    // ...until the cool-down ends.
    await vi.advanceTimersByTimeAsync(RELAY_COOLDOWN_MS);
    fetchMock.mockClear();
    const later = fanOutBatch(events(1));
    await vi.advanceTimersByTimeAsync(batchOkWindowMs(1));
    await later;
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain("https://relay.damus.io");
    // damus accepted that one (each fake socket accepts its first 3 events),
    // so the isolate reset its cool-down history: the next ban starts over at
    // RELAY_COOLDOWN_MS instead of escalating to twice that.
    const burst = fanOutBatch(events(4));
    await vi.advanceTimersByTimeAsync(batchOkWindowMs(4));
    expect((await burst)[3]!.find((a) => a.relay === DAMUS)!.message).toBe(DAMUS_BAN);
    await vi.advanceTimersByTimeAsync(RELAY_COOLDOWN_MS + 1);
    fetchMock.mockClear();
    const reset = fanOutBatch(events(1));
    await vi.advanceTimersByTimeAsync(batchOkWindowMs(1));
    await reset;
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain("https://relay.damus.io");
  });
});

// The DO retry queue under a cool-down. Uses an in-memory storage like
// relay-pool-wraps.test.ts, plus alarms.
describe("RelayPool retry queue cool-down", () => {
  const DAMUS = "wss://relay.damus.io";
  type Rec = { event: SignedEvent; attempts: number; nextAttemptAt: number };

  function makePool() {
    const map = new Map<string, unknown>();
    let alarm: number | null = null;
    const storage = {
      map,
      async get(key: string) {
        return map.get(key);
      },
      async put(key: string, value: unknown) {
        map.set(key, value);
      },
      async delete(key: string) {
        map.delete(key);
      },
      async list<T>(opts: { prefix?: string; limit?: number; startAfter?: string } = {}) {
        const out = new Map<string, T>();
        for (const k of [...map.keys()].sort()) {
          if (opts.prefix && !k.startsWith(opts.prefix)) continue;
          if (opts.startAfter !== undefined && k <= opts.startAfter) continue;
          out.set(k, map.get(k) as T);
          if (opts.limit !== undefined && out.size >= opts.limit) break;
        }
        return out;
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(at: number) {
        alarm = at;
      },
    };
    const pool = new RelayPool({ storage } as never, {} as never);
    const internals = pool as unknown as { processRetries: () => Promise<number> };
    return { pool, map, processRetries: () => internals.processRetries(), alarm: () => alarm };
  }

  function signed(n: number): SignedEvent {
    const priv = new Uint8Array(32).fill(n + 1);
    return signEventWithRawKey({ kind: 1059, created_at: 1_790_000_000, tags: [["p", "e".repeat(64)]], content: `x${n}` }, priv);
  }

  it("enqueueRetry: a throttled relay starts a cool-down and its record waits it out; others keep the normal backoff", async () => {
    const { pool, map } = makePool();
    const now = Date.now();
    const e = signed(1);
    await pool.enqueueRetry(e, [DAMUS, HUNG_RELAY], [DAMUS]);
    expect(map.get(`cooldown:${DAMUS}`)).toEqual({ level: 0, until: now + RELAY_COOLDOWN_MS });
    const damus = map.get(`retry:${e.id}:${DAMUS}`) as Rec;
    const nos = map.get(`retry:${e.id}:${HUNG_RELAY}`) as Rec;
    expect(damus.nextAttemptAt).toBeGreaterThanOrEqual(now + RELAY_COOLDOWN_MS);
    expect(nos.nextAttemptAt).toBeLessThan(now + 10_000);
    // A later non-throttled enqueue for the cooling relay also waits.
    const e2 = signed(2);
    await pool.enqueueRetry(e2, [DAMUS]);
    expect((map.get(`retry:${e2.id}:${DAMUS}`) as Rec).nextAttemptAt).toBeGreaterThanOrEqual(now + RELAY_COOLDOWN_MS);
  });

  it("processRetries: due records for a cooling relay are deferred without a publish or an attempt", async () => {
    const { map, processRetries } = makePool();
    const { fetchMock } = stubRelays({ hung: [] });
    const now = Date.now();
    map.set(`cooldown:${DAMUS}`, { level: 0, until: now + 60_000 });
    const e = signed(3);
    map.set(`retry:${e.id}:${DAMUS}`, { event: e, attempts: 1, nextAttemptAt: now });
    expect(await processRetries()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const rec = map.get(`retry:${e.id}:${DAMUS}`) as Rec;
    expect(rec.attempts).toBe(1);
    expect(rec.nextAttemptAt).toBeGreaterThanOrEqual(now + 60_000);
  });

  it("processRetries: a ban reply starts the cool-down and holds the relay's other due records in the same tick", async () => {
    const { map, processRetries, alarm } = makePool();
    const { fetchMock } = stubRelays({ hung: [], throttle: { relay: DAMUS, after: 0 } });
    const now = Date.now();
    const a = signed(4);
    const b = signed(5);
    map.set(`retry:${a.id}:${DAMUS}`, { event: a, attempts: 0, nextAttemptAt: now });
    map.set(`retry:${b.id}:${DAMUS}`, { event: b, attempts: 0, nextAttemptAt: now });
    const p = processRetries();
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(map.get(`cooldown:${DAMUS}`)).toEqual({ level: 0, until: now + RELAY_COOLDOWN_MS });
    const recs = [a, b].map((e) => map.get(`retry:${e.id}:${DAMUS}`) as Rec);
    expect(recs.map((r) => r.attempts).sort()).toEqual([0, 1]); // only the one that went out spent an attempt
    for (const r of recs) expect(r.nextAttemptAt).toBeGreaterThanOrEqual(now + RELAY_COOLDOWN_MS);
    expect(alarm()).toBeGreaterThanOrEqual(now + RELAY_COOLDOWN_MS);
  });

  it("escalates on repeated throttles (5, 10, 20, 40, then 60 min) and resets once the relay accepts", async () => {
    const { pool, map, processRetries } = makePool();
    const key = `cooldown:${DAMUS}`;
    const cd = () => map.get(key) as { until: number; level: number } | undefined;
    const MIN = 60_000;
    let n = 10;
    const throttle = () => pool.enqueueRetry(signed(n++), [DAMUS], [DAMUS]);

    const expected = [5, 10, 20, 40, 60, 60];
    for (const [level, minutes] of expected.entries()) {
      const now = Date.now();
      await throttle();
      expect(cd()).toEqual({ level, until: now + minutes * MIN });
      // More throttle replies during the same cool-down (one burst) don't escalate.
      await throttle();
      expect(cd()).toEqual({ level, until: now + minutes * MIN });
      await vi.advanceTimersByTimeAsync(minutes * MIN + 1);
    }

    // The ban lifts: a queued retry is accepted, and the history is dropped...
    stubRelays({ hung: [] });
    for (const k of [...map.keys()].filter((k) => k.startsWith("retry:"))) map.delete(k);
    const e = signed(99);
    map.set(`retry:${e.id}:${DAMUS}`, { event: e, attempts: 0, nextAttemptAt: Date.now() });
    const p = processRetries();
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe(1);
    expect(cd()).toBeUndefined();
    // ...so the next throttle starts over at 5 min.
    const now = Date.now();
    await throttle();
    expect(cd()).toEqual({ level: 0, until: now + 5 * MIN });
  });

  it("processRetries pages past not-yet-due records (60 future records no longer starve a due one)", async () => {
    const { map, processRetries } = makePool();
    const { fetchMock } = stubRelays({ hung: [] });
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      const id = i.toString(16).padStart(64, "0");
      map.set(`retry:${id}:${DAMUS}`, { event: makeEvent(id), attempts: 0, nextAttemptAt: now + 60_000 });
    }
    const due = signed(6);
    const key = `retry:${"f".repeat(64)}:${DAMUS}`;
    map.set(key, { event: { ...due, id: "f".repeat(64) }, attempts: 0, nextAttemptAt: now });
    const p = processRetries();
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("enqueueRelayRetries", () => {
  it("enqueues only the transiently failed relays", async () => {
    const { env, enqueued } = makeRelayPoolEnv();
    const results: RelayResult[] = [
      { relay: "wss://relay.damus.io", status: "accepted", accepted: true },
      { relay: HUNG_RELAY, status: "rate-limited-retrying", accepted: false, message: "timeout" },
      { relay: "wss://nostr.mom", status: "failed-permanent", accepted: false, message: "blocked" },
    ];
    await enqueueRelayRetries(env, makeEvent(), results);
    expect(enqueued).toEqual([{ id: "a".repeat(64), relays: [HUNG_RELAY] }]);
  });

  it("does nothing when every relay accepted", async () => {
    const { env, enqueued } = makeRelayPoolEnv();
    await enqueueRelayRetries(env, makeEvent(), [
      { relay: "wss://relay.damus.io", status: "accepted", accepted: true },
    ]);
    expect(enqueued).toEqual([]);
  });

  it("never throws when the retry queue is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = makeRelayPoolEnv({ enqueueThrows: true });
    await expect(
      enqueueRelayRetries(env, makeEvent(), [
        { relay: HUNG_RELAY, status: "rate-limited-retrying", accepted: false },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("deliverMemberWraps (custodial /v0/audience/publish)", () => {
  it("caches every wrap before the fan-out, runs members in parallel, and queues retries", async () => {
    stubRelays();
    const { env, enqueued } = makeRelayPoolEnv();
    const stored: string[] = [];
    const stub = {
      async storeGiftWrap(event: SignedEvent, recipient: string) {
        stored.push(`${recipient}:${event.id}`);
        return { ok: true } as never;
      },
    };
    const members = [
      { recipient: "e".repeat(64), wrapSigned: makeEvent("1".repeat(64)) },
      { recipient: "f".repeat(64), wrapSigned: makeEvent("2".repeat(64)) },
    ];

    const started = Date.now();
    const p = deliverMemberWraps(members, stub as never, env);

    // Both members' wraps are cached before any relay has answered.
    await vi.advanceTimersByTimeAsync(0);
    expect(stored).toEqual([`${"e".repeat(64)}:${"1".repeat(64)}`, `${"f".repeat(64)}:${"2".repeat(64)}`]);

    await vi.advanceTimersByTimeAsync(RELAY_CONNECT_TIMEOUT_MS);
    const { results } = await p;

    // Parallel: two members cost one connect bound, not two.
    expect(Date.now() - started).toBeLessThanOrEqual(RELAY_CONNECT_TIMEOUT_MS);
    expect(results.map((r) => r.recipient)).toEqual(members.map((m) => m.recipient));
    for (const r of results) {
      expect(r.acks.some((a) => a.status === "accepted")).toBe(true);
    }
    expect(enqueued).toEqual([
      { id: "1".repeat(64), relays: [HUNG_RELAY] },
      { id: "2".repeat(64), relays: [HUNG_RELAY] },
    ]);
  });

  it("still delivers when caching a wrap fails", async () => {
    stubRelays({ hung: [] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = makeRelayPoolEnv();
    const stub = {
      async storeGiftWrap() {
        throw new Error("storage down");
      },
    };
    const p = deliverMemberWraps(
      [{ recipient: "e".repeat(64), wrapSigned: makeEvent() }],
      stub as never,
      env,
    );
    await vi.advanceTimersByTimeAsync(10);
    const {
      results: [result],
    } = await p;
    expect(result!.acks.every((a) => a.status === "accepted")).toBe(true);
  });
});

describe("RelayPool DO retry publish", () => {
  it("publishOnce returns rate-limited-retrying within the connect bound on a hung relay", async () => {
    stubRelays();
    const pool = new RelayPool({ storage: {} } as never, {} as never);
    const publishOnce = (
      pool as unknown as {
        publishOnce: (relay: string, event: SignedEvent) => Promise<string>;
      }
    ).publishOnce.bind(pool);

    const started = Date.now();
    const p = publishOnce(HUNG_RELAY, makeEvent());
    await vi.advanceTimersByTimeAsync(RELAY_CONNECT_TIMEOUT_MS);
    await expect(p).resolves.toBe("rate-limited-retrying");
    expect(Date.now() - started).toBeLessThanOrEqual(RELAY_CONNECT_TIMEOUT_MS);
  });
});
