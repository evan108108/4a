// Credibility lookup — GET /v0/credibility/:pubkey on api.4a4.ai
//
// Fetches NIP-85 trusted assertions (kind 30382) about a pubkey from a
// configured aggregator relay. The aggregator publishes signed score events;
// we just surface them. Consumers (the MCP wrapper, ChatGPT GPT, etc.)
// interpret the scores.
//
// Defaults to wss://relay.nostr.band. A per-isolate in-memory cache (5 min TTL)
// avoids re-querying the relay on every request — fine for v0 since CF Workers
// keep an isolate alive across requests on the same instance.

import { nip19 } from "nostr-tools";

const DEFAULT_AGGREGATOR_RELAY = "wss://relay.nostr.band";
const NIP85_KIND = 30382;
const QUERY_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 5 * 60 * 1_000;

const HEX64 = /^[0-9a-f]{64}$/i;

const JSON_HEADERS: HeadersInit = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=30",
  "Access-Control-Allow-Origin": "*",
  Vary: "Accept",
};

interface NostrEventLike {
  pubkey?: unknown;
  created_at?: unknown;
  kind?: unknown;
  tags?: unknown;
}

interface AssertionEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
}

interface Score {
  aggregator: string;
  kind: number;
  namespace: string;
  score: number;
  publishedAt: number;
}

interface CredibilityResponse {
  pubkey: string;
  scores: Score[];
  queriedAt: string;
  source: string;
  warning?: string;
}

interface CacheEntry {
  value: CredibilityResponse;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// Returns lowercase 64-char hex pubkey or null. Accepts hex or npub bech32.
export function normalizePubkey(input: string): string | null {
  const trimmed = input.trim();
  if (HEX64.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.toLowerCase().startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub" && typeof decoded.data === "string") return decoded.data;
    } catch {
      return null;
    }
  }
  return null;
}

function isAssertionEvent(value: unknown): value is AssertionEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as NostrEventLike;
  if (typeof e.pubkey !== "string" || !HEX64.test(e.pubkey)) return false;
  if (typeof e.created_at !== "number") return false;
  if (typeof e.kind !== "number") return false;
  if (!Array.isArray(e.tags)) return false;
  for (const t of e.tags as unknown[]) {
    if (!Array.isArray(t)) return false;
  }
  return true;
}

function eventToScore(event: AssertionEvent): Score {
  let score = 0;
  let namespace = "";
  for (const tag of event.tags) {
    const [name, value] = tag;
    if (!value) continue;
    if (name === "rank" || name === "s") {
      const n = parseFloat(value);
      if (!Number.isNaN(n)) score = n;
    } else if ((name === "t" || name === "L") && !namespace) {
      namespace = value;
    } else if (name === "l" && !namespace && tag[2]) {
      namespace = tag[2];
    }
  }
  return {
    aggregator: event.pubkey,
    kind: event.kind,
    namespace,
    score,
    publishedAt: event.created_at,
  };
}

async function fetchAssertions(
  pubkeyHex: string,
  relayUrl: string,
  timeoutMs: number,
): Promise<AssertionEvent[]> {
  const httpUrl = relayUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  const response = await fetch(httpUrl, { headers: { Upgrade: "websocket" } });
  const ws = response.webSocket;
  if (!ws) throw new Error(`relay ${relayUrl} did not upgrade to WebSocket`);
  ws.accept();

  const subId = "cred-" + Math.random().toString(36).slice(2, 10);
  const events: AssertionEvent[] = [];

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);

    ws.addEventListener("message", (ev: MessageEvent) => {
      let parsed: unknown;
      try {
        const text =
          typeof ev.data === "string"
            ? ev.data
            : new TextDecoder().decode(ev.data as ArrayBuffer);
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed.length < 2) return;
      const [type, replySubId, payload] = parsed as [string, string, unknown];
      if (replySubId !== subId) return;
      if (type === "EVENT" && isAssertionEvent(payload) && payload.kind === NIP85_KIND) {
        events.push(payload);
      } else if (type === "EOSE" || type === "CLOSED") {
        finish();
      }
    });
    ws.addEventListener("close", finish);
    ws.addEventListener("error", finish);

    try {
      ws.send(
        JSON.stringify(["REQ", subId, { kinds: [NIP85_KIND], "#p": [pubkeyHex] }]),
      );
    } catch {
      finish();
    }
  });

  return events;
}

function relayHostnameAsSource(relayUrl: string): string {
  try {
    return new URL(relayUrl).hostname;
  } catch {
    return relayUrl;
  }
}

export async function handleCredibility(
  request: Request,
  rawPubkey: string,
  relayUrl: string = DEFAULT_AGGREGATOR_RELAY,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Accept, Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "method_not_allowed", message: `${request.method} not allowed` }),
      { status: 405, headers: { ...JSON_HEADERS, Allow: "GET, OPTIONS" } },
    );
  }

  const pubkey = normalizePubkey(rawPubkey);
  if (!pubkey) {
    return new Response(
      JSON.stringify({
        error: "bad_request",
        message: "pubkey must be a 64-char hex string or a valid npub bech32",
      }),
      { status: 400, headers: JSON_HEADERS },
    );
  }

  const source = relayHostnameAsSource(relayUrl);
  const cacheKey = `${relayUrl}|${pubkey}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return new Response(JSON.stringify(cached.value), { status: 200, headers: JSON_HEADERS });
  }

  let scores: Score[] = [];
  let warning: string | undefined;
  try {
    const events = await fetchAssertions(pubkey, relayUrl, QUERY_TIMEOUT_MS);
    scores = events.map(eventToScore);
  } catch (err) {
    warning = `aggregator_unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }

  const body: CredibilityResponse = {
    pubkey,
    scores,
    queriedAt: new Date().toISOString(),
    source,
    ...(warning ? { warning } : {}),
  };

  cache.set(cacheKey, { value: body, expiresAt: now + CACHE_TTL_MS });

  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}
