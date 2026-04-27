// RelayPool — Durable Object holding outbound WS subscriptions to Nostr relays.
//
// Verifies every incoming EVENT (id sha256, schnorr sig, BLAKE3 content tag)
// and stores valid 4A objects keyed by the addressable triple kind:pubkey:d.
// Newer events with the same triple replace older ones (NIP-01 addressable rule).
//
// Hibernation note: outbound WS connections cannot be fully hibernated by CF
// (the runtime keeps the DO active while a client-side WS is open). We still use
// the hibernation API surface (ctx.acceptWebSocket + webSocketMessage handlers)
// so the message-driven shape is correct and any future runtime improvements
// flow through automatically.

import { DurableObject } from "cloudflare:workers";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { blake3 } from "@noble/hashes/blake3.js";

const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://nostr.wine",
] as const;

const KINDS_4A = [30500, 30501, 30502, 30503, 30504] as const;
const SUBSCRIPTION_ID = "4a-pool";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

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

interface ConnectionAttachment {
  relay: string;
  connectedAt: number;
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

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed.length < 2) return;
    const [type, subId, payload] = parsed as [string, string, unknown];
    if (type !== "EVENT" || subId !== SUBSCRIPTION_ID) return;
    if (!isValidEvent(payload)) return;
    await this.handleEvent(payload);
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const att = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (att?.relay) await this.scheduleReconnect(att.relay);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const att = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (att?.relay) await this.scheduleReconnect(att.relay);
  }

  async alarm(): Promise<void> {
    await this.ensureConnected();
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

  private async ensureConnected(): Promise<void> {
    const live = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as ConnectionAttachment | null;
      if (att?.relay) live.add(att.relay);
    }
    for (const relay of RELAYS) {
      if (live.has(relay)) continue;
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
    this.ctx.acceptWebSocket(ws);
    ws.serializeAttachment({ relay, connectedAt: Date.now() } satisfies ConnectionAttachment);
    ws.send(JSON.stringify(["REQ", SUBSCRIPTION_ID, { kinds: [...KINDS_4A] }]));
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
