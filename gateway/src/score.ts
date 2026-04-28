// 4A score endpoint — Phase 3 v0 paired-publish convenience.
//
// POST /v0/score on api.4a4.ai. One call signs and publishes both a
// kind:30506 score event and its paired kind:30507 rationale comment per
// SPEC.md §Credibility events / SPEC-phase3-credibility.md §4.1. The score
// is signed first; the comment references the resulting score event id and
// is signed and published second.
//
// Nostr has no rollback. If the comment fan-out partially fails after the
// score has been accepted, we surface the per-relay acks for the comment
// as-is rather than rolling back the score. Callers see the partial state
// in `relay_acks.comment` and can re-issue a comment with the same `d` tag
// to supersede it (NIP-33).

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
import { validateScoreEvent } from "./score-validator";
import { validateCommentEvent } from "./comment-validator";

export type ScoreEnv = AuthEnv & KmsEnv & {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
};

const KIND_SCORE = 30506;
const KIND_COMMENT = 30507;
const HEX64 = /^[0-9a-f]{64}$/i;
const ADDRESS_PATTERN = /^\d+:[0-9a-f]{64}:.+$/i;
const MAX_RATIONALE_BYTES = 8 * 1024;

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

export class ScoreValidationError extends Error {}

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

export interface ScoreBody {
  target_event_id: string;
  value: number;
  rationale: string;
  tier?: string;
  intent?: string;
  target_a_tag?: string;
}

export function validateScoreBody(raw: Record<string, unknown>): ScoreBody {
  const targetId = raw.target_event_id;
  if (typeof targetId !== "string" || !HEX64.test(targetId)) {
    throw new ScoreValidationError("target_event_id must be a 64-char hex string");
  }

  const value = raw.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ScoreValidationError("value must be a finite number in [0, 1]");
  }

  const rationale = raw.rationale;
  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    throw new ScoreValidationError("rationale must be a non-empty string");
  }
  if (new TextEncoder().encode(rationale).byteLength > MAX_RATIONALE_BYTES) {
    throw new ScoreValidationError(`rationale exceeds ${MAX_RATIONALE_BYTES} bytes`);
  }

  let tier: string | undefined;
  if (raw.tier !== undefined) {
    if (typeof raw.tier !== "string" || raw.tier.length === 0) {
      throw new ScoreValidationError("tier must be a non-empty string when present");
    }
    tier = raw.tier;
  }

  let intent: string | undefined;
  if (raw.intent !== undefined) {
    if (typeof raw.intent !== "string" || raw.intent.length === 0) {
      throw new ScoreValidationError("intent must be a non-empty string when present");
    }
    intent = raw.intent;
  }

  let target_a_tag: string | undefined;
  if (raw.target_a_tag !== undefined) {
    if (typeof raw.target_a_tag !== "string" || !ADDRESS_PATTERN.test(raw.target_a_tag)) {
      throw new ScoreValidationError("target_a_tag must match kind:pubkey:d");
    }
    target_a_tag = raw.target_a_tag;
  }

  return {
    target_event_id: targetId.toLowerCase(),
    value,
    rationale,
    tier,
    intent,
    target_a_tag,
  };
}

function buildScoreTemplate(body: ScoreBody): EventTemplate {
  const payload: Record<string, unknown> = {
    "@context": FA_CONTEXT_V0,
    "@type": "Score",
    value: body.value,
    target: { "@id": `nostr:${body.target_event_id}` },
  };
  if (body.tier !== undefined) payload.tier = body.tier;
  const content = JSON.stringify(payload);

  const idPrefix = body.target_event_id.slice(0, 8);
  const tags: string[][] = [
    ["d", body.target_event_id],
    ["e", body.target_event_id],
  ];
  if (body.target_a_tag !== undefined) tags.push(["a", body.target_a_tag]);
  tags.push(
    ["blake3", blake3ContentTag(content)],
    ["alt", `score ${body.value} of ${idPrefix}`],
    ["fa:context", FA_CONTEXT_V0],
  );

  return { kind: KIND_SCORE, created_at: nowSec(), tags, content };
}

