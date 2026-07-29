// Closed-room guard for kind:30520 audience declarations.
//
// Per sonata-studio-room-lifecycle.md §5: when a founder publishes a kind:30520
// with `["fa:status", "closed"]`, the gateway must reject subsequent mutating
// publishes targeting that audience. The "leave" claim is the one mutating
// event that remains allowed (a member of a closed room may still record
// their departure).
//
// This module reads the status tags off the latest cached declaration and
// returns a Response when the operation should be refused. The parser
// extensions in audience-validator.ts surface status/closedAt on
// AudienceDeclaration in step 2; here we walk the raw tags directly so step 1
// is independent of that change.

import {
  parseAudienceDeclaration,
  type AudienceDeclaration,
} from "./audience-validator";
import type { NostrEvent, RelayPool } from "./relay-pool";

export type AudienceStatus = "active" | "closed";

export interface AudienceStatusSnapshot {
  status: AudienceStatus;
  closedAt?: number;
  declaration: AudienceDeclaration;
  /** Raw declaration event the snapshot was derived from. */
  event: NostrEvent;
}

/**
 * Read the `fa:status` and `fa:closed-at` tags off a kind:30520 event. Absence
 * of `fa:status` means "active" per §3.1 — every pre-2026-05-14 declaration
 * has no such tag and is treated as active.
 */
export function readAudienceStatus(event: NostrEvent): {
  status: AudienceStatus;
  closedAt?: number;
} {
  let status: AudienceStatus = "active";
  let closedAt: number | undefined;
  for (const tag of event.tags) {
    if (tag[0] === "fa:status") {
      if (tag[1] === "closed") status = "closed";
      // any value other than "closed" — including "active" or junk — defaults
      // to active. The gateway only enforces the closed state; an unknown
      // status string falls back to permissive.
    } else if (tag[0] === "fa:closed-at") {
      const n = Number(tag[1]);
      if (Number.isFinite(n) && n > 0) closedAt = n;
    }
  }
  return closedAt !== undefined ? { status, closedAt } : { status };
}

export interface AudienceRawEnvLike {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
}

/**
 * Load the latest cached declaration for an audience and parse its status.
 * Returns null when the audience has never been declared on this gateway —
 * callers MUST decide whether that's a 404 (route requires an existing room)
 * or a passthrough (e.g. /create publishing the first declaration).
 */
export async function loadAudienceStatus(
  audIdPub: string,
  slug: string,
  env: AudienceRawEnvLike,
): Promise<AudienceStatusSnapshot | null> {
  const id = env.RELAY_POOL.idFromName("main");
  const stub = env.RELAY_POOL.get(id);
  const event = await stub.getObject(30520, audIdPub, slug);
  if (!event) return null;
  const parsed = parseAudienceDeclaration(event, { dropExpiredPending: true });
  if (!parsed.ok) return null;
  const { status, closedAt } = readAudienceStatus(event);
  const snapshot: AudienceStatusSnapshot = {
    status,
    declaration: parsed.value,
    event,
  };
  if (closedAt !== undefined) snapshot.closedAt = closedAt;
  return snapshot;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const JSON_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

/**
 * If the snapshot is closed, return a 403 `closed_room` Response identifying
 * the operation that was refused. Otherwise return null so the caller can
 * proceed. Null snapshots (audience not yet declared) also pass — they are
 * the caller's responsibility to handle.
 */
export function rejectIfClosed(
  snapshot: AudienceStatusSnapshot | null,
  operation: string,
): Response | null {
  if (!snapshot) return null;
  if (snapshot.status !== "closed") return null;
  const body: Record<string, unknown> = {
    error: "closed_room",
    message: `audience is closed; ${operation} not permitted`,
    operation,
  };
  if (snapshot.closedAt !== undefined) body.closed_at = snapshot.closedAt;
  return new Response(JSON.stringify(body), {
    status: 403,
    headers: JSON_HEADERS,
  });
}
