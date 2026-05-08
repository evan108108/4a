// GET /v0/audience/by-invite-pub/<invite_pub_hex>
//
// Public read used by the Sonata Studio plugin's `studio_room_join` flow to
// resolve an invite URL of the form `4a://invite/<slug>/<epoch>?k=<priv>`
// into a (declaration, aud_id_pub, slug) triple. The new URL format omits
// `aud_id_pub` from the path — the plugin derives `invite_pub` from the
// invite priv and asks the gateway to look up the declaration that lists
// this `invite_pub` under `fa:pending`.
//
// Status codes per Phase 3 §3 error policy:
//   200 on hit (returns the cached signed kind:30520 event).
//   404 if the invite_pub has never been seen in any pending list.
//   410 if it was once pending but has been claimed or rotated out (so the
//       client can distinguish "wrong invite" from "expired invite").
//
// No NIP-98 auth required — declarations are public Nostr events, mirroring
// the posture of GET /v0/audience/:slug/declaration.
//
// Backed by the `pinv:` reverse index in RelayPool (storeAudienceEvent
// maintains it on every kind:30520 publish, so lookups are O(1)).

import { audienceAddress } from "./lib/audience-events";
import type { RelayPool } from "./relay-pool";

export type AudienceByInvitePubEnv = {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
};

const HEX64 = /^[0-9a-f]{64}$/i;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const JSON_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function jsonError(code: string, message: string, status: number): Response {
  return jsonResponse({ error: code, message }, status);
}

export async function handleAudienceByInvitePubRequest(
  request: Request,
  invitePubRaw: string,
  env: AudienceByInvitePubEnv,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }
  if (!HEX64.test(invitePubRaw)) {
    return jsonError("bad_request", "invite_pub must be 32-byte hex", 400);
  }
  const invitePub = invitePubRaw.toLowerCase();

  const id = env.RELAY_POOL.idFromName("main");
  const stub = env.RELAY_POOL.get(id);
  const result = await stub.getDeclarationByInvitePub(invitePub);

  if (result.status === "not_found") {
    return jsonError("not_found", "invite_pub has never been seen as pending", 404);
  }
  if (result.status === "removed") {
    return jsonResponse(
      {
        error: "invite_gone",
        message: "invite_pub was once pending but has been claimed or rotated out",
        audience_address: audienceAddress(result.audIdPub, result.slug),
        aud_id_pub: result.audIdPub,
        slug: result.slug,
      },
      410,
    );
  }
  return jsonResponse({
    ok: true,
    audience_address: audienceAddress(result.audIdPub, result.slug),
    aud_id_pub: result.audIdPub,
    slug: result.slug,
    declaration: result.event,
  });
}
