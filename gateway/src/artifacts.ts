// Public Artifacts endpoints — /v0/artifacts/* on api.4a4.ai.
//
// The gateway stores ciphertext (existing Blossom BUD-01 flow), serves
// ciphertext, and streams a tiny viewer shell that decrypts client-side with
// the URL-fragment key. What this module adds is the meaning layer:
//
//   POST /v0/artifacts/manifest        — publish a kind:30540 manifest
//   POST /v0/artifacts/revoke          — kind:5 (NIP-09) revocation
//   GET  /v0/artifacts/viewer.js       — the shell script (immutable-cached)
//   GET  /v0/artifacts/<sha256>        — frozen-content render
//   GET  /v0/artifacts/<pubkey>/<d>    — latest-version render
//   OPTIONS                            — CORS preflight
//
// Storage is the RelayPool DO (singleton "main"); the artifact-specific DO
// methods land with Task 1 (impl/artifacts-foundation) — the ArtifactPool
// interface below is the agreed contract (dispatcher-confirmed 2026-07-28:
// `manifestIds` naming; 4-param getArtifactRevocation; `artifactid:` stores
// the FULL manifest event and getArtifactManifest(eventId) retrieves it, so
// the frozen URL renders the superseded version's own metadata and its
// NIP-09 created_at comparison survives replaceable supersede).

import { rateLimitCheck } from "./publish";
import {
  ARTIFACT_MANIFEST_KIND,
  findTag,
  validateArtifactManifest,
  type BlobLookup,
} from "./artifact-manifest-validator";
import {
  ARTIFACT_VIEWER_CSP,
  renderViewerHtml,
  VIEWER_JS,
  type ArtifactViewerManifest,
} from "./artifact-viewer";
import type {
  ArtifactRevocationResolution,
  NostrEvent,
  RelayPool,
} from "./relay-pool";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export const REVOCATION_KIND = 5;

const PUBLIC_HOST = "api.4a4.ai";
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const FROZEN_PATH = /^\/v0\/artifacts\/([0-9a-f]{64})$/;
const LATEST_PATH = /^\/v0\/artifacts\/([0-9a-f]{64})\/([A-Za-z0-9_-]{1,64})$/;
const ADDRESS_TAG = /^30540:([0-9a-f]{64}):([A-Za-z0-9_-]{1,64})$/;

export type ArtifactsEnv = {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
  STORAGE: R2Bucket;
};

// The DO namespace stub proxies RelayPool's public methods with typed
// signatures; the artifact methods live on RelayPool itself (relay-pool.ts).
function getPool(env: ArtifactsEnv): DurableObjectStub<RelayPool> {
  return env.RELAY_POOL.get(env.RELAY_POOL.idFromName("main"));
}

// ── Response helpers (webhook-receiver conventions) ─────────────────────────

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

// Read-API convention (api.ts): 30s edge cache so revocation propagates within
// ~30s. The CSP rides on EVERY render-path response — including 404/410 pages —
// so no path serves manifest-derived strings unprotected.
const RENDER_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=30",
  "Content-Security-Policy": ARTIFACT_VIEWER_CSP,
  "Access-Control-Allow-Origin": "*",
};

const PREFLIGHT_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function jsonError(
  code: string,
  message: string,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return jsonResponse(status, { error: code, message }, extraHeaders);
}

// Minimal static error page. Only interpolates values already reduced to safe
// character classes (hex, ISO dates, fixed strings) — no manifest-derived
// free text reaches this template.
function htmlErrorResponse(status: number, headline: string, detail: string): Response {
  const body =
    `<!doctype html><html><head><meta charset="utf-8"><title>${status} — 4a artifact</title></head>` +
    `<body><h1>${status} ${headline}</h1><p>${detail}</p></body></html>`;
  return new Response(body, { status, headers: RENDER_HEADERS });
}

// ── Shared event plumbing ───────────────────────────────────────────────────

