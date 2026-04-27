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
import { blake3 } from "@noble/hashes/blake3.js";

export const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://nostr.wine",
] as const;

const KINDS_4A = [30500, 30501, 30502, 30503, 30504] as const;
const SUBSCRIPTION_ID = "4a-pool";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const REPLAY_WINDOW_S = 15 * 60;
const REPLAY_TIMEOUT_MS = 5_000;

const EVENT_PREFIX = "event:";
const COMMONS_PREFIX = "event:30504:";
const RECONNECT_PREFIX = "reconnect:";

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

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
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

function expectedBlake3Tag(content: string): string {
  return "bk-" + base32Encode(blake3(new TextEncoder().encode(content)));
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
  // handler. Reopens any dropped subscriptions and replays the last
  // REPLAY_WINDOW_S seconds of events from each relay so anything that was
  // missed by a silently-dead live WS gets recovered.
  async sweepFromRelays(): Promise<{
    relaysQueried: number;
    eventsBackfilled: number;
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
    return { relaysQueried: RELAYS.length, eventsBackfilled: backfilled };
  }

  async alarm(): Promise<void> {
    await this.ensureConnected();
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
    if (!blake3Tag || blake3Tag !== expectedBlake3Tag(event.content)) return;
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
