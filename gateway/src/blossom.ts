// Blossom adapter — BUD-01 upload + BUD-02 fetch backed by R2.
//
// Endpoints:
//   PUT /blossom/upload    — verify BUD-01 auth, store body at blob/<sha256>
//   GET /blossom/<sha256>  — stream the blob with immutable cache headers
//
// The blob payload is opaque ciphertext (Studio wraps with NIP-44/AES before
// upload), so fetch is unauthenticated — security lives in the wrap, not the
// URL. Upload requires a fresh BUD-01 auth event whose `x` tag matches the
// body sha256.

import { verifyBlossomAuth, sha256Hex } from "./lib/blossom-auth";

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const PER_PUBKEY_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GiB
const HEX64 = /^[0-9a-f]{64}$/i;

const PUBLIC_HOST = "api.4a4.ai";

export interface BlossomEnv {
  STORAGE: R2Bucket;
}

function jsonError(status: number, code: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: code, ...extra }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function corsHeaders(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, PUT, HEAD, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  h.set("Access-Control-Expose-Headers", "Content-Length, Content-Type, ETag");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

interface QuotaRecord {
  bytes_used: number;
  last_reset_at: number;
}

async function readQuota(storage: R2Bucket, pubkey: string): Promise<QuotaRecord> {
  const obj = await storage.get(`quota/${pubkey}`);
  if (!obj) return { bytes_used: 0, last_reset_at: Date.now() };
  try {
    const txt = await obj.text();
    const parsed = JSON.parse(txt) as Partial<QuotaRecord>;
    if (typeof parsed.bytes_used !== "number" || typeof parsed.last_reset_at !== "number") {
      return { bytes_used: 0, last_reset_at: Date.now() };
    }
    return { bytes_used: parsed.bytes_used, last_reset_at: parsed.last_reset_at };
  } catch {
    return { bytes_used: 0, last_reset_at: Date.now() };
  }
}

async function writeQuota(storage: R2Bucket, pubkey: string, rec: QuotaRecord): Promise<void> {
  await storage.put(`quota/${pubkey}`, JSON.stringify(rec), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function handleBlossomUpload(
  request: Request,
  env: BlossomEnv,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonError(405, "method_not_allowed");
  }

  // Read body up front so we can compute sha256 and enforce size.
  const bodyBuf = new Uint8Array(await request.arrayBuffer());
  if (bodyBuf.byteLength > MAX_UPLOAD_BYTES) {
    return jsonError(413, "file_too_big", { max_bytes: MAX_UPLOAD_BYTES });
  }

  const bodySha = await sha256Hex(bodyBuf);

  const auth = verifyBlossomAuth(request.headers.get("authorization"), {
    action: "upload",
    expectedSha256: bodySha,
  });
  if (!auth.ok) {
    return jsonError(auth.status, auth.code, "reason" in auth ? { reason: auth.reason } : undefined);
  }

  // No-overwrite hardening: if this sha is already stored, keep the original
  // object — and with it the original uploader_pubkey attribution — and skip
  // both the put and the quota charge (Blossom "already have it" semantics).
  // Blobs are publicly fetchable, so without this a re-upload of someone
  // else's bytes would transfer manifest rights over their frozen artifact
  // URL to the re-uploader.
  const existing = await env.STORAGE.head(`blob/${bodySha}`);
  if (existing) {
    const uploadedAtMs = Number(existing.customMetadata?.uploaded_at_ms);
    const payload = {
      sha256: bodySha,
      mirrors: [`https://${PUBLIC_HOST}/blossom/${bodySha}`],
      url: `https://${PUBLIC_HOST}/blossom/${bodySha}`,
      size: bodyBuf.byteLength,
      uploaded: Math.floor((Number.isFinite(uploadedAtMs) ? uploadedAtMs : Date.now()) / 1000),
      type:
        existing.customMetadata?.content_type ??
        existing.httpMetadata?.contentType ??
        "application/octet-stream",
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  const quota = await readQuota(env.STORAGE, auth.pubkey);
  if (quota.bytes_used + bodyBuf.byteLength > PER_PUBKEY_QUOTA_BYTES) {
    return jsonError(413, "quota_exceeded", {
      bytes_used: quota.bytes_used,
      quota_bytes: PER_PUBKEY_QUOTA_BYTES,
    });
  }

  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  const nowMs = Date.now();

  await env.STORAGE.put(`blob/${bodySha}`, bodyBuf, {
    httpMetadata: { contentType },
    customMetadata: {
      uploader_pubkey: auth.pubkey,
      content_type: contentType,
      uploaded_at_ms: String(nowMs),
    },
  });

  await writeQuota(env.STORAGE, auth.pubkey, {
    bytes_used: quota.bytes_used + bodyBuf.byteLength,
    last_reset_at: quota.last_reset_at,
  });

  const payload = {
    sha256: bodySha,
    mirrors: [`https://${PUBLIC_HOST}/blossom/${bodySha}`],
    url: `https://${PUBLIC_HOST}/blossom/${bodySha}`,
    size: bodyBuf.byteLength,
    uploaded: Math.floor(nowMs / 1000),
    type: contentType,
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

export async function handleBlossomFetch(
  request: Request,
  sha: string,
  env: BlossomEnv,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(405, "method_not_allowed");
  }
  if (!HEX64.test(sha)) {
    return jsonError(400, "invalid_hash");
  }
  const shaLower = sha.toLowerCase();
  const obj = await env.STORAGE.get(`blob/${shaLower}`);
  if (!obj) {
    return jsonError(404, "not_found");
  }
  const contentType =
    obj.customMetadata?.content_type ?? obj.httpMetadata?.contentType ?? "application/octet-stream";
  const headers = corsHeaders({
    "Content-Type": contentType,
    "Content-Length": String(obj.size),
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"${shaLower}"`,
  });
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}

export async function handleBlossomRequest(
  request: Request,
  env: BlossomEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (url.pathname === "/blossom/upload") {
    return handleBlossomUpload(request, env);
  }

  const m = url.pathname.match(/^\/blossom\/([0-9a-fA-F]+)$/);
  if (m) {
    return handleBlossomFetch(request, m[1]!, env);
  }

  return jsonError(404, "not_found");
}
