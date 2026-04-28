// 4A comment endpoint — Phase 3 v0 standalone-comment helper.
//
// POST /v0/comment on api.4a4.ai. One call signs and publishes a kind:30507
// Comment event per SPEC.md §Credibility events / SPEC-phase3-credibility.md
// §3. This is the thin sibling of /v0/score: it does NOT bundle a paired
// rationale and does NOT touch the score kind. Used by the CLI for "comment
// without scoring" and by tooling that wants to comment on existing events
// (claims, scores, other comments).
//
// NIP-10 e-tag markers are applied when reply_to_event_id is present: the
// original target carries the "root" marker and the parent comment carries
// "reply", per SPEC stub §3.2. Without a reply, a single bare e-tag points
// at the target.
//
// Per-pubkey rate limit and relay fan-out semantics are shared with
// /v0/publish/* and /v0/score by importing rateLimitCheck and fanOut from
// publish.ts.

import { nip19 } from "nostr-tools";
import { verifyJwt, type AuthClaims, type AuthEnv } from "./auth";
import { blake3ContentTag } from "./lib/blake3-tag";
import { FA_CONTEXT_V0 } from "./lib/score-shape";
import {
  deriveNostrKey,
  signEventWithDerivedKey,
  type EventTemplate,
  type KmsEnv,
  type SignedEvent,
} from "./kms";
import type { RelayPool } from "./relay-pool";
import { fanOut, rateLimitCheck, type RelayResult } from "./publish";
import { validateCommentEvent } from "./comment-validator";

export type CommentEnv = AuthEnv & KmsEnv & {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
};

const KIND_COMMENT = 30507;
const HEX64 = /^[0-9a-f]{64}$/i;
const ADDRESS_PATTERN = /^\d+:[0-9a-f]{64}:.+$/i;
const MAX_BODY_BYTES = 8 * 1024;

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

