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
import { WRAP_CURSOR } from "./lib/wrap-cursor";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { blake3ContentTag } from "./lib/blake3-tag";
import { connectRelaySocket } from "./lib/relay-connect";

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

// Kinds that the relay pool subscribes to from external relays. v0 public
// kinds + Phase 3 credibility events. v0.5 encrypted variants (30510-30514),
// declarations (30520), key-grants (30521), claims (30522) and gift-wraps
// (1059) are NOT in this list — they're per-recipient or per-audience and
// would fan out a vast amount of irrelevant traffic on the global subscription.
// Audience routes call `storeAudienceEvent` directly after a successful publish
// so the local cache stays consistent without joining the global firehose.
const KINDS_4A = [30500, 30501, 30502, 30503, 30504, 30506, 30507] as const;
const AUDIENCE_KINDS = [30510, 30511, 30512, 30513, 30514, 30520, 30521, 30522] as const;

// Gift-wraps (kind:1059) are recipient-addressable but carry no `d` tag, so
// they're stored under a separate prefix indexed by recipient pubkey.
const GIFT_WRAP_PREFIX = "giftwrap:";
// Upper bound on keys read by one wrap-page storage.list (covers the SSE
// replay max of 1000). Callers page with cursors beyond this.
const WRAP_PAGE_MAX = 1000;

/** A stored wrap plus its authoritative receive time and resume cursor. */
export interface StoredWrap {
  event: NostrEvent;
  /** Server-receive unix seconds (from the storage key). */
  receivedAt: number;
  /** Opaque, exclusive resume cursor: "<12-digit receivedAt>:<wrap id>". */
  cursor: string;
}

export interface WrapPage {
  entries: StoredWrap[];
  /** True when the scan reached the end of the recipient's wraps. */
  exhausted: boolean;
}

// Webhook-relay wraps live under their own prefix so hook retention can be
// swept without touching audience replay, and so the inbox stream can tail
// hook traffic without serving audience wraps the plugin would discard.
const HOOK_WRAP_PREFIX = "hookwrap:";
const HOOK_WRAP_RETENTION_SECONDS = 7 * 24 * 3600;
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
// How many due retry records one alarm tick attempts, and how many keys each
// storage.list page reads while looking for them.
const RETRY_BATCH = 50;
const RETRY_LIST_PAGE = 200;
// A relay that answers "rate-limited"/"banned" gets a cool-down: its queued
// retries wait it out without spending attempts, and each worker isolate
// skips it for new publishes (publish.ts). relay.damus.io bans the gateway's
// egress for minutes at a time after a burst; retrying at 5-40 s just
// re-offended and burned all 4 attempts. Repeat offences escalate
// (see nextCooldown): 5, 10, 20, 40, then 60 min.
export const RELAY_COOLDOWN_MS = 5 * 60 * 1000;
export const RELAY_COOLDOWN_MAX_MS = 60 * 60 * 1000;
const RELAY_COOLDOWN_MAX_LEVEL = 10;

export interface RelayCooldown {
  /** When the current cool-down ends (epoch ms). */
  until: number;
  /** 0 for the first cool-down; +1 per throttle after one has ended. */
  level: number;
}

export function cooldownDurationMs(level: number): number {
  return Math.min(RELAY_COOLDOWN_MAX_MS, RELAY_COOLDOWN_MS * 2 ** level);
}

// The cool-down after a throttle reply. A throttle while a cool-down is still
// running changes nothing (one burst yields many throttle replies, and other
// isolates may not know yet); the first throttle after it has ended escalates
// one level. An accept from the relay resets it (the caller drops the record).
export function nextCooldown(prev: RelayCooldown | undefined, now: number): RelayCooldown {
  if (prev && prev.until > now) return prev;
  const level = prev ? Math.min(prev.level + 1, RELAY_COOLDOWN_MAX_LEVEL) : 0;
  return { level, until: now + cooldownDurationMs(level) };
}
// Bound on every outbound WebSocket upgrade from this DO (retry publishes,
// ingest subscriptions, replay). A relay that holds the upgrade (nos.lol's
// nginx does, for 60 s) must not stall an alarm tick or the sequential
// reconnect loop. See lib/relay-connect.ts.
const RELAY_CONNECT_TIMEOUT_MS = 3_000;

const EVENT_PREFIX = "event:";
const COMMONS_PREFIX = "event:30504:";
// Public-artifact indexes (plan: public-artifacts-4a-api.md). Manifest events
// themselves reuse EVENT_PREFIX keying (`event:30540:<pubkey>:<d>`); these
// four prefixes hold the frozen-URL blob binding, the manifest-id → address
// reverse index, and the kind:5 revocation marks (per-event and per-address).
const ARTIFACT_BLOB_PREFIX = "artifactblob:";
const ARTIFACT_ID_PREFIX = "artifactid:";
const ARTIFACT_REV_PREFIX = "artifactrev:";
const ARTIFACT_REV_ADDR_PREFIX = "artifactrevaddr:";
const ARTIFACT_MANIFEST_KIND = 30540;
const REVOCATION_KIND = 5;
const RECONNECT_PREFIX = "reconnect:";
const RETRY_PREFIX = "retry:";
const COOLDOWN_PREFIX = "cooldown:";
// Reverse index: invite_pub → {audIdPub, slug, status}. Maintained by
// storeAudienceEvent for kind:30520 declarations so the public
// /v0/audience/by-invite-pub/<pub> route can resolve a declaration without
// scanning every cached audience.
const PENDING_INVITE_PREFIX = "pinv:";

