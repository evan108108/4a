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

import { blake3 } from "@noble/hashes/blake3.js";
import { nip19 } from "nostr-tools";
import { verifyJwt, type AuthClaims, type AuthEnv } from "./auth";
import {
  deriveNostrKey,
  signEventWithDerivedKey,
  type EventTemplate,
  type KmsEnv,
  type SignedEvent,
} from "./kms";
import { classifyRejection, RELAYS, type RelayPool } from "./relay-pool";

export type PublishEnv = AuthEnv & KmsEnv & {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
};

const CONTEXT_URL = "https://4a4.ai/ns/v0";
const MAX_CONTENT_BYTES = 10 * 1024;
const RATE_LIMIT_PER_HOUR = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RELAY_OK_TIMEOUT_MS = 3000;
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

// ─── BLAKE3 content tag (must match scripts/genesis.mjs and relay-pool.ts) ──
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
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
function blake3ContentTag(content: string): string {
  return "bk-" + base32Encode(blake3(new TextEncoder().encode(content)));
}

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

function rateLimitCheck(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
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

interface RelayResult {
  relay: string;
  status: RelayStatus;
  // Backward-compat with v0 OpenAPI consumers: true iff status === "accepted".
  accepted: boolean;
  message?: string;
}

async function publishToRelay(relay: string, event: SignedEvent): Promise<RelayResult> {
  const httpUrl = relay.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  let ws: WebSocket | null = null;
  try {
    const response = await fetch(httpUrl, { headers: { Upgrade: "websocket" } });
    ws = response.webSocket;
    if (!ws) {
      return {
        relay,
        status: "rate-limited-retrying",
        accepted: false,
        message: "relay did not upgrade to WebSocket",
      };
    }
    ws.accept();

    const result = await new Promise<RelayResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          relay,
          status: "rate-limited-retrying",
          accepted: false,
          message: "timeout waiting for OK",
        });
      }, RELAY_OK_TIMEOUT_MS);

      ws!.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          if (Array.isArray(msg) && msg[0] === "OK" && msg[1] === event.id) {
            clearTimeout(timer);
            const ok = msg[2] === true;
            const message = typeof msg[3] === "string" ? msg[3] : "";
            const status: RelayStatus = ok ? "accepted" : classifyRejection(message);
            resolve({
              relay,
              status,
              accepted: status === "accepted",
              ...(message ? { message } : {}),
            });
          }
        } catch {
          // ignore non-JSON / unrelated frames
        }
      });
      ws!.addEventListener("close", () => {
        clearTimeout(timer);
        resolve({
          relay,
          status: "rate-limited-retrying",
          accepted: false,
          message: "socket closed before OK",
        });
      });
      ws!.addEventListener("error", () => {
        clearTimeout(timer);
        resolve({
          relay,
          status: "rate-limited-retrying",
          accepted: false,
          message: "socket error",
        });
      });

      ws!.send(JSON.stringify(["EVENT", event]));
    });
    return result;
  } catch (err) {
    return {
      relay,
      status: "rate-limited-retrying",
      accepted: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try { ws?.close(); } catch { /* noop */ }
  }
}

async function fanOut(event: SignedEvent): Promise<RelayResult[]> {
  return Promise.all(RELAYS.map((relay) => publishToRelay(relay, event)));
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

export type Kind = "observation" | "claim" | "entity" | "relation" | "attest";

function dispatchKind(kind: Kind, body: Record<string, unknown>, pubkey: string): BuiltEvent {
  switch (kind) {
    case "observation": return buildObservation(body as unknown as ObservationBody, pubkey);
    case "claim":       return buildClaim(body as unknown as ClaimBody, pubkey);
    case "entity":      return buildEntity(body as unknown as EntityBody);
    case "relation":    return buildRelation(body as unknown as RelationBody, pubkey);
    case "attest":      return buildAttest(body as unknown as AttestBody);
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
    // retry queue takes over. Don't await — the DO call is fire-and-forget;
    // a failure to enqueue must not break the publish response. No-op when
    // there's nothing to retry.
    const retryRelays = relayResults
      .filter((r) => r.status === "rate-limited-retrying")
      .map((r) => r.relay);
    if (retryRelays.length > 0) {
      try {
        const id = env.RELAY_POOL.idFromName("main");
        const stub = env.RELAY_POOL.get(id);
        // Pass the SignedEvent as a plain NostrEvent — the DO re-validates id+sig.
        await stub.enqueueRetry(signed, retryRelays);
      } catch {
        // Retry-queue failures must not propagate. We've already accepted on
        // ≥1 relay (or returned 502 below); the read path is the source of
        // truth for whether the event reached the network.
      }
    }

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
    if (err instanceof ValidationError) {
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
  if (path === "/v0/attest")              return handleKind("attest",      request, env);
  return jsonError("not_found", `unknown publish path: ${path}`, 404);
}
