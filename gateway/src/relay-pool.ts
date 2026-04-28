// RelayPool — Durable Object holding outbound WS subscriptions to Nostr relays.
//
// For each configured relay, the DO opens a long-lived client WebSocket
// (fetch + Upgrade: websocket → ws.accept() → addEventListener) and subscribes
// to the 4A event kinds. CF keeps the DO instance in memory while any
// outbound WebSocket is open, so the connections.Map below is durable enough
// for normal operation.
//
// The hibernation API (ctx.acceptWebSocket) is intentionally NOT used here —
// it is for connections accepted FROM clients, not opened TO upstream relays.
//
// Verification on every incoming EVENT: id sha256, schnorr sig, BLAKE3
// content tag, addressable d-tag. Valid 4A events are stored keyed by the
// addressable triple kind:pubkey:d (NIP-01 parameterized-replaceable).
//
// Reliability backstop (sweepFromRelays): a one-shot replay over the last
// 15 minutes per relay, called every 5 minutes from a cron trigger in the
// worker. If a live subscription dies silently, the next sweep recovers any
// missed events.

import { DurableObject } from "cloudflare:workers";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { blake3ContentTag } from "./lib/blake3-tag";

// Default relay set (2026-04-27 hardening). nostr.wine dropped — paid relay,
// requires admission payment + restricted_writes:true (NIP-11 confirmed
// payment_required:true). Six free, write-friendly strfry relays selected
// from a probe of 8 candidates; all accepted a 5-event burst from a fresh
// pubkey at 100% on first attempt. Snort and nostr.band were timing out
// during the probe; nsec.app only supports NIPs 1/9/46 (bunker-only).
export const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://nostr.mom",
  "wss://relay.primal.net",
  "wss://offchain.pub",
  "wss://nostr.bitcoiner.social",
] as const;

const KINDS_4A = [30500, 30501, 30502, 30503, 30504] as const;
const SUBSCRIPTION_ID = "4a-pool";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const REPLAY_WINDOW_S = 15 * 60;
const REPLAY_TIMEOUT_MS = 5_000;

// Retry-with-backoff for rate-limited/transient publish failures.
// Base 5s, doubling, cap 5min, max 4 retries → ~5s, 10s, 20s, 40s elapsed
// (cumulative ~75s) before we give up. ±25% jitter to spread load when
// many events are queued at once.
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_JITTER = 0.25;
const RETRY_PUBLISH_TIMEOUT_MS = 5_000;

const EVENT_PREFIX = "event:";
const COMMONS_PREFIX = "event:30504:";
const RECONNECT_PREFIX = "reconnect:";
const RETRY_PREFIX = "retry:";

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface QueryFilter {
  about?: string;
  kind?: number;
  topic?: string;
  author?: string;
  limit?: number;
}

interface RetryRecord {
  event: NostrEvent;
  attempts: number;
  nextAttemptAt: number;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

function findTag(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1];
  return undefined;
}

function findTagValues(tags: string[][], name: string): string[] {
  const out: string[] = [];
  for (const t of tags) if (t[0] === name && typeof t[1] === "string") out.push(t[1]);
  return out;
}

function canonicalEventId(e: NostrEvent): string {
  const serialized = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  return toHex(sha256(new TextEncoder().encode(serialized)));
}

function isValidEvent(e: unknown): e is NostrEvent {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.pubkey === "string" &&
    typeof r.created_at === "number" &&
    typeof r.kind === "number" &&
    Array.isArray(r.tags) &&
    typeof r.content === "string" &&
    typeof r.sig === "string"
  );
}

function relayHttpUrl(wssUrl: string): string {
  return wssUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

// Exponential backoff with ±RETRY_JITTER multiplicative noise.
function jitteredBackoff(attempts: number): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
  const noise = 1 + (Math.random() * 2 - 1) * RETRY_JITTER;
  return Math.round(base * noise);
}

// Classify an OK-false rejection message. Per NIP-01 §4.B, prefixes like
// "rate-limited:", "auth-required:", "restricted:" indicate transient or
// auth-related errors that *might* succeed later. "duplicate:" is the relay
// telling us it already has the event — treat as accepted. Everything else
// (invalid:, pow:, blocked:, error: signature issues, etc.) is permanent.
export function classifyRejection(
  message: string,
): "accepted" | "rate-limited-retrying" | "failed-permanent" {
  const m = message.toLowerCase();
  if (m.startsWith("duplicate:")) return "accepted";
  if (
    m.startsWith("rate-limited:") ||
    m.startsWith("rate-limit:") ||
    m.startsWith("auth-required:") ||
    m.startsWith("restricted:") ||
    m.includes("rate limit") ||
    m.includes("try again")
  ) {
    return "rate-limited-retrying";
  }
  return "failed-permanent";
}

