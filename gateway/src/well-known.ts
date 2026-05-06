// 4A NIP-05 directory + `fa` extension handler.
//
// Per SPEC-v0.5 §7, the gateway serves `/.well-known/nostr.json` with the
// stock NIP-05 shape (`names`, `relays`) plus the optional `fa` extension
// keyed by pubkey to audience metadata.
//
// v0.5 first-pass: the gateway has no user-directory database. We serve a
// minimal valid response and let the deployment override the contents via
// the `NOSTR_DIRECTORY_JSON` env var (a JSON string). The validator
// (validateNostrJson) is what runs in CI.
//
// NOTE: ?name=<n> filters the `names` and `fa` maps to entries pertaining
// to that name's pubkey, per NIP-05.

const FA_CONTEXT_V0 = "https://4a4.ai/ns/v0";
const HEX64 = /^[0-9a-f]{64}$/i;
const SLUG = /^[A-Za-z0-9-]+$/;
const NAME = /^[a-z0-9_.\-]+$/i;

export interface FaEntry {
  audiences: string[];
  context: string;
}

export interface NostrDirectory {
  names: Record<string, string>;
  relays?: Record<string, string[]>;
  fa?: Record<string, FaEntry>;
}

const EMPTY_DIRECTORY: NostrDirectory = {
  names: {},
  relays: {},
  fa: {},
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Accept",
  "Access-Control-Max-Age": "86400",
};

const JSON_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=60",
};

export interface NostrDirectoryEnv {
  /** Optional override: JSON string of the full directory shape. */
  NOSTR_DIRECTORY_JSON?: string;
}

function parseDirectory(env: NostrDirectoryEnv): NostrDirectory {
  if (!env.NOSTR_DIRECTORY_JSON) return EMPTY_DIRECTORY;
  try {
    const parsed = JSON.parse(env.NOSTR_DIRECTORY_JSON) as unknown;
    const validated = validateNostrJson(parsed);
    if (validated.ok) return validated.value;
  } catch {
    // fall through
  }
  return EMPTY_DIRECTORY;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Validate the v0.5 §7.4 invariants on a parsed nostr.json body.
 */
export function validateNostrJson(raw: unknown): ValidationResult<NostrDirectory> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const r = raw as Record<string, unknown>;
  const names = r.names;
  if (!names || typeof names !== "object" || Array.isArray(names)) {
    return { ok: false, error: 'must include a "names" object' };
  }
  const namesMap: Record<string, string> = {};
  for (const [name, pub] of Object.entries(names as Record<string, unknown>)) {
    if (!NAME.test(name)) return { ok: false, error: `name "${name}" invalid` };
    if (typeof pub !== "string" || !HEX64.test(pub)) {
      return { ok: false, error: `names["${name}"] must be 32-byte hex` };
    }
    namesMap[name] = pub.toLowerCase();
  }

  const relaysMap: Record<string, string[]> = {};
  if (r.relays !== undefined) {
    if (!r.relays || typeof r.relays !== "object" || Array.isArray(r.relays)) {
      return { ok: false, error: '"relays" must be an object' };
    }
    for (const [pub, urls] of Object.entries(r.relays as Record<string, unknown>)) {
      if (!HEX64.test(pub)) return { ok: false, error: `relays["${pub}"] not 32-byte hex` };
      if (!Array.isArray(urls)) {
        return { ok: false, error: `relays["${pub}"] must be a string array` };
      }
      const list: string[] = [];
      for (const u of urls) {
        if (typeof u !== "string" || u.length === 0) {
          return { ok: false, error: `relays["${pub}"] must be a string array` };
        }
        list.push(u);
      }
      relaysMap[pub.toLowerCase()] = list;
    }
  }

  const faMap: Record<string, FaEntry> = {};
  if (r.fa !== undefined) {
    if (!r.fa || typeof r.fa !== "object" || Array.isArray(r.fa)) {
      return { ok: false, error: '"fa" must be an object' };
    }
    const namesPubs = new Set(Object.values(namesMap));
    for (const [pub, entry] of Object.entries(r.fa as Record<string, unknown>)) {
      if (!HEX64.test(pub)) return { ok: false, error: `fa["${pub}"] not 32-byte hex` };
      if (!namesPubs.has(pub.toLowerCase())) {
        return { ok: false, error: `fa["${pub}"] does not appear in names` };
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, error: `fa["${pub}"] must be an object` };
      }
      const e = entry as Record<string, unknown>;
      const auds = e.audiences;
      if (!Array.isArray(auds)) return { ok: false, error: `fa["${pub}"].audiences must be an array` };
      const audsList: string[] = [];
      for (const s of auds) {
        if (typeof s !== "string" || !SLUG.test(s)) {
          return { ok: false, error: `fa["${pub}"].audiences entry not a valid slug` };
        }
        audsList.push(s);
      }
      const ctx = e.context;
      if (typeof ctx !== "string" || ctx !== FA_CONTEXT_V0) {
        return { ok: false, error: `fa["${pub}"].context must equal ${FA_CONTEXT_V0}` };
      }
      faMap[pub.toLowerCase()] = { audiences: audsList, context: ctx };
    }
  }

  return {
    ok: true,
    value: { names: namesMap, relays: relaysMap, fa: faMap },
  };
}

function filterToName(dir: NostrDirectory, name: string): NostrDirectory {
  const targetPub = dir.names[name];
  if (!targetPub) return { names: {}, relays: {}, fa: {} };
  const out: NostrDirectory = { names: { [name]: targetPub }, relays: {}, fa: {} };
  if (dir.relays && dir.relays[targetPub]) out.relays![targetPub] = dir.relays[targetPub];
  if (dir.fa && dir.fa[targetPub]) out.fa![targetPub] = dir.fa[targetPub];
  return out;
}

export function handleWellKnownNostrJson(
  request: Request,
  env: NostrDirectoryEnv,
): Response {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
  }
  const url = new URL(request.url);
  const name = url.searchParams.get("name");

  let dir = parseDirectory(env);
  if (name) dir = filterToName(dir, name);

  const body = JSON.stringify(dir);
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: JSON_HEADERS });
  }
  return new Response(body, { status: 200, headers: JSON_HEADERS });
}
