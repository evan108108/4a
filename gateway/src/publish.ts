// 4A publish endpoints — Phase 2 custodial publishing path.
//
// Five POST routes on api.4a4.ai:
//   /v0/publish/observation  — kind 30500
//   /v0/publish/claim        — kind 30501
//   /v0/publish/entity       — kind 30502
//   /v0/publish/relation     — kind 30503
//   /v0/attest               — kind 1985 NIP-32 label
//
// Every handler verifies the JWT, validates the body, builds an unsigned 4A
// event, signs it with a KMS-derived key, and fans out to the public relays
// over fresh outbound WebSockets. The read-side RelayPool ingests the same
// events through its persistent subscription — we don't share connections.

import { nip19 } from "nostr-tools";
import { verifyJwt, type AuthClaims, type AuthEnv } from "./auth";
import { blake3ContentTag } from "./lib/blake3-tag";
import {
  deriveNostrKey,
  signEventWithDerivedKey,
  type EventTemplate,
  type KmsEnv,
  type SignedEvent,
} from "./kms";
import { buildProfile, ProfileValidationError, type ProfileBody } from "./profile-builder";
import {
  buildGrant,
  buildGrantRevoke,
  buildOrg,
  OrgValidationError,
  type GrantBody,
  type GrantRevokeBody,
  type OrgBody,
} from "./org-builder";
import {
  classifyRejection,
  isRelayThrottle,
  nextCooldown,
  RELAYS,
  type RelayCooldown,
  type RelayPool,
} from "./relay-pool";
import { connectRelaySocket } from "./lib/relay-connect";

export type PublishEnv = AuthEnv & KmsEnv & {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
};

const CONTEXT_URL = "https://4a4.ai/ns/v0";
const MAX_CONTENT_BYTES = 10 * 1024;
const RATE_LIMIT_PER_HOUR = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
// Per-relay bounds for the publish fan-out. The upgrade (connect) and the
// wait for OK are bounded separately, so one relay costs at most
// RELAY_CONNECT_TIMEOUT_MS + RELAY_OK_TIMEOUT_MS before it is handed to the
// DO retry queue. See lib/relay-connect.ts for why the connect bound exists.
export const RELAY_CONNECT_TIMEOUT_MS = 3000;
export const RELAY_OK_TIMEOUT_MS = 3000;
// Pacing inside one relay socket. relay.damus.io bans the gateway's egress
// ("banned: too many rate-limit violations") when a batch arrives as one
// burst, so a batch keeps at most RELAY_MAX_UNACKED EVENT frames unanswered
// per relay and spaces sends at least RELAY_EVENT_GAP_MS apart.
export const RELAY_MAX_UNACKED = 5;
export const RELAY_EVENT_GAP_MS = 50;
// A batch gets the single-event OK window plus, per extra event, its pacing
// gap and RELAY_BATCH_OK_PER_EVENT_MS for the relay to answer, capped at
// RELAY_BATCH_OK_MAX_MS. One event keeps exactly RELAY_OK_TIMEOUT_MS.
export const RELAY_BATCH_OK_PER_EVENT_MS = 100;
export const RELAY_BATCH_OK_MAX_MS = 12_000;

export function batchOkWindowMs(events: number): number {
  return Math.min(
    RELAY_BATCH_OK_MAX_MS,
    RELAY_OK_TIMEOUT_MS +
      (RELAY_EVENT_GAP_MS + RELAY_BATCH_OK_PER_EVENT_MS) * Math.max(0, events - 1),
  );
}

// Relays that said "rate-limited"/"banned", as seen by THIS isolate: skipped
// until the cool-down ends (their events go to the DO retry queue, which
// keeps its own cool-down; see RelayPool.enqueueRetry). Same escalation as
// the DO (nextCooldown); an accept from the relay resets it. Isolates are
// reused across requests, so this stops the next few publishes re-offending.
const relayCooldowns = new Map<string, RelayCooldown>();