function isValidNostrEvent(e: unknown): e is NostrEvent {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  if (typeof r.id !== "string" || !HEX64.test(r.id)) return false;
  if (typeof r.pubkey !== "string" || !HEX64.test(r.pubkey.toLowerCase())) return false;
  if (typeof r.sig !== "string" || !HEX128.test(r.sig.toLowerCase())) return false;
  if (typeof r.created_at !== "number" || !Number.isFinite(r.created_at)) return false;
  if (typeof r.kind !== "number" || !Number.isInteger(r.kind)) return false;
  if (typeof r.content !== "string") return false;
  if (!Array.isArray(r.tags)) return false;
  for (const t of r.tags) {
    if (!Array.isArray(t)) return false;
    for (const v of t) if (typeof v !== "string") return false;
  }
  return true;
}

function canonicalEventId(e: NostrEvent): string {
  const ser = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  return bytesToHex(sha256(new TextEncoder().encode(ser)));
}

function verifyEventSig(e: NostrEvent): boolean {
  try {
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

async function readEventBody(request: Request): Promise<{ event: unknown } | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("bad_request", "body must be JSON", 400);
  }
  const event = (body as Record<string, unknown> | null)?.event;
  if (event === undefined) {
    return jsonError("missing_event", "body must be {event}", 400);
  }
  return { event };
}

function frozenUrl(sha: string): string {
  return `https://${PUBLIC_HOST}/v0/artifacts/${sha}`;
}

function latestUrl(pubkey: string, d: string): string {
  return `https://${PUBLIC_HOST}/v0/artifacts/${pubkey}/${d}`;
}

// ── POST /v0/artifacts/manifest ─────────────────────────────────────────────

async function handleManifestPublish(request: Request, env: ArtifactsEnv): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }
  const parsed = await readEventBody(request);
  if (parsed instanceof Response) return parsed;

  // Rate limit before the expensive schnorr/R2 work. Key on the claimed
  // pubkey when one is present; a garbage pubkey fails validation right after.
  const claimedPubkey = (parsed.event as Record<string, unknown> | null)?.pubkey;
  if (typeof claimedPubkey === "string" && claimedPubkey.length > 0) {
    const rl = rateLimitCheck(`artifact-manifest:${claimedPubkey.toLowerCase()}`);
    if (!rl.ok) {
      return jsonError("rate_limited", "manifest publish rate limit exceeded", 429, {
        "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
      });
    }
  }

  const blobLookup: BlobLookup = {
    async headBlob(sha) {
      const head = await env.STORAGE.head(`blob/${sha}`);
      if (!head) return null;
      return { uploaderPubkey: head.customMetadata?.uploader_pubkey };
    },
  };
  const result = await validateArtifactManifest({ event: parsed.event, blobLookup });
  if (!result.ok) {
    return jsonError(result.code, result.message, result.status);
  }
  const event = result.event;
  const d = findTag(event.tags, "d")!;
  const blobSha = findTag(event.tags, "blob")!.toLowerCase();
  const pubkey = event.pubkey.toLowerCase();

  const stored = await getPool(env).storeArtifactManifest(event);
  if (!stored.ok) {
    return jsonError("internal_error", `store failed: ${stored.reason ?? "unknown"}`, 500);
  }
  // Order matters: a stale (older-created_at) publish also reports bound=false,
  // but the caller's problem is "you sent stale data", not a binding conflict.
  if (stored.superseded) {
    return jsonResponse(409, {
      error: "superseded",
      message: "an equal-or-newer manifest already exists at this address",
      latest_url: latestUrl(pubkey, d),
    });
  }
  if (!stored.bound) {
    // The frozen URL for this sha already belongs to another (pubkey, d).
    // The manifest itself stored fine — the d-tag URL still works.
    return jsonResponse(409, {
      error: "blob_already_bound",
      message: "this blob's frozen URL is already bound to another manifest address",
      latest_url: latestUrl(pubkey, d),
    });
  }
  return jsonResponse(200, {
    ok: true,
    superseded: false,
    frozen_url: frozenUrl(blobSha),
    latest_url: latestUrl(pubkey, d),
  });
}

// ── POST /v0/artifacts/revoke ───────────────────────────────────────────────