interface PendingInviteIndexEntry {
  audIdPub: string;
  slug: string;
  status: "active" | "removed";
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// Value shape of `artifactblob:<sha256>` — the first-wins binding from a
// blob to the (publisher, slug) whose manifest froze it. `createdAt` is the
// binding manifest event's created_at, carried here because the manifest
// event itself is replaceable: after a supersede the frozen render path
// still needs the ORIGINAL manifest's timestamp for NIP-09 address-level
// revocation comparison.
export interface ArtifactBlobBinding {
  pubkey: string;
  d: string;
  eventId: string;
  createdAt: number;
  boundAtMs: number;
}

// Pre-resolved, pre-authorized targets of a kind:5 revocation. The endpoint
// resolves e/a tags and enforces ownership; the DO only writes indexes.
export interface ArtifactRevocationResolution {
  manifestIds: string[];
  addresses: { pubkey: string; d: string }[];
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

// Parse the set of invite pubkeys present in a kind:30520 declaration's
// `fa:pending` tags. Tag format per audience-validator.ts:
//   ["fa:pending", "<invite_pub_hex>:<expiration_unix>"]
function parsePendingInvitePubs(event: NostrEvent): Set<string> {
  const out = new Set<string>();
  for (const t of event.tags) {
    if (t[0] !== "fa:pending") continue;
    const v = t[1];
    if (typeof v !== "string") continue;
    const idx = v.indexOf(":");
    if (idx < 0) continue;
    const pub = v.slice(0, idx).toLowerCase();
    if (/^[0-9a-f]{64}$/.test(pub)) out.add(pub);
  }
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

// When a record deferred by a cool-down becomes due: just after it ends, with
// up to RETRY_BASE_MS of jitter so a relay's queued records don't all land on
// it in the same instant.
function afterCooldown(until: number): number {
  return until <= 0 ? 0 : until + Math.round(Math.random() * RETRY_BASE_MS);
}

// Exponential backoff with ±RETRY_JITTER multiplicative noise.
function jitteredBackoff(attempts: number): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
  const noise = 1 + (Math.random() * 2 - 1) * RETRY_JITTER;
  return Math.round(base * noise);
}

// A rejection that means "you're sending too much": the relay wants us to
// back off, not just retry this one event. Checked on messages already
// classified transient ("rate-limited-retrying").
const THROTTLE_PATTERN = /rate[- ]?limit|\bbanned\b|too many|slow down/i;

export function isRelayThrottle(message: string): boolean {
  return THROTTLE_PATTERN.test(message);
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

  /**
   * Store a v0.5 audience-related event (kind 30510-30514, 30520, 30521,
   * 30522) directly into local storage after a successful publish. Bypasses
   * the global subscription firehose so the gateway can cache its own
   * audience writes without joining a torrent of unrelated traffic.
   *
   * Verifies signature + canonical id but does not require a `blake3` tag —
   * encrypted variants (30510-30514) carry blake3-of-ciphertext, but
   * declarations / key-grants / claims do not (per SPEC-v0.5 §§1.1, 2.1, 5.2).
   */
  async storeAudienceEvent(event: NostrEvent): Promise<{ ok: boolean; reason?: string }> {
    if (!AUDIENCE_KINDS.includes(event.kind as (typeof AUDIENCE_KINDS)[number])) {
      return { ok: false, reason: `kind ${event.kind} not in v0.5 audience range` };
    }
    if (canonicalEventId(event) !== event.id) {
      return { ok: false, reason: "id mismatch" };
    }
    if (!schnorr.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey))) {
      return { ok: false, reason: "signature verification failed" };
    }
    const dTag = findTag(event.tags, "d");
    if (!dTag) return { ok: false, reason: "missing d tag" };
    // Encrypted variants MUST carry blake3 of ciphertext (SPEC-v0.5 §3.3).
    if (event.kind >= 30510 && event.kind <= 30514) {
      const blake3Tag = findTag(event.tags, "blake3");
      if (!blake3Tag || blake3Tag !== blake3ContentTag(event.content)) {
        return { ok: false, reason: "blake3 tag missing or mismatched" };
      }
    }
    const key = `${EVENT_PREFIX}${event.kind}:${event.pubkey}:${dTag}`;
    const existing = await this.ctx.storage.get<NostrEvent>(key);
    if (existing && existing.created_at >= event.created_at) {
      return { ok: true, reason: "superseded by existing newer event" };
    }
    await this.ctx.storage.put(key, event);
    if (event.kind === 30520) {
      await this.updatePendingInviteIndex(existing ?? null, event);
    }
    return { ok: true };
  }