function buildCommentTemplate(
  body: ScoreBody,
  scoreEventId: string,
  scorePubkey: string,
): EventTemplate {
  const payload: Record<string, unknown> = {
    "@context": FA_CONTEXT_V0,
    "@type": "Comment",
    intent: body.intent ?? "justify",
    body: body.rationale,
    target: { "@id": `nostr:${scoreEventId}` },
  };
  const content = JSON.stringify(payload);

  const idPrefix = scoreEventId.slice(0, 8);
  const dTag = `justify-${idPrefix}`;
  const aTag = `${KIND_SCORE}:${scorePubkey}:${body.target_event_id}`;

  const tags: string[][] = [
    ["d", dTag],
    ["e", scoreEventId],
    ["a", aTag],
    ["blake3", blake3ContentTag(content)],
    ["alt", `rationale for score ${body.value} of ${idPrefix}`],
    ["fa:context", FA_CONTEXT_V0],
  ];

  return { kind: KIND_COMMENT, created_at: nowSec(), tags, content };
}

async function publishSigned(
  signed: SignedEvent,
  env: ScoreEnv,
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

export interface PairedPublishSuccess {
  ok: true;
  score_event_id: string;
  comment_event_id: string;
  score_address: string;
  comment_address: string;
  pubkey: string;
  npub: string;
  relay_acks: { score: RelayResult[]; comment: RelayResult[] };
}

export interface PairedPublishFailure {
  ok?: undefined;
  error: string;
  message: string;
  status: number;
  extra?: Record<string, unknown>;
}

export async function runScore(
  body: ScoreBody,
  claims: AuthClaims,
  env: ScoreEnv,
): Promise<PairedPublishSuccess | PairedPublishFailure> {
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

  // Pre-derive pubkey so the comment can carry the score address in its `a`
  // tag. signEventWithDerivedKey re-derives internally — same pattern as the
  // existing /v0/publish/* path.
  const identity = { provider: claims.provider, oauth_id: claims.oauth_id };
  const { publicKey, secretKey } = await deriveNostrKey(identity, env);
  secretKey.fill(0);

  // 1. Score event.
  const scoreTemplate = buildScoreTemplate(body);
  const scoreSigned = await signEventWithDerivedKey(scoreTemplate, identity, env);
  const scoreCheck = validateScoreEvent(scoreSigned);
  if (!scoreCheck.ok) {
    return {
      error: "internal_error",
      message: `built invalid score event: ${scoreCheck.error}`,
      status: 500,
    };
  }
  const scoreAcks = await publishSigned(scoreSigned, env);
  const scoreAccepted = scoreAcks.some((r) => r.status === "accepted");
  if (!scoreAccepted) {
    return {
      error: "relay_failure",
      message: "no relays accepted the score event; rationale not published",
      status: 502,
      extra: { relay_acks: { score: scoreAcks, comment: [] as RelayResult[] } },
    };
  }

  // 2. Rationale comment, referencing the score event id.
  const commentTemplate = buildCommentTemplate(body, scoreSigned.id, publicKey);
  const commentSigned = await signEventWithDerivedKey(commentTemplate, identity, env);
  const commentCheck = validateCommentEvent(commentSigned);
  if (!commentCheck.ok) {
    return {
      error: "internal_error",
      message: `built invalid comment event: ${commentCheck.error}`,
      status: 500,
    };
  }
  const commentAcks = await publishSigned(commentSigned, env);

  const scoreAddress = `${KIND_SCORE}:${publicKey}:${body.target_event_id}`;
  const commentAddress = `${KIND_COMMENT}:${publicKey}:justify-${scoreSigned.id.slice(0, 8)}`;

  return {
    ok: true,
    score_event_id: scoreSigned.id,
    comment_event_id: commentSigned.id,
    score_address: scoreAddress,
    comment_address: commentAddress,
    pubkey: publicKey,
    npub: nip19.npubEncode(publicKey),
    relay_acks: { score: scoreAcks, comment: commentAcks },
  };
}

export async function handleScoreRequest(
  request: Request,
  env: ScoreEnv,
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

  let body: ScoreBody;
  try {
    body = validateScoreBody(raw as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ScoreValidationError) {
      return jsonError("bad_request", err.message, 400);
    }
    return jsonError(
      "internal_error",
      err instanceof Error ? err.message : "score validation failed",
      500,
    );
  }

  try {
    const result = await runScore(body, claims, env);
    if ("ok" in result) {
      return jsonResponse(result);
    }
    return jsonError(result.error, result.message, result.status, result.extra);
  } catch (err) {
    return jsonError(
      "internal_error",
      err instanceof Error ? err.message : "score publish failed",
      500,
    );
  }
}