/** Test hook: forget every isolate-level cool-down. */
export function resetRelayCooldowns(): void {
  relayCooldowns.clear();
}

export const COOLDOWN_SKIP_MESSAGE = "skipped: relay in cool-down";

const HEX64 = /^[0-9a-f]{64}$/i;

const KIND_OBSERVATION = 30500;
const KIND_CLAIM = 30501;
const KIND_ENTITY = 30502;
const KIND_RELATION = 30503;
const KIND_LABEL = 1985;

const ATTEST_NAMESPACE_PATTERN = /^4a\.(credibility\.[a-z0-9._-]+|stamp\.[a-z0-9._-]+|sponsor)$/i;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const JSON_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

// ─── slug helpers ───────────────────────────────────────────────────────────

function slugify(input: string, maxLen = 64): string {
  const lower = input.normalize("NFKD").toLowerCase();
  const cleaned = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "untitled").slice(0, maxLen);
}

// ─── input validation ───────────────────────────────────────────────────────

function looksLikeUri(s: string): boolean {
  if (s.includes("://")) return true;
  // kind:pubkey:d  — three colon-separated parts, kind numeric, pubkey hex64
  const parts = s.split(":");
  if (parts.length !== 3) return false;
  const [k, pk, d] = parts as [string, string, string];
  return /^\d+$/.test(k) && HEX64.test(pk) && d.length > 0;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireUriField(value: unknown, field: string): string {
  const s = requireNonEmptyString(value, field);
  if (!looksLikeUri(s)) {
    throw new ValidationError(`${field} must be a URI (contain '://') or a kind:pubkey:d address`);
  }
  return s;
}

class ValidationError extends Error {}

// ─── per-pubkey rate limiter ────────────────────────────────────────────────

const rateLimitWindow = new Map<string, number[]>();

export function rateLimitCheck(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const stamps = (rateLimitWindow.get(key) ?? []).filter((t) => t > cutoff);
  if (stamps.length >= RATE_LIMIT_PER_HOUR) {
    const oldest = stamps[0]!;
    return { ok: false, retryAfterMs: oldest + RATE_LIMIT_WINDOW_MS - now };
  }
  stamps.push(now);
  rateLimitWindow.set(key, stamps);
  return { ok: true };
}

// ─── relay fan-out ──────────────────────────────────────────────────────────

// Three-way status reflecting partial-success states surfaced to API callers
// and downstream MCP/ChatGPT tools.
//
//   "accepted"               — relay returned [OK, id, true, ...] OR the
//                              "duplicate:" prefix (already had the event).
//   "rate-limited-retrying"  — transient: rate-limited, auth-required, socket
//                              hangup, or timeout. The DO retry queue will
//                              re-attempt with exponential backoff (max 4).
//   "failed-permanent"       — relay rejected for content reasons (invalid,
//                              blocked, pow). No retry — would never succeed.
export type RelayStatus =
  | "accepted"
  | "rate-limited-retrying"
  | "failed-permanent";

export interface RelayResult {
  relay: string;
  status: RelayStatus;
  // Backward-compat with v0 OpenAPI consumers: true iff status === "accepted".
  accepted: boolean;
  message?: string;
}

// Per-relay timing of one batch, for the publish timing logs.
export interface RelayBatchTiming {
  relay: string;
  /** Upgrade time; null when the relay was skipped or the connect failed. */
  connect_ms: number | null;
  total_ms: number;
  sent: number;
  accepted: number;
  /** Why this relay stopped early, if it did (cool-down, throttle, timeout, socket). */
  stopped?: string;
}

// Publish a batch of events to one relay over ONE socket: connect (bounded by
// RELAY_CONNECT_TIMEOUT_MS), then send the EVENT frames paced (at most
// RELAY_MAX_UNACKED unanswered, RELAY_EVENT_GAP_MS apart) and collect the OKs
// by event id until all have answered or the batch window (batchOkWindowMs)
// closes. If the relay rate-limits or bans us mid-batch, stop sending, start
// its cool-down, and hand the rest back for retry. Returns one result per
// input event, in input order. Events the relay never answered or we never
// sent, and every event when the connect or socket fails, come back
// "rate-limited-retrying" so the caller can queue them for retry.
async function publishBatchToRelay(
  relay: string,
  events: readonly SignedEvent[],
): Promise<{ results: RelayResult[]; timing: RelayBatchTiming }> {
  const started = Date.now();
  const retrying = (message: string): RelayResult => ({
    relay,
    status: "rate-limited-retrying",
    accepted: false,
    message,
  });
  const finish = (results: RelayResult[], connectMs: number | null, sent: number, stopped?: string) => ({
    results,
    timing: {
      relay,
      connect_ms: connectMs,
      total_ms: Date.now() - started,
      sent,
      accepted: results.filter((r) => r.accepted).length,
      ...(stopped ? { stopped } : {}),
    },
  });

  if ((relayCooldowns.get(relay)?.until ?? 0) > started) {
    return finish(events.map(() => retrying(COOLDOWN_SKIP_MESSAGE)), null, 0, "cool-down");
  }

  const httpUrl = relay.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  let ws: WebSocket | null = null;
  let connectMs: number | null = null;
  let sentCount = 0;
  try {
    ws = await connectRelaySocket(httpUrl, RELAY_CONNECT_TIMEOUT_MS);
    connectMs = Date.now() - started;
    if (!ws) return finish(events.map(() => retrying("relay did not upgrade to WebSocket")), null, 0, "no-upgrade");
    ws.accept();

    // Send each distinct event once; duplicates share its result.
    const queue = [...new Map(events.map((e) => [e.id, e])).values()];
    const answered = new Map<string, RelayResult>();
    const inFlight = new Set<string>();
    let throttled: string | null = null;
    // Resolves with the reason the still-unanswered events get.
    const unansweredReason = await new Promise<string>((resolve) => {
      let next = 0;
      let lastSentAt = -Infinity;
      let pumpTimer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const deadline = setTimeout(() => done("timeout waiting for OK"), batchOkWindowMs(queue.length));
      function done(reason: string) {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        if (pumpTimer !== undefined) clearTimeout(pumpTimer);
        resolve(reason);
      }
      function pump() {
        pumpTimer = undefined;
        if (finished) return; // a late OK after the deadline sends nothing more
        while (throttled === null && next < queue.length && inFlight.size < RELAY_MAX_UNACKED) {
          const wait = lastSentAt + RELAY_EVENT_GAP_MS - Date.now();
          if (wait > 0) {
            pumpTimer = setTimeout(pump, wait);
            return;
          }
          const event = queue[next++]!;
          inFlight.add(event.id);
          lastSentAt = Date.now();
          sentCount++;
          ws!.send(JSON.stringify(["EVENT", event]));
        }
        if (inFlight.size === 0 && (throttled !== null || next >= queue.length)) {
          done(throttled === null ? "" : `not sent: relay rate-limited us (${throttled})`);
        }
      }

      ws!.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          if (!Array.isArray(msg) || msg[0] !== "OK" || typeof msg[1] !== "string") return;
          const id = msg[1];
          if (!inFlight.delete(id)) return;
          const ok = msg[2] === true;
          const message = typeof msg[3] === "string" ? msg[3] : "";
          const status: RelayStatus = ok ? "accepted" : classifyRejection(message);
          answered.set(id, {
            relay,
            status,
            accepted: status === "accepted",
            ...(message ? { message } : {}),
          });
          if (status === "accepted") {
            relayCooldowns.delete(relay);
          } else if (status === "rate-limited-retrying" && isRelayThrottle(message) && throttled === null) {
            throttled = message;
            relayCooldowns.set(relay, nextCooldown(relayCooldowns.get(relay), Date.now()));
          }
          pump();
        } catch {
          // ignore non-JSON / unrelated frames
        }
      });
      ws!.addEventListener("close", () => done("socket closed before OK"));
      ws!.addEventListener("error", () => done("socket error"));

      pump();
    });
    const results = events.map((e) => answered.get(e.id) ?? retrying(unansweredReason));
    const stopped = throttled !== null ? "throttled" : unansweredReason ? unansweredReason : undefined;
    return finish(results, connectMs, sentCount, stopped);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finish(events.map(() => retrying(message)), connectMs, sentCount, message);
  } finally {
    try { ws?.close(); } catch { /* noop */ }
  }
}