  /**
   * Maintain the `pinv:<invite_pub>` reverse index for kind:30520
   * declarations. Pending invite_pubs in the new declaration are written as
   * `active`; pubs that disappeared from the previous declaration's pending
   * list (claim consumed or rotation removed them) are marked `removed` so
   * downstream readers can return 410 instead of 404.
   */
  private async updatePendingInviteIndex(
    previous: NostrEvent | null,
    next: NostrEvent,
  ): Promise<void> {
    const audIdPub = next.pubkey.toLowerCase();
    const slug = findTag(next.tags, "d") ?? "";
    const newPending = parsePendingInvitePubs(next);
    const oldPending = previous ? parsePendingInvitePubs(previous) : new Set<string>();
    for (const invitePub of newPending) {
      const entry: PendingInviteIndexEntry = {
        audIdPub,
        slug,
        status: "active",
      };
      await this.ctx.storage.put(`${PENDING_INVITE_PREFIX}${invitePub}`, entry);
    }
    for (const invitePub of oldPending) {
      if (newPending.has(invitePub)) continue;
      const entry: PendingInviteIndexEntry = {
        audIdPub,
        slug,
        status: "removed",
      };
      await this.ctx.storage.put(`${PENDING_INVITE_PREFIX}${invitePub}`, entry);
    }
  }

  /**
   * Look up a kind:30520 declaration by an invite pubkey that appeared in its
   * `fa:pending` list. Returns:
   *   - `{status: "active", event, audIdPub, slug}` — invite still pending; declaration cached.
   *   - `{status: "removed", audIdPub, slug}` — invite was once pending but has been claimed or rotated out (HTTP 410 territory).
   *   - `{status: "not_found"}` — no record of this invite_pub ever being pending (HTTP 404).
   *
   * Backed by the `pinv:` reverse index that storeAudienceEvent maintains; if
   * the index says the invite is active but the declaration has rotated past
   * it (i.e. caller observed an older copy via the index window), we
   * re-confirm against the live declaration and downgrade to `removed`.
   */
  async getDeclarationByInvitePub(invitePub: string): Promise<
    | { status: "active"; event: NostrEvent; audIdPub: string; slug: string }
    | { status: "removed"; audIdPub: string; slug: string }
    | { status: "not_found" }
  > {
    if (!/^[0-9a-f]{64}$/i.test(invitePub)) return { status: "not_found" };
    const key = `${PENDING_INVITE_PREFIX}${invitePub.toLowerCase()}`;
    const entry = await this.ctx.storage.get<PendingInviteIndexEntry>(key);
    if (!entry) return { status: "not_found" };
    if (entry.status === "removed") {
      return { status: "removed", audIdPub: entry.audIdPub, slug: entry.slug };
    }
    const eventKey = `${EVENT_PREFIX}30520:${entry.audIdPub}:${entry.slug}`;
    const event = await this.ctx.storage.get<NostrEvent>(eventKey);
    if (!event) {
      return { status: "removed", audIdPub: entry.audIdPub, slug: entry.slug };
    }
    const stillPending = parsePendingInvitePubs(event);
    if (!stillPending.has(invitePub.toLowerCase())) {
      return { status: "removed", audIdPub: entry.audIdPub, slug: entry.slug };
    }
    return { status: "active", event, audIdPub: entry.audIdPub, slug: entry.slug };
  }