export class CommentValidationError extends Error {}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function jsonError(
  code: string,
  message: string,
  status: number,
  extra?: Record<string, unknown>,
): Response {
  return jsonResponse({ error: code, message, ...(extra ?? {}) }, status);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function randomSlug(): string {
  // 8 hex chars (4 random bytes). Slug is namespaced under (pubkey, kind=30507),
  // so the collision space is comfortable for v0. Authors who want supersession
  // can republish via the raw publish path with a stable d-tag.
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export interface CommentBody {
  target_event_id: string;
  body: string;
  intent?: string;
  reply_to_event_id?: string;
  target_a_tag?: string;
}

export function validateCommentBody(raw: Record<string, unknown>): CommentBody {
  const targetId = raw.target_event_id;
  if (typeof targetId !== "string" || !HEX64.test(targetId)) {
    throw new CommentValidationError("target_event_id must be a 64-char hex string");
  }

  const body = raw.body;
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new CommentValidationError("body must be a non-empty string");
  }
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new CommentValidationError(`body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  let intent: string | undefined;
  if (raw.intent !== undefined) {
    if (typeof raw.intent !== "string" || raw.intent.length === 0) {
      throw new CommentValidationError("intent must be a non-empty string when present");
    }
    intent = raw.intent;
  }

  let reply_to_event_id: string | undefined;
  if (raw.reply_to_event_id !== undefined) {
    if (typeof raw.reply_to_event_id !== "string" || !HEX64.test(raw.reply_to_event_id)) {
      throw new CommentValidationError("reply_to_event_id must be a 64-char hex string");
    }
    reply_to_event_id = raw.reply_to_event_id.toLowerCase();
  }

  let target_a_tag: string | undefined;
  if (raw.target_a_tag !== undefined) {
    if (typeof raw.target_a_tag !== "string" || !ADDRESS_PATTERN.test(raw.target_a_tag)) {
      throw new CommentValidationError("target_a_tag must match kind:pubkey:d");
    }
    target_a_tag = raw.target_a_tag;
  }

  return {
    target_event_id: targetId.toLowerCase(),
    body,
    intent,
    reply_to_event_id,
    target_a_tag,
  };
}

function buildCommentTemplate(body: CommentBody, dTag: string): EventTemplate {
  const payload: Record<string, unknown> = {
    "@context": FA_CONTEXT_V0,
    "@type": "Comment",
    body: body.body,
    target: { "@id": `nostr:${body.target_event_id}` },
  };
  if (body.intent !== undefined) payload.intent = body.intent;
  const content = JSON.stringify(payload);

  const idPrefix = body.target_event_id.slice(0, 8);
  const tags: string[][] = [["d", dTag]];

  // NIP-10 markers when this is a reply: target carries "root", parent
  // comment carries "reply". Otherwise a single bare e-tag points at the
  // target. Per SPEC stub §3.2.
  if (body.reply_to_event_id !== undefined) {
    tags.push(["e", body.target_event_id, "", "root"]);
    tags.push(["e", body.reply_to_event_id, "", "reply"]);
  } else {
    tags.push(["e", body.target_event_id]);
  }

  if (body.target_a_tag !== undefined) tags.push(["a", body.target_a_tag]);

  tags.push(
    ["blake3", blake3ContentTag(content)],
    ["alt", `comment on ${idPrefix}`],
    ["fa:context", FA_CONTEXT_V0],
  );

  return { kind: KIND_COMMENT, created_at: nowSec(), tags, content };
}

async function publishSigned(
  signed: SignedEvent,
  env: CommentEnv,
): Promise<RelayResult[]> {
  const results = await fanOut(signed);
  const retryRelays = results
    .filter((r) => r.status === "rate-limited-retrying")
    .map((r) => r.relay);
  if (retryRelays.length > 0) {
    try {
      const id = env.RELAY_POOL.idFromName("main");
      const stub = env.RELAY_POOL.get(id);
      await stub.enqueueRetry(signed, retryRelays);
    } catch {
      // Retry-queue failures must not propagate. Read path is the source of
      // truth for whether the event reached the network.
    }
  }
  return results;
}

export interface CommentPublishSuccess {
  ok: true;
  comment_event_id: string;
  address: string;
  kind: number;
  pubkey: string;
  npub: string;
  relay_acks: RelayResult[];
}

export interface CommentPublishFailure {
  ok?: undefined;
  error: string;
  message: string;
  status: number;
  extra?: Record<string, unknown>;
}

export async function runComment(
  body: CommentBody,
  claims: AuthClaims,
  env: CommentEnv,
): Promise<CommentPublishSuccess | CommentPublishFailure> {
  const rateKey = `${claims.provider}:${claims.oauth_id}`;
  const rl = rateLimitCheck(rateKey);
  if (!rl.ok) {
    return {
      error: "rate_limited",
      message: "max 60 publishes/hour per identity",
      status: 429,
      extra: { retryAfterMs: rl.retryAfterMs },
    };
  }

  const identity = { provider: claims.provider, oauth_id: claims.oauth_id };
  const { secretKey } = await deriveNostrKey(identity, env);
  secretKey.fill(0);

  const dTag = `comment-${randomSlug()}`;
  const template = buildCommentTemplate(body, dTag);
  const signed = await signEventWithDerivedKey(template, identity, env);

  // Sanity-check well-formedness before fan-out so the gateway can't emit an
  // event the read-side validator would reject. Reuses t04's validator.
  const check = validateCommentEvent(signed);
  if (!check.ok) {
    return {
      error: "internal_error",
      message: `built invalid comment event: ${check.error}`,
      status: 500,
    };
  }

  const acks = await publishSigned(signed, env);
  const accepted = acks.some((r) => r.status === "accepted");
  if (!accepted) {
    return {
      error: "relay_failure",
      message: "no relays accepted the comment event",
      status: 502,
      extra: { relay_acks: acks },
    };
  }

  return {
    ok: true,
    comment_event_id: signed.id,
    address: `${KIND_COMMENT}:${signed.pubkey}:${dTag}`,
    kind: signed.kind,
    pubkey: signed.pubkey,
    npub: nip19.npubEncode(signed.pubkey),
    relay_acks: acks,
  };
}

export async function handleCommentRequest(
  request: Request,
  env: CommentEnv,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }

  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError("unauthorized", "missing Authorization: Bearer <jwt>", 401);
  }
  const claims = await verifyJwt(auth.slice("Bearer ".length).trim(), env);
  if (!claims) return jsonError("unauthorized", "invalid or expired token", 401);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError("bad_request", "request body must be valid JSON", 400);
  }
  if (typeof raw !== "object" || raw === null) {
    return jsonError("bad_request", "request body must be a JSON object", 400);
  }

  let body: CommentBody;
  try {
    body = validateCommentBody(raw as Record<string, unknown>);
  } catch (err) {
    if (err instanceof CommentValidationError) {
      return jsonError("bad_request", err.message, 400);
    }
    return jsonError(
      "internal_error",
      err instanceof Error ? err.message : "comment validation failed",
      500,
    );
  }

  try {
    const result = await runComment(body, claims, env);
    if ("ok" in result) {
      return jsonResponse(result);
    }
    return jsonError(result.error, result.message, result.status, result.extra);
  } catch (err) {
    return jsonError(
      "internal_error",
      err instanceof Error ? err.message : "comment publish failed",
      500,
    );
  }
}
