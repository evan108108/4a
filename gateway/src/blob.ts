// POST /v0/blob — JWT-authed small-image upload for users without local
// Nostr keys (Evenflow profile pictures).
//
// The Blossom surface (blossom.ts) requires a BUD-01 auth event signed by
// the uploader's key, which OAuth-identity users can't produce — their keys
// live in KMS. This endpoint accepts the gateway JWT instead and writes to
// the SAME sha256-addressed R2 namespace (`blob/<sha256>`), so the existing
// public immutable fetch path (GET /blossom/<sha256>) serves the result.
// Quota is tracked per derived pubkey through the same records blossom.ts
// maintains.
//
// Deliberately narrow: images only, 256 KiB cap — this is an avatar pipe,
// not general storage. Anything bigger belongs on the Blossom path proper.

import { verifyJwt, type AuthEnv } from "./auth";
import { deriveNostrKey, type KmsEnv } from "./kms";
import { sha256Hex } from "./lib/blossom-auth";

export type BlobEnv = AuthEnv & KmsEnv & { STORAGE: R2Bucket };

const MAX_UPLOAD_BYTES = 256 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const PUBLIC_HOST = "api.4a4.ai";
const PER_PUBKEY_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GiB — mirrors blossom.ts

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
};

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), { status, headers: JSON_HEADERS });
}

export async function handleBlobRequest(request: Request, env: BlobEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "POST") {
    return jsonError(405, "method_not_allowed", "POST only");
  }

  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError(401, "unauthorized", "missing Authorization: Bearer <jwt>");
  }
  const claims = await verifyJwt(auth.slice("Bearer ".length).trim(), env);
  if (!claims) return jsonError(401, "unauthorized", "invalid or expired token");

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
    return jsonError(415, "unsupported_media_type", `content-type must be one of: ${ALLOWED_IMAGE_TYPES.join(", ")}`);
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0) return jsonError(400, "empty_body", "no bytes received");
  if (body.byteLength > MAX_UPLOAD_BYTES) {
    return jsonError(413, "file_too_big", `max ${MAX_UPLOAD_BYTES} bytes`);
  }

  // Attribute the upload to the caller's derived pubkey — same identity the
  // rest of the substrate uses, and the same quota records blossom.ts reads.
  const { secretKey, publicKey } = await deriveNostrKey(
    { provider: claims.provider, oauth_id: claims.oauth_id },
    env,
  );
  secretKey.fill(0);

  const quotaObj = await env.STORAGE.get(`quota/${publicKey}`);
  let quota = { bytes_used: 0, last_reset_at: Date.now() };
  if (quotaObj) {
    try {
      const parsed = JSON.parse(await quotaObj.text()) as { bytes_used?: number; last_reset_at?: number };
      if (typeof parsed.bytes_used === "number" && typeof parsed.last_reset_at === "number") {
        quota = { bytes_used: parsed.bytes_used, last_reset_at: parsed.last_reset_at };
      }
    } catch {
      // corrupt quota record → treat as empty, same as blossom.ts
    }
  }
  if (quota.bytes_used + body.byteLength > PER_PUBKEY_QUOTA_BYTES) {
    return jsonError(413, "quota_exceeded", "storage quota exceeded");
  }

  const sha256 = await sha256Hex(body);
  const nowMs = Date.now();
  await env.STORAGE.put(`blob/${sha256}`, body, {
    httpMetadata: { contentType },
    customMetadata: {
      uploader_pubkey: publicKey,
      content_type: contentType,
      uploaded_at_ms: String(nowMs),
    },
  });
  await env.STORAGE.put(
    `quota/${publicKey}`,
    JSON.stringify({ bytes_used: quota.bytes_used + body.byteLength, last_reset_at: quota.last_reset_at }),
    { httpMetadata: { contentType: "application/json" } },
  );

  return new Response(
    JSON.stringify({ url: `https://${PUBLIC_HOST}/blossom/${sha256}`, sha256, size: body.byteLength }),
    { status: 200, headers: JSON_HEADERS },
  );
}