  /**
   * Cache a kind:1059 gift-wrap addressed to the given recipient pubkey.
   * Indexed by `giftwrap:<recipient>:<12-digit server-receive second>:<id>` so
   * /audience/:slug/inbox and the SSE stream can range-scan a recipient's
   * wraps in receive order from a `since` cursor (see listWrapPage).
   *
   * The gateway's /audience/publish path calls this for every gift-wrap it
   * fans out, so a same-instance publisher → inbox reader pair (e.g. the
   * worked-example fixture) doesn't need an external relay subscription.
   * For cross-instance reads, the gateway would still need to subscribe to
   * external relays for kinds:[1059], #p:[user_pub] — tracked as a t15
   * follow-up.
   */
  async storeGiftWrap(event: NostrEvent, recipient: string): Promise<{ ok: boolean; reason?: string }> {
    if (event.kind !== 1059) return { ok: false, reason: "kind must be 1059" };
    if (canonicalEventId(event) !== event.id) {
      return { ok: false, reason: "id mismatch" };
    }
    if (!schnorr.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey))) {
      return { ok: false, reason: "signature verification failed" };
    }
    if (!/^[0-9a-f]{64}$/i.test(recipient)) {
      return { ok: false, reason: "recipient must be 32-byte hex" };
    }
    // Key by SERVER RECEIVE TIME, not the NIP-59-jittered `created_at`.
    // NIP-59 gift-wraps deliberately backdate `created_at` by up to ~2 days
    // for anti-correlation, so a wrap published at wallclock T can have
    // `created_at = T - 86400`. The SSE live-tail's `sinceUnix < created_at`
    // filter then drops every NIP-59-compliant wrap whose backdate exceeds
    // the polling window — which is most of them. Server-receive time
    // (Math.floor(Date.now()/1000)) reflects when this DO actually saw the
    // wrap and is the right axis for "give me wraps since cursor X".
    const receivedAtSec = Math.floor(Date.now() / 1000);
    const ts = String(receivedAtSec).padStart(12, "0");
    const key = `${GIFT_WRAP_PREFIX}${recipient.toLowerCase()}:${ts}:${event.id}`;
    // Persist receivedAt alongside the event for debugging; reads use the
    // key timestamp (see listWrapPage), which also covers legacy wraps.
    const stored = { ...event, _receivedAt: receivedAtSec } as NostrEvent & { _receivedAt: number };
    await this.ctx.storage.put(key, stored);
    console.log("[storeGiftWrap] stored", {
      recipient: recipient.toLowerCase().slice(0, 12),
      id: event.id.slice(0, 12),
      created_at: event.created_at,
      received_at: receivedAtSec,
      jitter_seconds: receivedAtSec - event.created_at,
    });
    return { ok: true };
  }

  /**
   * Bounded, receive-time-ordered page of wraps stored under `prefix`
   * (`giftwrap:<recipient>:` or `hookwrap:<recipient>:`).
   *
   * Keys are `<prefix><12-digit receive second>:<wrap id>`, so lexicographic
   * key order IS (receivedAt, id) order and a `since` filter is just a range
   * start — no full-prefix scan. The key's timestamp is authoritative:
   * legacy audience wraps stored before 7ab9d47 (May 2026) have the same key
   * shape but no `_receivedAt` field and carry the wrap's NIP-59 `created_at`
   * in the key; they are ordered and filtered by that key value. No data
   * migration is needed.
   *
   * `afterCursor` (`<12-digit ts>:<id>`, exclusive) takes precedence over
   * `sinceUnix` (inclusive, in seconds). `exhausted` is true when the scan
   * reached the end of the recipient's keys.
   */
  private async listWrapPage(
    prefix: string,
    opts: { sinceUnix?: number; afterCursor?: string; limit?: number },
  ): Promise<WrapPage> {
    const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 100), WRAP_PAGE_MAX));
    const listOpts: DurableObjectListOptions = { prefix, limit };
    if (opts.afterCursor !== undefined && WRAP_CURSOR.test(opts.afterCursor)) {
      listOpts.startAfter = prefix + opts.afterCursor;
    } else if (opts.sinceUnix !== undefined && Number.isFinite(opts.sinceUnix) && opts.sinceUnix > 0) {
      listOpts.start = prefix + String(Math.floor(opts.sinceUnix)).padStart(12, "0");
    }
    const list = await this.ctx.storage.list<NostrEvent & { _receivedAt?: number }>(listOpts);
    const entries: StoredWrap[] = [];
    for (const [key, ev] of list) {
      const cursor = key.slice(prefix.length);
      const { _receivedAt: _drop, ...clean } = ev;
      entries.push({ event: clean as NostrEvent, receivedAt: Number(cursor.slice(0, 12)), cursor });
    }
    return { entries, exhausted: list.size < limit };
  }

  /**
   * Page through cached gift-wraps addressed to `recipient` in receive order,
   * exposing each wrap's receive time and opaque resume cursor. Used by
   * /audience/:slug/inbox (next_since / next_cursor) and the SSE stream.
   */
  async listGiftWrapPage(
    recipient: string,
    opts: { sinceUnix?: number; afterCursor?: string; limit?: number } = {},
  ): Promise<WrapPage> {
    if (!/^[0-9a-f]{64}$/i.test(recipient)) return { entries: [], exhausted: true };
    return this.listWrapPage(`${GIFT_WRAP_PREFIX}${recipient.toLowerCase()}:`, opts);
  }

  /**
   * Fetch cached gift-wraps addressed to `recipient` with server-receive time
   * `>= sinceUnix`, oldest-received first, at most `limit` (≤ WRAP_PAGE_MAX).
   * One bounded storage.list range read (see listWrapPage).
   */
  async listGiftWraps(
    recipient: string,
    sinceUnix?: number,
    limit = 100,
  ): Promise<NostrEvent[]> {
    if (!/^[0-9a-f]{64}$/i.test(recipient)) return [];
    const page = await this.listWrapPage(`${GIFT_WRAP_PREFIX}${recipient.toLowerCase()}:`, {
      sinceUnix,
      limit,
    });
    return page.entries.map((e) => e.event);
  }

  /**
   * Delete hook wraps for `recipient` older than the retention window.
   * Keys embed the zero-padded server-receive second, so expired entries
   * are exactly the key range below the cutoff key — the range is anchored
   * under HOOK_WRAP_PREFIX:<recipient>: and can never touch audience
   * storage. Batch capped so a hook resuming after months of dormancy
   * can't stall a write with a pathological catch-up delete.
   *
   * Known v1 limit: a recipient that stops both writing and reading keeps
   * its in-flight wraps indefinitely. Acceptable at pilot volume; a cron
   * trigger is the escalation path if that ever matters.
   */
  private async pruneExpiredHookWraps(recipient: string): Promise<number> {
    const cutoffSec = Math.floor(Date.now() / 1000) - HOOK_WRAP_RETENTION_SECONDS;
    const rcpt = recipient.toLowerCase();
    const expired = await this.ctx.storage.list({
      prefix: `${HOOK_WRAP_PREFIX}${rcpt}:`,
      end: `${HOOK_WRAP_PREFIX}${rcpt}:${String(cutoffSec).padStart(12, "0")}`,
      limit: 50,
    });
    if (expired.size === 0) return 0;
    await this.ctx.storage.delete([...expired.keys()]);
    console.log("[pruneExpiredHookWraps]", { recipient: rcpt.slice(0, 12), deleted: expired.size });
    return expired.size;
  }

  /**
   * Store a webhook-relay gift-wrap under HOOK_WRAP_PREFIX. Same validation
   * as storeGiftWrap, distinct keyspace: hook retention and the inbox stream
   * must never touch audience wraps (and vice versa).
   */
  async storeHookWrap(event: NostrEvent, recipient: string): Promise<{ ok: boolean; reason?: string }> {
    if (event.kind !== 1059) return { ok: false, reason: "kind must be 1059" };
    if (canonicalEventId(event) !== event.id) {
      return { ok: false, reason: "id mismatch" };
    }
    if (!schnorr.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey))) {
      return { ok: false, reason: "signature verification failed" };
    }
    if (!/^[0-9a-f]{64}$/i.test(recipient)) {
      return { ok: false, reason: "recipient must be 32-byte hex" };
    }
    // Server-receive time, not the NIP-59-jittered created_at — same
    // reasoning as storeGiftWrap above.
    const receivedAtSec = Math.floor(Date.now() / 1000);
    const ts = String(receivedAtSec).padStart(12, "0");
    const key = `${HOOK_WRAP_PREFIX}${recipient.toLowerCase()}:${ts}:${event.id}`;
    const stored = { ...event, _receivedAt: receivedAtSec } as NostrEvent & { _receivedAt: number };
    await this.ctx.storage.put(key, stored);
    await this.pruneExpiredHookWraps(recipient);
    console.log("[storeHookWrap] stored", {
      recipient: recipient.toLowerCase().slice(0, 12),
      id: event.id.slice(0, 12),
      received_at: receivedAtSec,
    });
    return { ok: true };
  }

  /**
   * Fetch cached hook wraps addressed to `recipient`, oldest-first, filtered
   * by server-receive time (`sinceUnix` inclusive-exclusive semantics match
   * listGiftWraps; one bounded range read via listHookWrapPage). Reads only HOOK_WRAP_PREFIX — audience traffic never
   * appears here.
   */
  async listHookWraps(
    recipient: string,
    sinceUnix?: number,
    limit = 100,
  ): Promise<NostrEvent[]> {
    const page = await this.listHookWrapPage(recipient, { sinceUnix, limit });
    return page.entries.map((e) => e.event);
  }

  /**
   * Page through hook wraps for `recipient` in receive order, exposing each
   * wrap's receive time and resume cursor (the /v0/inbox SSE stream uses it).
   */
  async listHookWrapPage(
    recipient: string,
    opts: { sinceUnix?: number; afterCursor?: string; limit?: number } = {},
  ): Promise<WrapPage> {
    if (!/^[0-9a-f]{64}$/i.test(recipient)) return { entries: [], exhausted: true };
    // Read-path prune: an active subscriber self-cleans even when the
    // recipient isn't currently receiving writes.
    await this.pruneExpiredHookWraps(recipient);
    return this.listWrapPage(`${HOOK_WRAP_PREFIX}${recipient.toLowerCase()}:`, opts);
  }

  /**
   * Store a kind:30540 artifact manifest after endpoint-side validation.
   * Same sig/id/supersede discipline as storeAudienceEvent (30540 only —
   * blake3/uploader/schema checks live in the manifest validator), plus the
   * two artifact indexes:
   *
   *   - `artifactid:<event.id>` — full event snapshot, always written and
   *     kept across supersedes: the frozen-URL render path needs the
   *     ORIGINAL manifest's metadata (title, publisher, created_at) after
   *     the address key has been replaced by a newer version, and kind:5
   *     e-tag resolution/authorization needs old versions addressable by id.
   *     Grows unbounded (~1 KB per manifest ever published) — fine at pilot
   *     volume; the v2 orphan-blob-sweep cron is the seam for aging out
   *     superseded entries if it ever matters.
   *   - `artifactblob:<sha256>` — FIRST-WINS. Written when absent; refreshed
   *     (eventId/createdAt) when the existing binding has the same
   *     (pubkey, d); left untouched otherwise, reported as `bound: false`
   *     (the endpoint maps that to 409 blob_already_bound for the frozen-URL
   *     claim — the manifest itself still stores fine).
   */
  async storeArtifactManifest(
    event: NostrEvent,
  ): Promise<{ ok: boolean; superseded: boolean; bound: boolean; reason?: string }> {
    if (event.kind !== ARTIFACT_MANIFEST_KIND) {
      return { ok: false, superseded: false, bound: false, reason: `kind must be ${ARTIFACT_MANIFEST_KIND}` };
    }
    if (canonicalEventId(event) !== event.id) {
      return { ok: false, superseded: false, bound: false, reason: "id mismatch" };
    }
    if (!schnorr.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey))) {
      return { ok: false, superseded: false, bound: false, reason: "signature verification failed" };
    }
    const dTag = findTag(event.tags, "d");
    if (!dTag) return { ok: false, superseded: false, bound: false, reason: "missing d tag" };
    const blobSha = findTag(event.tags, "blob");
    if (!blobSha || !/^[0-9a-f]{64}$/i.test(blobSha)) {
      return { ok: false, superseded: false, bound: false, reason: "missing or malformed blob tag" };
    }

    const key = `${EVENT_PREFIX}${ARTIFACT_MANIFEST_KIND}:${event.pubkey}:${dTag}`;
    const existing = await this.ctx.storage.get<NostrEvent>(key);
    if (existing && existing.created_at >= event.created_at) {
      return { ok: true, superseded: true, bound: false, reason: "superseded by existing newer event" };
    }
    await this.ctx.storage.put(key, event);
    await this.ctx.storage.put(`${ARTIFACT_ID_PREFIX}${event.id}`, event);

    const blobKey = `${ARTIFACT_BLOB_PREFIX}${blobSha.toLowerCase()}`;
    const binding = await this.ctx.storage.get<ArtifactBlobBinding>(blobKey);
    let bound: boolean;
    if (!binding) {
      const fresh: ArtifactBlobBinding = {
        pubkey: event.pubkey,
        d: dTag,
        eventId: event.id,
        createdAt: event.created_at,
        boundAtMs: Date.now(),
      };
      await this.ctx.storage.put(blobKey, fresh);
      bound = true;
    } else if (binding.pubkey === event.pubkey && binding.d === dTag) {
      const refreshed: ArtifactBlobBinding = {
        ...binding,
        eventId: event.id,
        createdAt: event.created_at,
      };
      await this.ctx.storage.put(blobKey, refreshed);
      bound = true;
    } else {
      bound = false;
    }
    return { ok: true, superseded: false, bound };
  }

  /** Point read of the first-wins `artifactblob:<sha256>` binding. */
  async getArtifactBlobBinding(sha: string): Promise<ArtifactBlobBinding | null> {
    if (!/^[0-9a-f]{64}$/i.test(sha)) return null;
    const binding = await this.ctx.storage.get<ArtifactBlobBinding>(
      `${ARTIFACT_BLOB_PREFIX}${sha.toLowerCase()}`,
    );
    return binding ?? null;
  }

  /**
   * Point read of the `artifactid:<manifest-event-id>` snapshot — the
   * historical manifest event as published, surviving address supersedes.
   * Used by the frozen-URL render path (original metadata + created_at for
   * the revocation check) and by kind:5 e-tag authorization.
   */
  async getArtifactManifest(eventId: string): Promise<NostrEvent | null> {
    const event = await this.ctx.storage.get<NostrEvent>(`${ARTIFACT_ID_PREFIX}${eventId}`);
    return event ?? null;
  }

  /**
   * Store a kind:5 revocation against pre-resolved targets. The endpoint
   * resolves e/a tags and enforces you-can-only-revoke-your-own; this method
   * verifies the event itself and writes:
   *
   *   - `artifactrev:<manifest-event-id>` per resolved e-tag (unconditional —
   *     version-level revocation has no time semantics).
   *   - `artifactrevaddr:<pubkey>:<d>` per resolved a-tag, keeping the
   *     latest-created_at kind:5 per address (an older revocation never
   *     regresses a newer one).
   */
  async storeArtifactRevocation(
    event: NostrEvent,
    resolved: ArtifactRevocationResolution,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (event.kind !== REVOCATION_KIND) {
      return { ok: false, reason: `kind must be ${REVOCATION_KIND}` };
    }
    if (canonicalEventId(event) !== event.id) {
      return { ok: false, reason: "id mismatch" };
    }
    if (!schnorr.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey))) {
      return { ok: false, reason: "signature verification failed" };
    }
    for (const manifestId of resolved.manifestIds) {
      await this.ctx.storage.put(`${ARTIFACT_REV_PREFIX}${manifestId}`, event);
    }
    for (const addr of resolved.addresses) {
      const key = `${ARTIFACT_REV_ADDR_PREFIX}${addr.pubkey}:${addr.d}`;
      const existing = await this.ctx.storage.get<NostrEvent>(key);
      if (existing && existing.created_at >= event.created_at) continue;
      await this.ctx.storage.put(key, event);
    }
    return { ok: true };
  }

  /**
   * Render-path revocation check — both index lookups in one DO round-trip.
   * `manifestCreatedAt` is the created_at of the manifest actually being
   * rendered (from the event for d-tag renders, from the ArtifactBlobBinding
   * for frozen renders): NIP-09 address-level revocation suppresses exactly
   * the manifests with created_at <= the revocation's, so a slug republished
   * after the revocation un-revokes the d-tag URL while an older frozen
   * version of the same slug stays 410.
   */
  async getArtifactRevocation(
    manifestEventId: string,
    pubkey: string,
    d: string,
    manifestCreatedAt: number,
  ): Promise<{ revoked: boolean; by?: string; at?: number }> {
    const direct = await this.ctx.storage.get<NostrEvent>(
      `${ARTIFACT_REV_PREFIX}${manifestEventId}`,
    );
    if (direct) {
      return { revoked: true, by: direct.pubkey, at: direct.created_at };
    }
    const addrRev = await this.ctx.storage.get<NostrEvent>(
      `${ARTIFACT_REV_ADDR_PREFIX}${pubkey}:${d}`,
    );
    if (addrRev && manifestCreatedAt <= addrRev.created_at) {
      return { revoked: true, by: addrRev.pubkey, at: addrRev.created_at };
    }
    return { revoked: false };
  }

  /**
   * Fetch cached kind:30521 key-grants where the recipient (last segment of
   * the d-tag, `<slug>:<epoch>:<recipient>`) matches `recipient`. Optional
   * `sinceUnix` filters to grants with `created_at > sinceUnix`. Returns up
   * to `limit` events, oldest-first.
   *
   * Implementation: scans the `event:30521:*` keyspace and filters by
   * d-tag suffix. Acceptable at v0 scale; if the audience grant table grows
   * past O(thousands), revisit by adding a per-recipient secondary index
   * mirrored from storeAudienceEvent.
   */
  async listKeyGrants(
    recipient: string,
    sinceUnix?: number,
    limit = 100,
  ): Promise<NostrEvent[]> {
    if (!/^[0-9a-f]{64}$/i.test(recipient)) return [];
    const recipientLower = recipient.toLowerCase();
    const list = await this.ctx.storage.list<NostrEvent>({
      prefix: `${EVENT_PREFIX}30521:`,
    });
    const out: NostrEvent[] = [];
    let totalSeen = 0;
    let recipientMatches = 0;
    let oldestCreatedAt: number | null = null;
    let newestCreatedAt: number | null = null;
    for (const ev of list.values()) {
      totalSeen++;
      const dTag = findTag(ev.tags, "d");
      if (!dTag) continue;
      const idx = dTag.lastIndexOf(":");
      if (idx < 0) continue;
      if (dTag.slice(idx + 1).toLowerCase() !== recipientLower) continue;
      recipientMatches++;
      if (oldestCreatedAt === null || ev.created_at < oldestCreatedAt) oldestCreatedAt = ev.created_at;
      if (newestCreatedAt === null || ev.created_at > newestCreatedAt) newestCreatedAt = ev.created_at;
      // Strict `<` to include equal-timestamp boundary events. The previous
      // `<=` was silently dropping just-published grants whose `created_at`
      // matched the SSE live-tail cursor (Math.floor(Date.now()/1000)) —
      // and since the cursor advanced past that timestamp on the next
      // iteration, the grant was never visible. Caller dedupes via seenIds.
      if (sinceUnix !== undefined && ev.created_at < sinceUnix) continue;
      out.push(ev);
    }
    out.sort((a, b) => a.created_at - b.created_at);
    if (recipientMatches > 0 || (sinceUnix !== undefined && totalSeen > 0)) {
      console.log("[listKeyGrants]", {
        recipient: recipientLower.slice(0, 12),
        sinceUnix: sinceUnix ?? null,
        total_seen_30521: totalSeen,
        recipient_matches: recipientMatches,
        returned: out.length,
        oldest: oldestCreatedAt,
        newest: newestCreatedAt,
        diff_newest_minus_since: sinceUnix !== undefined && newestCreatedAt !== null
          ? newestCreatedAt - sinceUnix
          : null,
      });
    }
    return out.slice(0, limit);
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
  // `throttled` relays rate-limited or banned us: they start (or extend)
  // their cool-down, and every record for a cooling relay is scheduled for
  // after it.
  async enqueueRetry(event: NostrEvent, relays: string[], throttled: string[] = []): Promise<void> {
    if (relays.length === 0) return;
    if (!isValidEvent(event)) return;
    if (canonicalEventId(event) !== event.id) return;
    const now = Date.now();
    let earliest = Infinity;
    for (const relay of relays) {
      if (!RELAYS.includes(relay as (typeof RELAYS)[number])) continue;
      const cooldownUntil = throttled.includes(relay)
        ? await this.startCooldown(relay, now)
        : await this.cooldownUntil(relay);
      const key = `${RETRY_PREFIX}${event.id}:${relay}`;
      // Don't re-queue if an attempt is already pending for this pair.
      const existing = await this.ctx.storage.get<RetryRecord>(key);
      if (existing) continue;
      const nextAttemptAt = Math.max(now + jitteredBackoff(0), afterCooldown(cooldownUntil));
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

  // Walk the retry queue, attempting up to RETRY_BATCH records whose
  // nextAttemptAt has arrived. Returns the count attempted (regardless of
  // outcome). Records for a relay in cool-down are pushed past it without
  // spending an attempt; a relay that throttles us during the tick starts a
  // cool-down, so its other due records wait too. Surviving records reschedule
  // the alarm to their soonest nextAttemptAt.
  //
  // The queue is paged: until 2026-09-27 this read only the first 50 keys (by
  // event id) and skipped the ones not yet due, so 50 future-scheduled
  // records starved every due record that sorted after them.
  private async processRetries(): Promise<number> {
    const now = Date.now();
    const cooldowns = new Map<string, number>();
    const cooldownOf = async (relay: string) => {
      let until = cooldowns.get(relay);
      if (until === undefined) {
        until = await this.cooldownUntil(relay);
        cooldowns.set(relay, until);
      }
      return until;
    };

    let processed = 0;
    let earliest = Infinity;
    let startAfter: string | undefined;
    let more = true;

    while (more && processed < RETRY_BATCH) {
      const page = await this.ctx.storage.list<RetryRecord>({
        prefix: RETRY_PREFIX,
        limit: RETRY_LIST_PAGE,
        ...(startAfter !== undefined ? { startAfter } : {}),
      });
      more = page.size === RETRY_LIST_PAGE;
      for (const [key, record] of page.entries()) {
        startAfter = key;
        if (record.nextAttemptAt > now) {
          if (record.nextAttemptAt < earliest) earliest = record.nextAttemptAt;
          continue;
        }
        if (processed >= RETRY_BATCH) {
          // Due, but over this tick's budget: run again right away.
          earliest = now;
          more = false;
          break;
        }
        const relay = key.slice(RETRY_PREFIX.length + record.event.id.length + 1);

        const cooling = await cooldownOf(relay);
        if (cooling > now) {
          const deferredTo = afterCooldown(cooling);
          await this.ctx.storage.put(key, { ...record, nextAttemptAt: deferredTo });
          if (deferredTo < earliest) earliest = deferredTo;
          continue;
        }

        processed++;
        const outcome = await this.publishOnce(relay, record.event);
        if (outcome === "accepted" && cooling > 0) {
          // The relay takes our events again: forget its cool-down history.
          await this.ctx.storage.delete(`${COOLDOWN_PREFIX}${relay}`);
          cooldowns.set(relay, 0);
        }
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
        let nextAttemptAt = now + jitteredBackoff(nextAttempts);
        if (outcome === "throttled") {
          const until = await this.startCooldown(relay, now);
          cooldowns.set(relay, until);
          nextAttemptAt = Math.max(nextAttemptAt, afterCooldown(until));
        }
        await this.ctx.storage.put(key, {
          event: record.event,
          attempts: nextAttempts,
          nextAttemptAt,
        });
        if (nextAttemptAt < earliest) earliest = nextAttemptAt;
      }
    }

    if (earliest !== Infinity) {
      const current = await this.ctx.storage.getAlarm();
      if (current == null || current > earliest) {
        await this.ctx.storage.setAlarm(earliest);
      }
    }
    return processed;
  }

  // When the relay's cool-down ends (0 if it has none). An expired record is
  // kept: it remembers the level, so the next throttle escalates.
  private async cooldownUntil(relay: string): Promise<number> {
    return (await this.ctx.storage.get<RelayCooldown>(`${COOLDOWN_PREFIX}${relay}`))?.until ?? 0;
  }

  // A throttle reply: start, keep, or escalate the cool-down; returns when it ends.
  private async startCooldown(relay: string, now: number): Promise<number> {
    const key = `${COOLDOWN_PREFIX}${relay}`;
    const prev = await this.ctx.storage.get<RelayCooldown>(key);
    const next = nextCooldown(prev, now);
    if (next !== prev) await this.ctx.storage.put(key, next);
    return next.until;
  }

  // Fresh-socket single-event publish, used by the retry queue. Mirrors the
  // shape of publish.ts:publishBatchToRelay but lives inside the DO so we don't
  // need to plumb a worker-side helper through. Returns one of four
  // outcomes ("throttled" = a transient rejection that also asks us to back
  // off); the caller decides whether to delete or reschedule.
  private async publishOnce(
    relay: string,
    event: NostrEvent,
  ): Promise<"accepted" | "rate-limited-retrying" | "throttled" | "failed-permanent"> {
    let ws: WebSocket | null = null;
    try {
      ws = await connectRelaySocket(relayHttpUrl(relay), RELAY_CONNECT_TIMEOUT_MS);
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
              const status = classifyRejection(message);
              return resolve(
                status === "rate-limited-retrying" && isRelayThrottle(message) ? "throttled" : status,
              );
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
    // A connect timeout throws; ensureConnected catches it and schedules a
    // reconnect, same as a failed upgrade.
    const ws = await connectRelaySocket(relayHttpUrl(relay), RELAY_CONNECT_TIMEOUT_MS);
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
          ws = await connectRelaySocket(relayHttpUrl(relay), RELAY_CONNECT_TIMEOUT_MS);
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
