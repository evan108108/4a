// 4A read API — public read endpoints served on api.4a4.ai/v0/*.
//
// Data source is the RelayPool DO (singleton id "main") which holds verified
// 4A events. Read endpoints are cacheable (max-age=30) and CORS-open.

import { nip19 } from "nostr-tools";
import { RELAYS } from "./relay-pool";
import type { NostrEvent, QueryFilter, RelayPool } from "./relay-pool";

interface ApiEnv {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
}

const KIND_BY_NAME: Record<string, number> = {
  observation: 30500,
  claim: 30501,
  entity: 30502,
  relation: 30503,
  commons: 30504,
};

const VALID_KINDS = new Set(Object.values(KIND_BY_NAME));

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const HEX64 = /^[0-9a-f]{64}$/i;

const JSON_HEADERS: HeadersInit = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=30",
  "Access-Control-Allow-Origin": "*",
  Vary: "Accept",
};

const CORS_PREFLIGHT_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: code, message }, status);
}

function getPool(env: ApiEnv): DurableObjectStub<RelayPool> {
  const id = env.RELAY_POOL.idFromName("main");
  return env.RELAY_POOL.get(id);
}

// Accepts a 64-char hex pubkey or an npub bech32; returns lowercase hex or null.
function normalizePubkey(input: string): string | null {
  if (HEX64.test(input)) return input.toLowerCase();
  if (input.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(input);
      if (decoded.type === "npub" && typeof decoded.data === "string") return decoded.data;
    } catch {
      return null;
    }
  }
  return null;
}

export async function handleApiRequest(request: Request, env: ApiEnv): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
  }
  if (method !== "GET" && method !== "HEAD") {
    return errorResponse("method_not_allowed", `${method} not allowed`, 405);
  }

  const path = url.pathname;
  if (path === "/v0/query") return handleQuery(url, env);
  if (path === "/v0/commons") return handleCommons(env);
  if (path === "/v0/health") return handleHealth(env);
  if (path.startsWith("/v0/object/")) {
    return handleObject(path.slice("/v0/object/".length), env);
  }

  return errorResponse("not_found", `unknown endpoint: ${path}`, 404);
}

async function handleQuery(url: URL, env: ApiEnv): Promise<Response> {
  const params = url.searchParams;
  const filter: QueryFilter = {};

  const kindParam = params.get("kind");
  if (kindParam !== null) {
    const kind = KIND_BY_NAME[kindParam.toLowerCase()];
    if (kind === undefined) {
      return errorResponse(
        "bad_request",
        `unknown kind '${kindParam}' — try observation|claim|entity|relation|commons`,
        400,
      );
    }
    filter.kind = kind;
  }

  const author = params.get("author");
  if (author !== null) {
    const hex = normalizePubkey(author);
    if (!hex) return errorResponse("bad_request", `author must be a 64-char hex pubkey or npub1...`, 400);
    filter.author = hex;
  }

  const about = params.get("about");
  if (about !== null) {
    if (about.length === 0) return errorResponse("bad_request", `about must be non-empty`, 400);
    filter.about = about;
  }

  const topic = params.get("topic");
  if (topic !== null) {
    if (topic.length === 0) return errorResponse("bad_request", `topic must be non-empty`, 400);
    filter.topic = topic;
  }

  const limitParam = params.get("limit");
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return errorResponse("bad_request", `limit must be an integer in 1..${MAX_LIMIT}`, 400);
    }
    filter.limit = n;
  } else {
    filter.limit = DEFAULT_LIMIT;
  }

  const events = await getPool(env).query(filter);
  return jsonResponse({ events, count: events.length, queriedAt: new Date().toISOString() });
}

async function handleObject(rawAddress: string, env: ApiEnv): Promise<Response> {
  let address: string;
  try {
    address = decodeURIComponent(rawAddress);
  } catch {
    return errorResponse("bad_request", `address has invalid percent-encoding`, 400);
  }
  const firstColon = address.indexOf(":");
  const secondColon = address.indexOf(":", firstColon + 1);
  if (firstColon < 0 || secondColon < 0) {
    return errorResponse("bad_request", `address must be kind:pubkey:d-tag`, 400);
  }
  const kindStr = address.slice(0, firstColon);
  const pubkey = address.slice(firstColon + 1, secondColon);
  const d = address.slice(secondColon + 1);

  const kind = Number(kindStr);
  if (!Number.isInteger(kind) || !VALID_KINDS.has(kind)) {
    return errorResponse("bad_request", `unknown kind '${kindStr}' — must be 30500..30504`, 400);
  }
  const pubkeyHex = normalizePubkey(pubkey);
  if (!pubkeyHex) return errorResponse("bad_request", `pubkey must be 64-char hex or npub1...`, 400);
  if (!d) return errorResponse("bad_request", `d-tag is required`, 400);

  const event: NostrEvent | null = await getPool(env).getObject(kind, pubkeyHex, d);
  if (!event) return errorResponse("not_found", `no event at ${kind}:${pubkeyHex}:${d}`, 404);
  return jsonResponse(event);
}

async function handleCommons(env: ApiEnv): Promise<Response> {
  const commons = await getPool(env).listCommons();
  return jsonResponse({ commons, count: commons.length });
}

async function handleHealth(env: ApiEnv): Promise<Response> {
  const stats = await getPool(env).stats();
  return jsonResponse({
    status: "ok",
    version: "0.0.1",
    relays: stats.relays,
    eventCount: stats.eventCount,
  });
}

export { RELAYS };
