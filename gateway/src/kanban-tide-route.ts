// POST /v0/publish/kanban_tide — NIP-98-authed, caller-signed kind:30560.
//
// Deliberately NOT on the JWT+KMS path the rest of /v0/publish/* uses. Those
// endpoints exist so a user whose Nostr key lives in KMS can publish as
// themselves. Evenflow isn't that: it already holds its own keys, signs its
// own audience events, and a public tide snapshot is evenflow attesting to a
// number anyone can re-derive — not a user speaking. Handing it a
// gateway-derived identity would have been ceremony that says something
// untrue about who authored the reading.
//
// So this mirrors /v0/audience/raw/*: the caller signs, the gateway validates
// and fans out. It reuses that path's primitives directly rather than
// re-implementing them — `requireSignedEvent` (canonical id + schnorr) and
// `publishAndStore` (relay fan-out + DO cache), both kind-agnostic.
//
// It lives outside publish.ts to keep that file's identity intact: everything
// there is JWT-authed and gateway-signed, and this is neither.
//
// Anyone may publish a 30560 naming any board — and that's fine, not a hole.
// 30560 is parameterized-replaceable, so an event's address includes its
// author: a forgery lands at 30560:<forger>:<board>:<day>, a different address
// from evenflow's. Consumers read evenflow's pubkey. An allowlist here would
// buy nothing.

import { publishAndStore, requireSignedEvent, type AudienceRawEnv } from "./audience-raw";
import { validateKanbanTideEvent } from "./kanban-tide-validator";
import { rateLimitCheck } from "./publish";
import { verifyNip98 } from "./lib/nip98";

export const KANBAN_TIDE_PATH = "/v0/publish/kanban_tide";

export type KanbanTideEnv = AudienceRawEnv;

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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const jsonError = (error: string, message: string, status: number): Response =>
  jsonResponse({ ok: false, error, message }, status);

export async function handleKanbanTideRequest(
  request: Request,
  env: KanbanTideEnv,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }

  let bodyBytes: Uint8Array;
  try {
    bodyBytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return jsonError("bad_request", "could not read request body", 400);
  }

  const auth = await verifyNip98(request, bodyBytes);
  if (!auth.ok) {
    return jsonError(auth.error, "NIP-98 auth failed", 401);
  }
  // Same window and key convention as the audience-raw path.
  const rl = rateLimitCheck(`nip98:${auth.pubkey}`);
  if (!rl.ok) {
    return jsonError("rate_limited", "max 60 requests/hour per identity", 429);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return jsonError("bad_request", "request body must be valid JSON", 400);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return jsonError("bad_request", "request body must be a JSON object", 400);
  }

  let event;
  try {
    // Canonical NIP-01 id + schnorr verify. Throws RawValidationError, whose
    // shape we don't import — the message is what matters to the caller.
    event = requireSignedEvent((raw as Record<string, unknown>)["event"], "event");
  } catch (err) {
    return jsonError("bad_request", err instanceof Error ? err.message : "invalid event", 400);
  }

  // The signer must be the author. NIP-98 proves who is calling; this ties
  // that to who the event claims wrote it, so a caller can't relay someone
  // else's signed snapshot under their own rate-limit budget.
  if (event.pubkey.toLowerCase() !== auth.pubkey.toLowerCase()) {
    return jsonError(
      "forbidden",
      "event.pubkey must match the NIP-98 authenticated pubkey",
      403,
    );
  }

  const check = validateKanbanTideEvent(event);
  if (!check.ok) {
    return jsonError("bad_request", `tide event invalid: ${check.error}`, 400);
  }

  const out = await publishAndStore(event, env);
  if (!out.accepted) {
    return jsonError("relay_failure", "no relays accepted the tide snapshot", 502);
  }

  return jsonResponse({
    ok: true,
    eventId: event.id,
    address: `${event.kind}:${event.pubkey}:${check.value.dTag}`,
    kind: event.kind,
    pubkey: event.pubkey,
    relayResults: out.acks,
  });
}
