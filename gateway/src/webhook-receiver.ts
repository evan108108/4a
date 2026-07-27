// Webhook-relay ingress — `POST /v0/hook/:pubkey/:slug` on api.4a4.ai.
//
// Accepts unauthenticated third-party webhook deliveries, preserves the raw
// body bytes (HMAC signatures are computed over exact bytes — the plan's hard
// invariant), wraps body + curated headers as a NIP-59 gift-wrap addressed to
// `:pubkey`, and stores it under the hook-wrap prefix where the inbox stream
// (`/v0/inbox/:pubkey/stream`) tails it.
//
// Trust model: the gateway proves nothing about the sender — authenticity is
// established at Sonata, which verifies the provider's own HMAC/bearer against
// the user-configured per-slug secret. The rumor signer here is a throwaway
// key generated per delivery and discarded; no security claim rests on it, so
// there is deliberately no KMS call in this hot path.

import { rateLimitCheck } from "./publish";
import { signEventWithRawKey } from "./lib/sign";
import { wrap } from "./lib/nip17";
import type { NostrEvent, RelayPool } from "./relay-pool";

export const MAX_HOOK_BODY_BYTES = 64 * 1024;

export type HookEnv = {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
};

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function jsonResponse(status: number, body: Record<string, unknown>, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function jsonError(code: string, message: string, status: number, extraHeaders?: Record<string, string>): Response {
  return jsonResponse(status, { error: code, message }, extraHeaders);
}

/**
 * Pattern-based header forwarding (plan rev 2+): forward `x-*`, `svix-*`,
 * and `*-signature`, plus content-type and user-agent — never auth/cookie
 * material or proxy-added x-forwarded-*. Covers GitHub (x-hub-signature-256,
 * x-github-*), AgentMail (x-agentmail-signature), Stripe (stripe-signature),
 * the svix ecosystem, and long-tail providers with custom x- headers.
 */
export function shouldForwardHeader(rawName: string): boolean {
  const name = rawName.toLowerCase();
  if (name === "authorization" || name === "cookie" || name === "set-cookie") return false;
  if (name.startsWith("x-forwarded-")) return false;
  if (name === "content-type" || name === "user-agent") return true;
  if (name.startsWith("x-") || name.startsWith("svix-")) return true;
  if (name.endsWith("-signature")) return true;
  return false;
}

function collectForwardedHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (shouldForwardHeader(name)) out[name.toLowerCase()] = value;
  });
  return out;
}

// btoa over the whole body would need a giant intermediate string built one
// charCode at a time; chunk it. Bodies are ≤64 KiB so this is a few passes.
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function handleHookRequest(
  request: Request,
  pubkey: string,
  slug: string,
  env: HookEnv,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }

  // Body cap, checked twice: content-length up front (cheap reject before
  // reading), then the actual byte count (content-length is client-supplied
  // and absent on chunked encoding).
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_HOOK_BODY_BYTES) {
    return jsonError("payload_too_large", `body exceeds ${MAX_HOOK_BODY_BYTES} bytes`, 413);
  }

  // Dual rate limits: per-hook (pubkey+slug) and per-source-IP.
  const cfIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  for (const key of [`hook:${pubkey}:${slug}`, `hook-ip:${cfIp}`]) {
    const rl = rateLimitCheck(key);
    if (!rl.ok) {
      return jsonError("rate_limited", "hook rate limit exceeded", 429, {
        "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
      });
    }
  }

  // Raw bytes, exactly as sent — mirror of audience-raw.ts. Never parsed.
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return jsonError("bad_request", "could not read request body", 400);
  }
  if (bodyBytes.length > MAX_HOOK_BODY_BYTES) {
    return jsonError("payload_too_large", `body exceeds ${MAX_HOOK_BODY_BYTES} bytes`, 413);
  }

  const receivedAtMs = Date.now();
  const rumorContent = JSON.stringify({
    received_at_ms: receivedAtMs,
    source_ip: cfIp,
    headers: collectForwardedHeaders(request),
    body_b64: bytesToBase64(bodyBytes),
    slug,
  });

  // Throwaway per-delivery signer — discarded after the wrap. The plugin
  // skips seal-signer validation on the hook branch by design.
  const throwawayPriv = crypto.getRandomValues(new Uint8Array(32));
  const rumor = signEventWithRawKey(
    {
      kind: 1069,
      created_at: Math.floor(receivedAtMs / 1000),
      tags: [
        ["fa:hook", slug],
        ["p", pubkey.toLowerCase()],
      ],
      content: rumorContent,
    },
    throwawayPriv,
  );
  const wrapped = wrap(rumor as NostrEvent, throwawayPriv, pubkey.toLowerCase());

  const id = env.RELAY_POOL.idFromName("main");
  const stub = env.RELAY_POOL.get(id);
  const stored = await stub.storeHookWrap(wrapped, pubkey.toLowerCase());
  if (!stored.ok) {
    return jsonError("internal_error", `store failed: ${stored.reason ?? "unknown"}`, 500);
  }

  // 202 only after the store resolved — a crash before this point surfaces
  // as a 5xx/timeout to the provider, whose retry is our recovery path.
  return jsonResponse(202, { ok: true, delivery_id: rumor.id });
}