export class RelayPool extends DurableObject<unknown> {
  // Live outbound WebSockets keyed by relay URL. CF keeps the DO instance in
  // memory while any of these are open, so this Map survives between requests.
  private connections: Map<string, WebSocket> = new Map();

  async query(filter: QueryFilter): Promise<NostrEvent[]> {
    await this.ensureConnected();
    const limit = filter.limit ?? 100;
    const list = await this.ctx.storage.list<NostrEvent>({ prefix: EVENT_PREFIX });
    const results: NostrEvent[] = [];
    for (const event of list.values()) {
      if (filter.kind !== undefined && event.kind !== filter.kind) continue;
      if (filter.author && event.pubkey !== filter.author) continue;
      if (filter.topic && !findTagValues(event.tags, "t").includes(filter.topic)) continue;
      if (filter.about && !this.matchesAbout(event, filter.about)) continue;
      results.push(event);
      if (results.length >= limit) break;
    }
    return results;
  }

  async getObject(kind: number, pubkey: string, d: string): Promise<NostrEvent | null> {
    await this.ensureConnected();
    const key = `${EVENT_PREFIX}${kind}:${pubkey}:${d}`;
    const event = await this.ctx.storage.get<NostrEvent>(key);
    return event ?? null;
  }

  async listCommons(): Promise<NostrEvent[]> {
    await this.ensureConnected();
    const list = await this.ctx.storage.list<NostrEvent>({ prefix: COMMONS_PREFIX });
    return Array.from(list.values());
  }

  async stats(): Promise<{
    relays: readonly string[];
    eventCount: number;
    liveConnections: number;
  }> {
    await this.ensureConnected();
    const list = await this.ctx.storage.list({ prefix: EVENT_PREFIX });
    return {
      relays: RELAYS,
      eventCount: list.size,
      liveConnections: this.connections.size,
    };
  }

  // Backstop sweep — called every 5 minutes from the worker's scheduled()
  // handler. Reopens any dropped subscriptions, replays the last
  // REPLAY_WINDOW_S seconds of events from each relay so anything that was
  // missed by a silently-dead live WS gets recovered, and processes any
  // due retries in the publish-side retry queue.
  async sweepFromRelays(): Promise<{
    relaysQueried: number;
    eventsBackfilled: number;
    retriesProcessed: number;
  }> {
    await this.ensureConnected();
    const sinceUnix = Math.floor(Date.now() / 1000) - REPLAY_WINDOW_S;
    let backfilled = 0;
    for (const relay of RELAYS) {
      try {
        backfilled += await this.replayRelay(relay, sinceUnix);
      } catch {
        // per-relay failures must not block other relays
      }
    }
    const retriesProcessed = await this.processRetries();
    return {
      relaysQueried: RELAYS.length,
      eventsBackfilled: backfilled,
      retriesProcessed,
    };
  }

  // Enqueue rate-limited/transient publish failures for later retry. Called
  // from publish.ts after fan-out completes. Stores one record per (event,
  // relay) pair keyed by `retry:<eventId>:<relay>` so multiple events stack
  // independently. The next alarm fires at the soonest nextAttemptAt.
  async enqueueRetry(event: NostrEvent, relays: string[]): Promise<void> {
    if (relays.length === 0) return;
    if (!isValidEvent(event)) return;
    if (canonicalEventId(event) !== event.id) return;
    const now = Date.now();
    let earliest = Infinity;
    for (const relay of relays) {
      if (!RELAYS.includes(relay as (typeof RELAYS)[number])) continue;
      const key = `${RETRY_PREFIX}${event.id}:${relay}`;
      // Don't re-queue if an attempt is already pending for this pair.
      const existing = await this.ctx.storage.get<RetryRecord>(key);
      if (existing) continue;
      const nextAttemptAt = now + jitteredBackoff(0);
      await this.ctx.storage.put(key, { event, attempts: 0, nextAttemptAt });
      if (nextAttemptAt < earliest) earliest = nextAttemptAt;
    }
    if (earliest !== Infinity) {
      const current = await this.ctx.storage.getAlarm();
      if (current == null || current > earliest) {
        await this.ctx.storage.setAlarm(earliest);
      }
    }
  }

  async alarm(): Promise<void> {
    // Order matters: process retries first (uses fresh outbound sockets),
    // then make sure ingest subscriptions are healthy.
    await this.processRetries();
    await this.ensureConnected();
  }