async function handleRevoke(request: Request, env: ArtifactsEnv): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }
  const parsed = await readEventBody(request);
  if (parsed instanceof Response) return parsed;
  const event = parsed.event;
  if (!isValidNostrEvent(event)) {
    return jsonError("invalid_event", "body.event is not a well-formed Nostr event", 400);
  }
  if (event.kind !== REVOCATION_KIND) {
    return jsonError("wrong_kind", `kind must be ${REVOCATION_KIND}, got ${event.kind}`, 400);
  }
  if (canonicalEventId(event) !== event.id.toLowerCase()) {
    return jsonError("id_mismatch", "event id does not match the canonical NIP-01 id", 400);
  }
  if (!verifyEventSig(event)) {
    return jsonError("bad_signature", "schnorr signature verification failed", 400);
  }
  const signer = event.pubkey.toLowerCase();
  const rl = rateLimitCheck(`artifact-revoke:${signer}`);
  if (!rl.ok) {
    return jsonError("rate_limited", "revoke rate limit exceeded", 429, {
      "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
    });
  }

  const pool = getPool(env);
  const revoked: string[][] = [];
  const skipped: { tag: string[]; reason: string }[] = [];
  const resolved: ArtifactRevocationResolution = { manifestIds: [], addresses: [] };

  for (const tag of event.tags) {
    if (tag[0] === "e") {
      // Version-level: revokes exactly that manifest event, unconditionally.
      const id = tag[1]?.toLowerCase();
      if (!id || !HEX64.test(id)) {
        skipped.push({ tag, reason: "malformed_tag" });
        continue;
      }
      const manifest = await pool.getArtifactManifest(id);
      if (!manifest) {
        skipped.push({ tag, reason: "unknown_manifest" });
        continue;
      }
      if (manifest.pubkey.toLowerCase() !== signer) {
        skipped.push({ tag, reason: "not_owner" });
        continue;
      }
      resolved.manifestIds.push(id);
      revoked.push(tag);
    } else if (tag[0] === "a") {
      // Address-level: NIP-09 time semantics — suppresses manifests with
      // created_at <= this kind:5's; a later republish supersedes it.
      const m = ADDRESS_TAG.exec(tag[1] ?? "");
      if (!m) {
        skipped.push({ tag, reason: "malformed_tag" });
        continue;
      }
      const pubkey = m[1]!.toLowerCase();
      const d = m[2]!;
      if (pubkey !== signer) {
        skipped.push({ tag, reason: "not_owner" });
        continue;
      }
      const manifest = await pool.getObject(ARTIFACT_MANIFEST_KIND, pubkey, d);
      if (!manifest) {
        skipped.push({ tag, reason: "unknown_manifest" });
        continue;
      }
      resolved.addresses.push({ pubkey, d });
      revoked.push(tag);
    }
    // Other tags (k, alt, ...) are legitimate on kind:5 — ignored, not "skipped".
  }

  if (resolved.manifestIds.length > 0 || resolved.addresses.length > 0) {
    const stored = await pool.storeArtifactRevocation(event, resolved);
    if (!stored.ok) {
      return jsonError("internal_error", `store failed: ${stored.reason ?? "unknown"}`, 500);
    }
  }
  return jsonResponse(200, { revoked, skipped });
}

// ── GET /v0/artifacts/viewer.js ─────────────────────────────────────────────

// The shell's script tag query param uses artifact-viewer.ts's own
// VIEWER_JS_HASH (fnv1a of VIEWER_JS, computed at export time and pre-inlined
// into VIEWER_HTML). Nothing to compute here.

