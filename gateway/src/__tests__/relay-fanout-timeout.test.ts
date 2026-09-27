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
  RELAY_BATCH_OK_MAX_MS,
  RELAY_CONNECT_TIMEOUT_MS,
  RELAY_OK_TIMEOUT_MS,
  type RelayResult,
} from "../publish";
import { connectRelaySocket, RelayConnectTimeoutError } from "../lib/relay-connect";
import { deliverMemberWraps } from "../audience";
import { RELAYS, RelayPool } from "../relay-pool";
import type { SignedEvent } from "../kms";

const HUNG_RELAY = "wss://nos.lol";

type Listener = (ev: { data?: unknown }) => void;

// Minimal stand-in for a Workers WebSocket. "ok" answers every EVENT with an
// OK frame on the next tick; "silent" accepts the EVENT and never answers;
// "reverse" answers the whole burst on the next tick, last EVENT first, with
// the event id in the OK message. `skip` ids are never answered.
class FakeWebSocket {
  listeners: Record<string, Listener[]> = {};
  accepted = false;
  closed = false;
  sent: string[] = [];
  private burst: string[] = [];
  constructor(
    private readonly behavior: "ok" | "silent" | "reverse" = "ok",
    private readonly skip: ReadonlySet<string> = new Set(),
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
    if (this.behavior === "silent" || this.skip.has(event.id)) return;
    if (this.behavior === "reverse") {
      if (this.burst.push(event.id) === 1) {
        setTimeout(() => {
          for (const id of this.burst.reverse()) {
            this.emit("message", { data: JSON.stringify(["OK", id, true, `ok:${id.slice(-4)}`]) });
          }
        }, 0);
      }
      return;
    }
    setTimeout(() => this.emit("message", { data: JSON.stringify(["OK", event.id, true, ""]) }), 0);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, ev: { data?: unknown }) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

// fetch stub: the hung relay never answers the upgrade (and ignores abort,
// the worst case); every other relay upgrades immediately and ACKs.
function stubRelays(
  opts: { hung?: string[]; silent?: string[]; reverse?: string[]; skip?: { relay: string; ids: string[] } } = {},
) {
  const https = (r: string) => r.replace(/^wss:/, "https:");
  const hung = new Set((opts.hung ?? [HUNG_RELAY]).map(https));
  const silent = new Set((opts.silent ?? []).map(https));
  const reverse = new Set((opts.reverse ?? []).map(https));
  const sockets: FakeWebSocket[] = [];
  const fetchMock = vi.fn((url: string) => {
    if (hung.has(url)) return new Promise<never>(() => {});
    const skip = opts.skip && https(opts.skip.relay) === url ? new Set(opts.skip.ids) : undefined;
    const ws = new FakeWebSocket(silent.has(url) ? "silent" : reverse.has(url) ? "reverse" : "ok", skip);
    sockets.push(ws);
    return Promise.resolve({ webSocket: ws } as unknown as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, sockets };
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
  const stub = {
    async enqueueRetry(event: SignedEvent, relays: string[]) {
      if (opts.enqueueThrows) throw new Error("DO unavailable");
      enqueued.push({ id: event.id, relays });
    },
  };
  const env = {
    RELAY_POOL: {
      idFromName: () => "main",
      get: () => stub,
    },
  } as never;
  return { env, enqueued };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
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
    await vi.advanceTimersByTimeAsync(0);
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
    const results = await p;

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
    expect(batchOkWindowMs(40)).toBe(RELAY_OK_TIMEOUT_MS + 39 * 100);
    expect(batchOkWindowMs(10_000)).toBe(RELAY_BATCH_OK_MAX_MS);
  });

  it("an empty batch opens no sockets", async () => {
    const { fetchMock } = stubRelays({ hung: [] });
    expect(await fanOutBatch([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
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
    const results = await p;

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
    const [result] = await p;
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
