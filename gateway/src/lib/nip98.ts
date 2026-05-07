// NIP-98 HTTP Auth verification.
//
// Per NIP-98 (https://github.com/nostr-protocol/nips/blob/master/98.md):
//   - Header format: Authorization: Nostr <base64-of-event-json>
//   - Auth event MUST be kind 27235.
//   - Tags MUST include `["u", <full-url>]` and `["method", <UPPERCASE>]`.
//   - For requests with a body, the SHA-256 hex of the raw body MUST be
//     in tag ["payload", <hex>].
//   - The event signature MUST verify, and created_at MUST be within
//     ±60s of server clock.
//
// The caller is responsible for pre-reading the request body so this
// function can't double-read the stream.

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { NostrEvent } from "../relay-pool";

export interface Nip98Config {
  readonly maxAgeSec: 60;
}

export interface Nip98VerifiedAuth {
  pubkey: string;
  authEvent: NostrEvent;
}

export type Nip98Failure =
  | { ok: false; status: 401; error: "missing_authorization_header" }
  | { ok: false; status: 401; error: "malformed_authorization_header" }
  | { ok: false; status: 401; error: "invalid_signature" }
  | { ok: false; status: 401; error: "wrong_kind" }
  | { ok: false; status: 401; error: "stale_auth_event" }
  | { ok: false; status: 401; error: "url_mismatch"; expected: string; got: string }
  | { ok: false; status: 401; error: "method_mismatch"; expected: string; got: string }
  | { ok: false; status: 401; error: "payload_hash_mismatch" };

export type Nip98Result = ({ ok: true } & Nip98VerifiedAuth) | Nip98Failure;

const NIP98_KIND = 27235;
const MAX_AGE_SEC = 60;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function findTag(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1];
  return undefined;
}

function normalizeUrl(s: string): string | null {
  try {
    return new URL(s).toString();
  } catch {
    return null;
  }
}

function decodeBase64ToString(b64: string): string | null {
  try {
    return atob(b64);
  } catch {
    return null;
  }
}

function isValidNostrEvent(e: unknown): e is NostrEvent {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  if (typeof r.id !== "string" || !HEX64.test(r.id)) return false;
  if (typeof r.pubkey !== "string" || !HEX64.test(r.pubkey)) return false;
  if (typeof r.sig !== "string" || !HEX128.test(r.sig)) return false;
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

async function sha256HexAsync(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(buf));
}

export async function verifyNip98(
  request: Request,
  body: Uint8Array | undefined,
): Promise<Nip98Result> {
  const headerVal = request.headers.get("authorization");
  if (!headerVal) {
    return { ok: false, status: 401, error: "missing_authorization_header" };
  }
  const m = /^Nostr\s+(\S+)\s*$/i.exec(headerVal);
  if (!m) {
    return { ok: false, status: 401, error: "malformed_authorization_header" };
  }
  const json = decodeBase64ToString(m[1]!);
  if (json === null) {
    return { ok: false, status: 401, error: "malformed_authorization_header" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, status: 401, error: "malformed_authorization_header" };
  }
  if (!isValidNostrEvent(parsed)) {
    return { ok: false, status: 401, error: "malformed_authorization_header" };
  }
  const event = parsed;

  if (event.kind !== NIP98_KIND) {
    return { ok: false, status: 401, error: "wrong_kind" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > MAX_AGE_SEC) {
    return { ok: false, status: 401, error: "stale_auth_event" };
  }

  const uTag = findTag(event.tags, "u");
  const methodTag = findTag(event.tags, "method");
  if (uTag === undefined || methodTag === undefined) {
    return { ok: false, status: 401, error: "malformed_authorization_header" };
  }

  const expectedMethod = request.method.toUpperCase();
  const gotMethod = methodTag.toUpperCase();
  if (expectedMethod !== gotMethod) {
    return {
      ok: false,
      status: 401,
      error: "method_mismatch",
      expected: expectedMethod,
      got: gotMethod,
    };
  }

  const expectedUrl = normalizeUrl(request.url);
  const gotUrl = normalizeUrl(uTag);
  if (expectedUrl === null || gotUrl === null || expectedUrl !== gotUrl) {
    return {
      ok: false,
      status: 401,
      error: "url_mismatch",
      expected: expectedUrl ?? request.url,
      got: gotUrl ?? uTag,
    };
  }

  if (body !== undefined) {
    const payloadTag = findTag(event.tags, "payload");
    if (payloadTag === undefined) {
      return { ok: false, status: 401, error: "malformed_authorization_header" };
    }
    const actualHash = await sha256HexAsync(body);
    if (actualHash !== payloadTag.toLowerCase()) {
      return { ok: false, status: 401, error: "payload_hash_mismatch" };
    }
  }

  const expectedId = canonicalEventId(event);
  if (expectedId !== event.id.toLowerCase()) {
    return { ok: false, status: 401, error: "invalid_signature" };
  }
  let sigOk = false;
  try {
    sigOk = schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { ok: false, status: 401, error: "invalid_signature" };
  }

  return { ok: true, pubkey: event.pubkey, authEvent: event };
}