// Publish N events to every relay: one socket per relay (RELAYS.length
// sockets in all, whatever N is), all relays in parallel. A Workers
// invocation gets 6 simultaneous open connections and queues the rest with
// their connect timers already running, so opening a socket per (event,
// relay) turned big batches into spurious connect timeouts. Returns, for each
// input event in input order, its per-relay results in RELAYS order (the same
// shape fanOut returns), plus each relay's timing. Each relay is bounded by
// RELAY_CONNECT_TIMEOUT_MS + batchOkWindowMs(N), so the whole call is too.
export async function fanOutBatchDetailed(
  events: readonly SignedEvent[],
): Promise<{ acks: RelayResult[][]; relays: RelayBatchTiming[] }> {
  if (events.length === 0) return { acks: [], relays: [] };
  const perRelay = await Promise.all(RELAYS.map((relay) => publishBatchToRelay(relay, events)));
  return {
    acks: events.map((_, i) => perRelay.map((r) => r.results[i]!)),
    relays: perRelay.map((r) => r.timing),
  };
}

export async function fanOutBatch(events: readonly SignedEvent[]): Promise<RelayResult[][]> {
  return (await fanOutBatchDetailed(events)).acks;
}

// Publish one event to every relay in parallel: a batch of one, so it is
// bounded by RELAY_CONNECT_TIMEOUT_MS + RELAY_OK_TIMEOUT_MS.
export async function fanOut(event: SignedEvent): Promise<RelayResult[]> {
  return (await fanOutBatch([event]))[0]!;
}

