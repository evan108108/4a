// Profile read surface + identity echo.
//
//   GET /v0/whoami            — JWT → the caller's KMS-derived hex pubkey.
//   GET /v0/profile?author=…  — latest kind 0 (NIP-01 user metadata) for an
//                               author, fetched with a one-shot scoped REQ
//                               against the public relays. `author` accepts
//                               a 64-char hex pubkey OR the composite
//                               `provider:oauth_id` identity, which is
//                               resolved through the SAME KMS derivation the
//                               publish path signs with — one derivation
//                               call site, so composite → hex is consistent
//                               across every event kind.
//
// Kind 0 is deliberately NOT ingested by the RelayPool subscription (it
// would pull every profile on the relay set, not just 4A traffic). A scoped
// one-shot REQ per lookup is cheap, and callers (Evenflow's profileCache)
// hold their own 15-minute cache on top of the 60s edge cache here.

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import { verifyJwt, type AuthEnv } from "./auth";
import { deriveNostrKey, type KmsEnv } from "./kms";
import { RELAYS } from "./relay-pool";

export type ProfileEnv = AuthEnv & KmsEnv;

const KIND_PROFILE = 0;
const RELAY_REQ_TIMEOUT_MS = 2500;
const HEX64 = /^[0-9a-f]{64}$/i;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const JSON_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

// Profile lookups are hot during chip rendering; let the edge absorb
// repeat resolution for a minute.
const PROFILE_CACHE_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=60",
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = JSON_HEADERS): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function jsonError(code: string, message: string, status: number): Response {
  return jsonResponse({ error: code, message }, status);
}

interface RelayEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** NIP-01 id recomputation + schnorr check — same posture as RelayPool ingest. */
function eventIsAuthentic(event: RelayEvent): boolean {
  try {
    const serialized = JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content,
    ]);
    const idBytes = sha256(new TextEncoder().encode(serialized));
    if (bytesToHex(idBytes) !== event.id) return false;
    return schnorr.verify(hexToBytes(event.sig), idBytes, hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

/** One-shot REQ against a single relay: latest kind 0 for `author`, or null. */
async function queryRelayForKind0(relay: string, author: string): Promise<RelayEvent | null> {
  const httpUrl = relay.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  let ws: WebSocket | null = null;
  try {
    const response = await fetch(httpUrl, { headers: { Upgrade: "websocket" } });
    ws = response.webSocket;
    if (!ws) return null;
    ws.accept();

    const subId = `profile-${crypto.randomUUID().slice(0, 8)}`;
    return await new Promise<RelayEvent | null>((resolve) => {
      let best: RelayEvent | null = null;
      const timer = setTimeout(() => resolve(best), RELAY_REQ_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve(best);
      };
      ws!.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          if (!Array.isArray(msg)) return;
          if (msg[0] === "EVENT" && msg[1] === subId) {
            const event = msg[2] as RelayEvent;
            if (
              event.kind === KIND_PROFILE &&
              event.pubkey === author &&
              eventIsAuthentic(event) &&
              (best === null || event.created_at > best.created_at)
            ) {
              best = event;
            }
          }
          if (msg[0] === "EOSE" && msg[1] === subId) done();
        } catch {
          // ignore non-JSON frames
        }
      });
      ws!.addEventListener("close", done);
      ws!.addEventListener("error", done);
      ws!.send(JSON.stringify(["REQ", subId, { kinds: [KIND_PROFILE], authors: [author], limit: 1 }]));
    });
  } catch {
    return null;
  } finally {
    try { ws?.close(); } catch { /* noop */ }
  }
}

/** Latest kind 0 across the relay set — newest created_at wins. */
export async function fetchLatestKind0(author: string): Promise<RelayEvent | null> {
  const results = await Promise.all(RELAYS.map((r) => queryRelayForKind0(r, author)));
  let best: RelayEvent | null = null;
  for (const event of results) {
    if (event !== null && (best === null || event.created_at > best.created_at)) {
      best = event;
    }
  }
  return best;
}

/** Resolve `author` (hex64 or `provider:oauth_id`) to a hex pubkey. */
async function resolveAuthor(author: string, env: ProfileEnv): Promise<string | null> {
  if (HEX64.test(author)) return author.toLowerCase();
  const sep = author.indexOf(":");
  if (sep <= 0 || sep === author.length - 1) return null;
  const identity = { provider: author.slice(0, sep), oauth_id: author.slice(sep + 1) };
  const { secretKey, publicKey } = await deriveNostrKey(identity, env);
  secretKey.fill(0);
  return publicKey;
}

async function handleWhoami(request: Request, env: ProfileEnv): Promise<Response> {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError("unauthorized", "missing Authorization: Bearer <jwt>", 401);
  }
  const claims = await verifyJwt(auth.slice("Bearer ".length).trim(), env);
  if (!claims) return jsonError("unauthorized", "invalid or expired token", 401);

  const { secretKey, publicKey } = await deriveNostrKey(
    { provider: claims.provider, oauth_id: claims.oauth_id },
    env,
  );
  secretKey.fill(0);
  return jsonResponse({ pubkey: publicKey, npub: nip19.npubEncode(publicKey) });
}

async function handleProfileLookup(url: URL, env: ProfileEnv): Promise<Response> {
  const author = url.searchParams.get("author");
  if (author === null || author.length === 0) {
    return jsonError("bad_request", "author is required (hex64 pubkey or provider:oauth_id)", 400);
  }
  let pubkey: string | null;
  try {
    pubkey = await resolveAuthor(author, env);
  } catch (err) {
    return jsonError("internal_error", err instanceof Error ? err.message : "derivation failed", 500);
  }
  if (pubkey === null) {
    return jsonError("bad_request", "author must be a hex64 pubkey or provider:oauth_id", 400);
  }

  const event = await fetchLatestKind0(pubkey);
  // Miss is a 200, not a 404 — bulk resolvers treat "no profile yet" as an
  // empty profile, and the edge caches the miss for the same 60s.
  const body = event === null
    ? { pubkey, event_id: null, content: null, created_at: null, sig: null }
    : { pubkey, event_id: event.id, content: event.content, created_at: event.created_at, sig: event.sig };
  return jsonResponse(body, 200, PROFILE_CACHE_HEADERS);
}

export async function handleProfileApiRequest(request: Request, env: ProfileEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }
  const url = new URL(request.url);
  if (url.pathname === "/v0/whoami") return handleWhoami(request, env);
  if (url.pathname === "/v0/profile") return handleProfileLookup(url, env);
  return jsonError("not_found", `unknown profile path: ${url.pathname}`, 404);
}
