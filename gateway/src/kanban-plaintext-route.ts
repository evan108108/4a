// POST /v0/publish/kanban_plaintext — NIP-98-authed, caller-signed
// kinds 30550-30554 (evenflow EFB-24).
//
// One dispatcher rather than five routes. The auth model is identical across
// the kinds (NIP-98 + evenflow's own service key), so per-kind paths would buy
// only URL-level inspectability — and would cost five separate router.ts
// branches, each of which has to sit above the generic `/v0/publish/`
// startsWith. That ordering trap has already bitten this repo once (see the
// comment at the mount site); one order-sensitive line is one chance to get it
// wrong, five is five. The per-kind shape checks still exist, in the validator.
//
// Everything else mirrors kanban-tide-route.ts, deliberately: same NIP-98
// verification, same requireSignedEvent + publishAndStore primitives from
// audience-raw.ts, same signer-must-be-author rule, same response body.
//
// As with the tide, anyone may publish a 30551 naming any board, and that is
// not a hole. These kinds are parameterized-replaceable, so an event's address
// includes its author: a forgery lands at 30551:<forger>:<id>, a different
// address from evenflow's. Consumers read evenflow's pubkey.

import { publishAndStore, requireSignedEvent, type AudienceRawEnv } from "./audience-raw";
import { validateKanbanPlaintextEvent } from "./kanban-plaintext-validator";
import { rateLimitCheck } from "./publish";
import { verifyNip98 } from "./lib/nip98";

export const KANBAN_PLAINTEXT_PATH = "/v0/publish/kanban_plaintext";

export type KanbanPlaintextEnv = AudienceRawEnv;

// Deliberately NOT the shared 60/hour identity budget the tide uses.
//
// Evenflow signs every kanban event with ONE key, so a per-identity limit is a
// single budget shared by every public board on the instance. That is fine for
// the tide (one event per board per day) and useless here: 30551 fires on every
// issue create, edit, transition and container move, 30552 on every comment. A
// single busy board would exhaust 60 in minutes and then silently stop
// mirroring — a failure that looks exactly like success, since the publish is
// best-effort and the caller only sees substrate_event_id stay NULL.
//
// So the budget is per BOARD. auth.pubkey is evenflow's constant kanban key,
// which makes the effective key `kanban:<boardId>` — that, not the pubkey, is
// the real isolation guarantee: one board's burst cannot starve another's.
// 600/hour leaves roughly 2x headroom over a heavy sprint reshuffle. A board
// that genuinely exceeds it degrades the way the whole path degrades — D1 row
// lands, activity feed works, the substrate mirror is missed.
const KANBAN_RATE_LIMIT_PER_HOUR = 600;

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

/**
 * Spend one slot of a board's hourly budget.
 *
 * rateLimitCheck's window is a fixed 60/hour, so a higher ceiling is built by
 * giving each board N distinct keys and taking the first with room. Crude, but
 * it keeps the sliding-window implementation in one place instead of forking
 * it, and the arithmetic is exact: 10 buckets x 60 = 600/hour/board.
 */
const BUCKETS = KANBAN_RATE_LIMIT_PER_HOUR / 60;
const spendBoardBudget = (pubkey: string, boardId: string): boolean => {
  for (let i = 0; i < BUCKETS; i++) {
    if (rateLimitCheck(`kanban:${pubkey}:${boardId}:${i}`).ok) return true;
  }
  return false;
};

export async function handleKanbanPlaintextRequest(
  request: Request,
  env: KanbanPlaintextEnv,
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

  // The signer must be the author. NIP-98 proves who is calling; this ties that
  // to who the event claims wrote it, so a caller can't relay someone else's
  // signed event under their own rate-limit budget.
  if (event.pubkey.toLowerCase() !== auth.pubkey.toLowerCase()) {
    return jsonError("forbidden", "event.pubkey must match the NIP-98 authenticated pubkey", 403);
  }

  const check = validateKanbanPlaintextEvent(event);
  if (!check.ok) {
    return jsonError("bad_request", `kanban event invalid: ${check.error}`, 400);
  }

  // Limited AFTER validation because the budget is per board, and the board id
  // is only trustworthy once the event has been verified and shape-checked.
  // The inversion is safe: NIP-98 already gated this request, and everything
  // ahead of here is a parse plus tag lookups.
  if (!spendBoardBudget(auth.pubkey, check.value.boardId)) {
    return jsonError(
      "rate_limited",
      `max ${KANBAN_RATE_LIMIT_PER_HOUR} kanban publishes/hour per board`,
      429,
    );
  }

  const out = await publishAndStore(event, env);
  if (!out.accepted) {
    return jsonError("relay_failure", "no relays accepted the kanban event", 502);
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