// Hand every transiently-failed relay ("rate-limited-retrying", which includes
// connect/OK timeouts) to the RelayPool DO retry queue. The queue is bounded:
// one record per (event, relay), RETRY_MAX_ATTEMPTS with jittered backoff,
// deleted on accept / permanent failure / exhaustion. Enqueue failures are
// logged and never propagate: the publish response is already decided.
export async function enqueueRelayRetries(
  env: { RELAY_POOL: DurableObjectNamespace<RelayPool> },
  event: SignedEvent,
  results: RelayResult[],
): Promise<void> {
  const retry = results.filter((r) => r.status === "rate-limited-retrying");
  const retryRelays = retry.map((r) => r.relay);
  if (retryRelays.length === 0) return;
  // Relays that rate-limited or banned us start (or extend) their cool-down
  // in the DO, so the queue waits it out instead of spending attempts.
  const throttled = retry.filter((r) => isRelayThrottle(r.message ?? "")).map((r) => r.relay);
  try {
    const stub = env.RELAY_POOL.get(env.RELAY_POOL.idFromName("main"));
    // Pass the SignedEvent as a plain NostrEvent — the DO re-validates id+sig.
    await stub.enqueueRetry(event, retryRelays, throttled);
  } catch (err) {
    console.error("[enqueueRelayRetries] enqueue failed", {
      kind: event.kind,
      id: event.id,
      relays: retryRelays,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── response helpers ───────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function jsonError(code: string, message: string, status: number, extra?: Record<string, unknown>): Response {
  return jsonResponse({ error: code, message, ...(extra ?? {}) }, status);
}

// ─── kind builders ──────────────────────────────────────────────────────────

interface BuiltEvent {
  template: EventTemplate;
  dTag: string;
  addressable: boolean;
}

interface ObservationBody {
  about: string;
  property: string;
  value: string;
  derivedFrom?: string[];
  topic?: string[];
  dSlug?: string;
}

function buildObservation(body: ObservationBody, pubkey: string): BuiltEvent {
  const about = requireUriField(body.about, "about");
  const property = requireNonEmptyString(body.property, "property");
  const value = requireNonEmptyString(body.value, "value");
  const derivedFrom = arrayOfNonEmptyStrings(body.derivedFrom, "derivedFrom");
  const topic = arrayOfNonEmptyStrings(body.topic, "topic");
  // Auto d-slug rule for observations: slug(about)/slug(property).
  const dTag = body.dSlug
    ? requireNonEmptyString(body.dSlug, "dSlug")
    : `${slugify(about)}/${slugify(property)}`;

  const payload: Record<string, unknown> = {
    "@context": CONTEXT_URL,
    "@type": "Observation",
    agent: { "@id": `nostr:${pubkey}` },
    observationDate: new Date().toISOString(),
    observationAbout: { "@id": about },
    measuredProperty: property,
    value,
  };
  if (derivedFrom.length > 0) {
    payload["prov:wasDerivedFrom"] = derivedFrom.map((id) => ({ "@id": id }));
  }
  const content = JSON.stringify(payload);

  const tags: string[][] = [
    ["d", dTag],
    ["blake3", blake3ContentTag(content)],
    ["alt", `Observation: ${truncate(value, 140)}`],
    ["fa:context", CONTEXT_URL],
  ];
  if (looksLikeAddressable(about)) tags.push(["a", about]);
  for (const t of topic) tags.push(["t", t]);

  return {
    template: { kind: KIND_OBSERVATION, created_at: nowSec(), tags, content },
    dTag,
    addressable: true,
  };
}

interface ClaimBody {
  about: string;
  appearance: string;
  citation?: string[];
  topic?: string[];
  dSlug?: string;
}

function buildClaim(body: ClaimBody, pubkey: string): BuiltEvent {
  const about = requireUriField(body.about, "about");
  const appearance = requireNonEmptyString(body.appearance, "appearance");
  const citation = arrayOfNonEmptyStrings(body.citation, "citation");
  const topic = arrayOfNonEmptyStrings(body.topic, "topic");
  // Auto d-slug rule for claims: slug(about)/slug(appearance-truncated).
  const dTag = body.dSlug
    ? requireNonEmptyString(body.dSlug, "dSlug")
    : `${slugify(about)}/${slugify(appearance.slice(0, 64))}`;

  const payload: Record<string, unknown> = {
    "@context": CONTEXT_URL,
    "@type": "Claim",
    author: { "@id": `nostr:${pubkey}` },
    datePublished: new Date().toISOString().slice(0, 10),
    about: { "@id": about },
    appearance,
  };
  if (citation.length > 0) {
    payload.citation = citation.map((id) => ({ "@id": id }));
  }
  const content = JSON.stringify(payload);

  const tags: string[][] = [
    ["d", dTag],
    ["blake3", blake3ContentTag(content)],
    ["alt", `Claim: ${truncate(appearance, 140)}`],
    ["fa:context", CONTEXT_URL],
  ];
  if (looksLikeAddressable(about)) tags.push(["a", about]);
  for (const id of citation) {
    if (looksLikeAddressable(id)) tags.push(["a", id]);
  }
  for (const t of topic) tags.push(["t", t]);

  return {
    template: { kind: KIND_CLAIM, created_at: nowSec(), tags, content },
    dTag,
    addressable: true,
  };
}

interface EntityBody {
  canonicalId: string;
  name: string;
  description?: string;
  codeRepository?: string;
  programmingLanguage?: string;
  types?: string[];
  topic?: string[];
  dSlug?: string;
}

function buildEntity(body: EntityBody): BuiltEvent {
  const canonicalId = requireUriField(body.canonicalId, "canonicalId");
  const name = requireNonEmptyString(body.name, "name");
  const types = arrayOfNonEmptyStrings(body.types, "types");
  const topic = arrayOfNonEmptyStrings(body.topic, "topic");
  // Auto d-slug rule for entities: slug(canonicalId).
  const dTag = body.dSlug ? requireNonEmptyString(body.dSlug, "dSlug") : slugify(canonicalId);

  const typeArray = ["Thing", ...types];
  const payload: Record<string, unknown> = {
    "@context": CONTEXT_URL,
    "@type": typeArray,
    "@id": canonicalId,
    name,
  };
  if (body.description !== undefined) {
    payload.description = requireNonEmptyString(body.description, "description");
  }
  if (body.codeRepository !== undefined) {
    payload.codeRepository = requireUriField(body.codeRepository, "codeRepository");
  }
  if (body.programmingLanguage !== undefined) {
    payload.programmingLanguage = requireNonEmptyString(body.programmingLanguage, "programmingLanguage");
  }
  const content = JSON.stringify(payload);

  const tags: string[][] = [
    ["d", dTag],
    ["blake3", blake3ContentTag(content)],
    ["alt", `Entity: ${truncate(name, 140)}`],
    ["fa:context", CONTEXT_URL],
  ];
  for (const t of topic) tags.push(["t", t]);

  return {
    template: { kind: KIND_ENTITY, created_at: nowSec(), tags, content },
    dTag,
    addressable: true,
  };
}

interface RelationBody {
  subject: string;
  object: string;
  roleName: string;
  startDate?: string;
  endDate?: string;
  dSlug?: string;
}

function buildRelation(body: RelationBody, pubkey: string): BuiltEvent {
  const subject = requireUriField(body.subject, "subject");
  const obj = requireUriField(body.object, "object");
  const roleName = requireNonEmptyString(body.roleName, "roleName");
  // Auto d-slug rule for relations: slug(subject)-slug(role)-slug(object).
  const dTag = body.dSlug
    ? requireNonEmptyString(body.dSlug, "dSlug")
    : `${slugify(subject)}-${slugify(roleName)}-${slugify(obj)}`;

  const payload: Record<string, unknown> = {
    "@context": CONTEXT_URL,
    "@type": "Role",
    roleName,
    subject: { "@id": subject },
    object: { "@id": obj },
    "prov:wasAttributedTo": { "@id": `nostr:${pubkey}` },
  };
  if (body.startDate !== undefined) {
    payload.startDate = requireNonEmptyString(body.startDate, "startDate");
  }
  if (body.endDate !== undefined) {
    payload.endDate = requireNonEmptyString(body.endDate, "endDate");
  }
  const content = JSON.stringify(payload);

  const tags: string[][] = [
    ["d", dTag],
    ["blake3", blake3ContentTag(content)],
    ["alt", `Relation: ${truncate(roleName, 60)} (${truncate(subject, 60)} → ${truncate(obj, 60)})`],
    ["fa:context", CONTEXT_URL],
  ];
  if (looksLikeAddressable(subject)) tags.push(["a", subject]);
  if (looksLikeAddressable(obj)) tags.push(["a", obj]);

  return {
    template: { kind: KIND_RELATION, created_at: nowSec(), tags, content },
    dTag,
    addressable: true,
  };
}

interface AttestBody {
  subject: string;        // pubkey (hex64) or event-id (hex64)
  namespace: string;      // 4a.credibility.<domain> | 4a.stamp.<source> | 4a.sponsor
  value?: string;         // label value scoped to the namespace
}

function buildAttest(body: AttestBody): BuiltEvent {
  const subject = requireNonEmptyString(body.subject, "subject");
  if (!HEX64.test(subject)) {
    throw new ValidationError("subject must be a 64-char hex pubkey or event id");
  }
  const namespace = requireNonEmptyString(body.namespace, "namespace");
  if (!ATTEST_NAMESPACE_PATTERN.test(namespace)) {
    throw new ValidationError(
      "namespace must match 4a.credibility.<domain> | 4a.stamp.<source> | 4a.sponsor",
    );
  }
  const value = body.value !== undefined
    ? requireNonEmptyString(body.value, "value")
    : (namespace === "4a.sponsor" ? "sponsored" : "self");

  // NIP-32 label event (kind 1985) — not addressable; no d-tag, no JSON-LD payload.
  // We store the human summary in `content` and the structured signal in tags.
  const content = `[4A label] ${namespace}=${value} subject=${subject.slice(0, 16)}…`;
  const tags: string[][] = [
    ["L", namespace],
    ["l", value, namespace],
    // Heuristic: 64-char hex could be a pubkey OR an event id. We tag both to
    // let consumers filter either way. Aggregators should treat the namespace
    // (4a.sponsor → pubkey; everything else → either) as the disambiguator.
    ["p", subject],
    ["e", subject],
    ["alt", `4A attestation: ${namespace}=${value}`],
  ];

  return {
    template: { kind: KIND_LABEL, created_at: nowSec(), tags, content },
    dTag: "",
    addressable: false,
  };
}

// ─── shared helpers ─────────────────────────────────────────────────────────

function nowSec(): number { return Math.floor(Date.now() / 1000); }

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function looksLikeAddressable(s: string): boolean {
  const parts = s.split(":");
  if (parts.length !== 3) return false;
  return /^\d+$/.test(parts[0]!) && HEX64.test(parts[1]!) && parts[2]!.length > 0;
}

function arrayOfNonEmptyStrings(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array of strings`);
  return value.map((v, i) => requireNonEmptyString(v, `${field}[${i}]`));
}

// ─── core dispatch ──────────────────────────────────────────────────────────

export type Kind =
  | "observation"
  | "claim"
  | "entity"
  | "relation"
  | "attest"
  | "profile"
  | "org"
  | "grant"
  | "grant_revoke";

function dispatchKind(kind: Kind, body: Record<string, unknown>, pubkey: string): BuiltEvent {
  switch (kind) {
    case "observation":  return buildObservation(body as unknown as ObservationBody, pubkey);
    case "claim":        return buildClaim(body as unknown as ClaimBody, pubkey);
    case "entity":       return buildEntity(body as unknown as EntityBody);
    case "relation":     return buildRelation(body as unknown as RelationBody, pubkey);
    case "attest":       return buildAttest(body as unknown as AttestBody);
    case "profile":      return buildProfile(body as unknown as ProfileBody);
    case "org":          return buildOrg(body as unknown as OrgBody);
    case "grant":        return buildGrant(body as unknown as GrantBody);
    case "grant_revoke": return buildGrantRevoke(body as unknown as GrantRevokeBody);
  }
}

export interface PublishSuccess {
  ok: true;
  eventId: string;
  address: string | null;
  kind: number;
  pubkey: string;
  npub: string;
  relayResults: RelayResult[];
}

export interface PublishFailure {
  ok: false;
  status: number;
  error: string;
  message: string;
  extra?: Record<string, unknown>;
}

export type PublishResult = PublishSuccess | PublishFailure;

// Shared core used by both the HTTP handler and the MCP write tools. Auth is
// already resolved (claims passed in); body is already a parsed JSON object.
export async function runPublish(
  kind: Kind,
  body: Record<string, unknown>,
  claims: AuthClaims,
  env: PublishEnv,
): Promise<PublishResult> {
  const rateKey = `${claims.provider}:${claims.oauth_id}`;
  const rl = rateLimitCheck(rateKey);
  if (!rl.ok) {
    return {
      ok: false,
      status: 429,
      error: "rate_limited",
      message: `max ${RATE_LIMIT_PER_HOUR} publishes/hour per identity`,
      extra: { retryAfterMs: rl.retryAfterMs },
    };
  }

  try {
    // Pre-derive the pubkey so we can stamp it into payloads (agent / author /
    // wasAttributedTo). signEventWithDerivedKey re-derives — that's two KMS
    // calls per publish; acceptable for v0, cache later if it bites.
    const identity = { provider: claims.provider, oauth_id: claims.oauth_id };
    const { publicKey, secretKey } = await deriveNostrKey(identity, env);
    secretKey.fill(0);

    const built = dispatchKind(kind, body, publicKey);
    if (new TextEncoder().encode(built.template.content).byteLength > MAX_CONTENT_BYTES) {
      return {
        ok: false,
        status: 413,
        error: "payload_too_large",
        message: `content exceeds ${MAX_CONTENT_BYTES} bytes`,
      };
    }

    const signed: SignedEvent = await signEventWithDerivedKey(built.template, identity, env);
    const relayResults = await fanOut(signed);
    const accepted = relayResults.filter((r) => r.status === "accepted").length;

    // Enqueue any rate-limited-retrying relays on the DO so the alarm-driven
    // retry queue takes over. A failure to enqueue is logged and must not
    // break the publish response (we've already accepted on ≥1 relay, or
    // return 502 below). No-op when there's nothing to retry.
    await enqueueRelayRetries(env, signed, relayResults);

    if (accepted === 0) {
      return {
        ok: false,
        status: 502,
        error: "relay_failure",
        message: "no relays accepted the event",
        extra: { relayResults },
      };
    }
    const npub = nip19.npubEncode(signed.pubkey);
    const address = built.addressable ? `${signed.kind}:${signed.pubkey}:${built.dTag}` : null;
    return {
      ok: true,
      eventId: signed.id,
      address,
      kind: signed.kind,
      pubkey: signed.pubkey,
      npub,
      relayResults,
    };
  } catch (err) {
    if (
      err instanceof ValidationError ||
      err instanceof ProfileValidationError ||
      err instanceof OrgValidationError
    ) {
      return { ok: false, status: 400, error: "bad_request", message: err.message };
    }
    return {
      ok: false,
      status: 500,
      error: "internal_error",
      message: err instanceof Error ? err.message : "publish failed",
    };
  }
}

async function handleKind(kind: Kind, request: Request, env: PublishEnv): Promise<Response> {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError("unauthorized", "missing Authorization: Bearer <jwt>", 401);
  }
  const claims = await verifyJwt(auth.slice("Bearer ".length).trim(), env);
  if (!claims) return jsonError("unauthorized", "invalid or expired token", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("bad_request", "request body must be valid JSON", 400);
  }
  if (typeof body !== "object" || body === null) {
    return jsonError("bad_request", "request body must be a JSON object", 400);
  }

  const result = await runPublish(kind, body as Record<string, unknown>, claims, env);
  if (!result.ok) {
    return jsonError(result.error, result.message, result.status, result.extra);
  }
  return jsonResponse({
    ok: true,
    eventId: result.eventId,
    address: result.address,
    kind: result.kind,
    pubkey: result.pubkey,
    npub: result.npub,
    relayResults: result.relayResults,
  });
}

// ─── exported request handler ───────────────────────────────────────────────

export async function handlePublishRequest(request: Request, env: PublishEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }

  const path = new URL(request.url).pathname;
  if (path === "/v0/publish/observation") return handleKind("observation", request, env);
  if (path === "/v0/publish/claim")       return handleKind("claim",       request, env);
  if (path === "/v0/publish/entity")      return handleKind("entity",      request, env);
  if (path === "/v0/publish/relation")    return handleKind("relation",    request, env);
  if (path === "/v0/publish/profile")     return handleKind("profile",     request, env);
  if (path === "/v0/publish/org")          return handleKind("org",          request, env);
  if (path === "/v0/publish/grant")        return handleKind("grant",        request, env);
  if (path === "/v0/publish/grant_revoke") return handleKind("grant_revoke", request, env);
  if (path === "/v0/attest")              return handleKind("attest",      request, env);
  return jsonError("not_found", `unknown publish path: ${path}`, 404);
}
