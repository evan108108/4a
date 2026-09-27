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
  enqueueRelayRetries,
  fanOut,
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
// OK frame on the next tick; "silent" accepts the EVENT and never answers.
class FakeWebSocket {
  listeners: Record<string, Listener[]> = {};
  accepted = false;
  closed = false;
  constructor(private readonly behavior: "ok" | "silent" = "ok") {}
  accept() {
    this.accepted = true;
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    if (this.behavior !== "ok") return;
    const [, event] = JSON.parse(data) as [string, { id: string }];
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
function stubRelays(opts: { hung?: string[]; silent?: string[] } = {}) {
  const hung = new Set((opts.hung ?? [HUNG_RELAY]).map((r) => r.replace(/^wss:/, "https:")));
  const silent = new Set((opts.silent ?? []).map((r) => r.replace(/^wss:/, "https:")));
  const sockets: FakeWebSocket[] = [];
  const fetchMock = vi.fn((url: string) => {
    if (hung.has(url)) return new Promise<never>(() => {});
    const ws = new FakeWebSocket(silent.has(url) ? "silent" : "ok");
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