  // Walk the retry queue, attempting any record whose nextAttemptAt has
  // arrived. Returns the count of records processed (regardless of outcome).
  // Surviving records (still scheduled in the future, or re-queued for next
  // attempt) reschedule the alarm to their soonest nextAttemptAt. Caps the
  // batch at 50 to keep a single alarm tick bounded.
  private async processRetries(): Promise<number> {
    const now = Date.now();
    const list = await this.ctx.storage.list<RetryRecord>({
      prefix: RETRY_PREFIX,
      limit: 50,
    });

    let processed = 0;
    let earliest = Infinity;

    for (const [key, record] of list.entries()) {
      if (record.nextAttemptAt > now) {
        if (record.nextAttemptAt < earliest) earliest = record.nextAttemptAt;
        continue;
      }
      const relay = key.slice(RETRY_PREFIX.length + record.event.id.length + 1);
      processed++;

      const outcome = await this.publishOnce(relay, record.event);
      if (outcome === "accepted" || outcome === "failed-permanent") {
        await this.ctx.storage.delete(key);
        continue;
      }
      // transient: bump attempt count and reschedule (or give up)
      const nextAttempts = record.attempts + 1;
      if (nextAttempts >= RETRY_MAX_ATTEMPTS) {
        await this.ctx.storage.delete(key);
        continue;
      }
      const nextAttemptAt = now + jitteredBackoff(nextAttempts);
      await this.ctx.storage.put(key, {
        event: record.event,
        attempts: nextAttempts,
        nextAttemptAt,
      });
      if (nextAttemptAt < earliest) earliest = nextAttemptAt;
    }

    if (earliest !== Infinity) {
      const current = await this.ctx.storage.getAlarm();
      if (current == null || current > earliest) {
        await this.ctx.storage.setAlarm(earliest);
      }
    }
    return processed;
  }