function handleViewerJs(request: Request): Response {
  if (request.method !== "GET") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }
  return new Response(VIEWER_JS, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ── Render pipeline (both URL shapes) ───────────────────────────────────────

function goneResponse(rev: { by?: string; at?: number }): Response {
  // Attribution values are reduced to safe character classes before they
  // touch the template: pubkey to hex, timestamp to an ISO string.
  const by = (rev.by ?? "").replace(/[^0-9a-f]/gi, "") || "unknown";
  const at =
    typeof rev.at === "number" ? new Date(rev.at * 1000).toISOString() : "an unknown time";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>410 — artifact revoked</title></head>` +
      `<body><h1>410 Gone</h1><p>This artifact was revoked by <code>${by}</code> on ${at}.</p></body></html>`,
    { status: 410, headers: RENDER_HEADERS },
  );
}

function renderShell(meta: {
  sha256: string;
  pubkey: string;
  d: string;
  title: string | null;
  type: string;
  created_at: number;
  event_id: string;
  mode: "frozen" | "latest";
}): Response {
  // Delegate to artifact-viewer.ts's renderViewerHtml — it does the JSON
  // encoding (with `<` → < AND U+2028/U+2029 escapes) and slot
  // substitution via a function-replacement, which sidesteps the String.replace
  // `$&`/`$'`/`$\`` footgun that a string replacement would expose.
  const viewerManifest: ArtifactViewerManifest = {
    sha256: meta.sha256,
    type: meta.type,
    pubkey: meta.pubkey,
    title: meta.title ?? undefined,
    publishedAt: meta.created_at,
    d: meta.d,
    frozen: meta.mode === "frozen",
    event_id: meta.event_id,
  };
  return new Response(renderViewerHtml(viewerManifest), {
    status: 200,
    headers: RENDER_HEADERS,
  });
}

// Both URL shapes converge here once a manifest is resolved: revocation is
// checked against the manifest ABOUT TO BE RENDERED (its id + created_at) —
// for the frozen path that's the historical snapshot, so a superseded v1
// stays revocable and an address revocation between v1 and v2 keeps
// suppressing the frozen v1 URL even after v2 un-revokes the d-tag URL.
async function renderResolvedManifest(
  env: ArtifactsEnv,
  manifest: NostrEvent,
  sha: string,
  mode: "frozen" | "latest",
): Promise<Response> {
  const pubkey = manifest.pubkey.toLowerCase();
  const d = findTag(manifest.tags, "d") ?? "";
  const rev = await getPool(env).getArtifactRevocation(
    manifest.id,
    pubkey,
    d,
    manifest.created_at,
  );
  if (rev.revoked) return goneResponse(rev);
  // Blob-existence backstop ("404 if blob since deleted").
  const head = await env.STORAGE.head(`blob/${sha}`);
  if (!head) {
    return htmlErrorResponse(404, "Not Found", "The artifact's content blob no longer exists.");
  }
  return renderShell({
    sha256: sha,
    pubkey,
    d,
    title: findTag(manifest.tags, "title") ?? null,
    type: findTag(manifest.tags, "type") ?? "application/octet-stream",
    created_at: manifest.created_at,
    event_id: manifest.id,
    mode,
  });
}

async function handleFrozenRender(env: ArtifactsEnv, sha: string): Promise<Response> {
  const pool = getPool(env);
  const binding = await pool.getArtifactBlobBinding(sha);
  if (!binding) {
    return htmlErrorResponse(404, "Not Found", "No artifact is bound to this hash.");
  }
  // Historical snapshot, NOT the latest at the address — the frozen URL
  // renders the bound version's own metadata even after supersede.
  const manifest = await pool.getArtifactManifest(binding.eventId);
  if (!manifest) {
    return htmlErrorResponse(404, "Not Found", "The artifact's manifest no longer exists.");
  }
  return renderResolvedManifest(env, manifest, sha, "frozen");
}

async function handleLatestRender(env: ArtifactsEnv, pubkey: string, d: string): Promise<Response> {
  const pool = getPool(env);
  const manifest = await pool.getObject(ARTIFACT_MANIFEST_KIND, pubkey, d);
  if (!manifest) {
    return htmlErrorResponse(404, "Not Found", "No artifact is published at this address.");
  }
  const sha = findTag(manifest.tags, "blob")?.toLowerCase();
  if (!sha || !HEX64.test(sha)) {
    return htmlErrorResponse(404, "Not Found", "The artifact's manifest carries no blob.");
  }
  return renderResolvedManifest(env, manifest, sha, "latest");
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

export async function handleArtifactsRequest(request: Request, env: ArtifactsEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
  }
  if (url.pathname === "/v0/artifacts/manifest") {
    return handleManifestPublish(request, env);
  }
  if (url.pathname === "/v0/artifacts/revoke") {
    return handleRevoke(request, env);
  }
  if (url.pathname === "/v0/artifacts/viewer.js") {
    return handleViewerJs(request);
  }
  const frozen = FROZEN_PATH.exec(url.pathname);
  if (frozen) {
    if (request.method !== "GET") {
      return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
    }
    return handleFrozenRender(env, frozen[1]!);
  }
  const latest = LATEST_PATH.exec(url.pathname);
  if (latest) {
    if (request.method !== "GET") {
      return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
    }
    return handleLatestRender(env, latest[1]!.toLowerCase(), latest[2]!);
  }
  return jsonError("not_found", "no such artifacts endpoint", 404);
}