  // Fresh-socket single-event publish, used by the retry queue. Mirrors the
  // shape of publish.ts:publishToRelay but lives inside the DO so we don't
  // need to plumb a worker-side helper through. Returns one of three
  // outcomes; the caller decides whether to delete or reschedule.
  private async publishOnce(
    relay: string,
    event: NostrEvent,
  ): Promise<"accepted" | "rate-limited-retrying" | "failed-permanent"> {
    let ws: WebSocket | null = null;
    try {
      const response = await fetch(relayHttpUrl(relay), {
        headers: { Upgrade: "websocket" },
      });
      ws = response.webSocket;
      if (!ws) return "rate-limited-retrying";
      ws.accept();

      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            ws?.close();
          } catch {}
          resolve("rate-limited-retrying");
        }, RETRY_PUBLISH_TIMEOUT_MS);

        ws!.addEventListener("message", (ev: MessageEvent) => {
          try {
            const data = JSON.parse(typeof ev.data === "string" ? ev.data : "");
            if (Array.isArray(data) && data[0] === "OK" && data[1] === event.id) {
              clearTimeout(timer);
              const accepted = data[2] === true;
              const message = typeof data[3] === "string" ? data[3] : "";
              if (accepted) return resolve("accepted");
              return resolve(classifyRejection(message));
            }
          } catch {
            // ignore non-JSON / unrelated frames
          }
        });
        ws!.addEventListener("close", () => {
          clearTimeout(timer);
          resolve("rate-limited-retrying");
        });
        ws!.addEventListener("error", () => {
          clearTimeout(timer);
          resolve("rate-limited-retrying");
        });

        ws!.send(JSON.stringify(["EVENT", event]));
      });
    } catch {
      return "rate-limited-retrying";
    } finally {
      try {
        ws?.close();
      } catch {}
    }
  }

  private async ensureConnected(): Promise<void> {
    for (const relay of RELAYS) {
      if (this.connections.has(relay)) continue;
      try {
        await this.openRelay(relay);
        await this.ctx.storage.delete(`${RECONNECT_PREFIX}${relay}`);
      } catch {
        await this.scheduleReconnect(relay);
      }
    }
  }

  private async openRelay(relay: string): Promise<void> {
    const response = await fetch(relayHttpUrl(relay), {
      headers: { Upgrade: "websocket" },
    });
    const ws = response.webSocket;
    if (!ws) throw new Error(`relay ${relay} did not upgrade to WebSocket`);
    ws.accept();

    ws.addEventListener("message", (e: MessageEvent) => {
      this.handleRelayMessage(e.data).catch(() => {});
    });

    const handleEnd = () => {
      const current = this.connections.get(relay);
      if (current === ws) this.connections.delete(relay);
      this.scheduleReconnect(relay).catch(() => {});
    };
    ws.addEventListener("close", handleEnd);
    ws.addEventListener("error", handleEnd);

    this.connections.set(relay, ws);
    ws.send(JSON.stringify(["REQ", SUBSCRIPTION_ID, { kinds: [...KINDS_4A] }]));
  }

  private async handleRelayMessage(data: string | ArrayBuffer): Promise<void> {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed.length < 2) return;
    const [type, subId, payload] = parsed as [string, string, unknown];
    if (type !== "EVENT") return;
    if (subId !== SUBSCRIPTION_ID && !subId.startsWith("4a-replay-")) return;
    if (!isValidEvent(payload)) return;
    await this.handleEvent(payload);
  }

  private async handleEvent(event: NostrEvent): Promise<void> {
    if (!KINDS_4A.includes(event.kind as (typeof KINDS_4A)[number])) return;
    if (canonicalEventId(event) !== event.id) return;
    if (!schnorr.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey))) return;
    const blake3Tag = findTag(event.tags, "blake3");
    if (!blake3Tag || blake3Tag !== blake3ContentTag(event.content)) return;
    const dTag = findTag(event.tags, "d");
    if (!dTag) return;

    const key = `${EVENT_PREFIX}${event.kind}:${event.pubkey}:${dTag}`;
    const existing = await this.ctx.storage.get<NostrEvent>(key);
    if (existing && existing.created_at >= event.created_at) return;
    await this.ctx.storage.put(key, event);
  }

  private replayRelay(relay: string, sinceUnix: number): Promise<number> {
    return new Promise<number>((resolve) => {
      let count = 0;
      let settled = false;
      const subId = `4a-replay-${relay.replace(/[^a-z0-9]/gi, "")}-${Date.now().toString(36)}`;

      const finish = (n: number) => {
        if (settled) return;
        settled = true;
        resolve(n);
      };

      let ws: WebSocket | null = null;
      const timer = setTimeout(() => {
        try {
          ws?.close();
        } catch {}
        finish(count);
      }, REPLAY_TIMEOUT_MS);

      (async () => {
        try {
          const response = await fetch(relayHttpUrl(relay), {
            headers: { Upgrade: "websocket" },
          });
          ws = response.webSocket;
          if (!ws) {
            clearTimeout(timer);
            return finish(0);
          }
          ws.accept();

          ws.addEventListener("message", async (e: MessageEvent) => {
            const text =
              typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              return;
            }
            if (!Array.isArray(parsed) || parsed.length < 2) return;
            const [type, sid, payload] = parsed as [string, string, unknown];
            if (sid !== subId) return;
            if (type === "EOSE") {
              clearTimeout(timer);
              try {
                ws?.close();
              } catch {}
              finish(count);
              return;
            }
            if (type === "EVENT" && isValidEvent(payload)) {
              const before = await this.ctx.storage.get<NostrEvent>(
                `${EVENT_PREFIX}${payload.kind}:${payload.pubkey}:${findTag(payload.tags, "d") ?? ""}`,
              );
              await this.handleEvent(payload);
              const after = await this.ctx.storage.get<NostrEvent>(
                `${EVENT_PREFIX}${payload.kind}:${payload.pubkey}:${findTag(payload.tags, "d") ?? ""}`,
              );
              if (after && (!before || before.id !== after.id)) count++;
            }
          });

          ws.addEventListener("close", () => {
            clearTimeout(timer);
            finish(count);
          });
          ws.addEventListener("error", () => {
            clearTimeout(timer);
            finish(count);
          });

          ws.send(
            JSON.stringify(["REQ", subId, { kinds: [...KINDS_4A], since: sinceUnix }]),
          );
        } catch {
          clearTimeout(timer);
          finish(0);
        }
      })();
    });
  }

  private matchesAbout(event: NostrEvent, about: string): boolean {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.content);
    } catch {
      return false;
    }
    const fields = ["about", "observationAbout", "subject", "object", "memberOf"];
    for (const field of fields) {
      const v = payload[field];
      if (v && typeof v === "object" && (v as Record<string, unknown>)["@id"] === about) return true;
    }
    return false;
  }

  private async scheduleReconnect(relay: string): Promise<void> {
    const key = `${RECONNECT_PREFIX}${relay}`;
    const attempts = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1;
    await this.ctx.storage.put(key, attempts);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
    const next = Date.now() + delay;
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null || existing > next) await this.ctx.storage.setAlarm(next);
  }
}
