// Blossom BUD-01 upload-auth verification.
//
// Per BUD-01 (https://github.com/hzrd149/blossom/blob/master/buds/01.md):
//   - Header format: Authorization: Nostr <base64-of-event-json>
//   - Auth event MUST be kind 24242.
//   - Tags MUST include:
//       ["t", "upload"]               — the action verb
//       ["x", <sha256-hex>]           — the sha256 of the uploaded blob
//       ["expiration", <unix-ts>]     — auth event must not be expired
//   - created_at MUST be within the last 5 minutes (anti-replay).
//   - Signature MUST verify against the canonical NIP-01 event id.
//
// The caller is expected to have already read the request body and computed
// its sha256 separately so it can compare against the `x` tag without
// re-reading the stream here.

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { NostrEvent } from "../relay-pool";

export const BLOSSOM_AUTH_KIND = 24242;
export const BLOSSOM_AUTH_MAX_AGE_SEC = 300;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export type BlossomAuthFailure =
  | { ok: false; status: 401; code: "missing_auth" }
  | { ok: false; status: 401; code: "bad_auth" }
  | { ok: false; status: 401; code: "wrong_kind" }
  | { ok: false; status: 401; code: "stale_auth"; reason: "created_at_too_old" | "expired" }
  | { ok: false; status: 401; code: "wrong_action" }
  | { ok: false; status: 400; code: "invalid_hash" };

export interface BlossomAuthOk {
  ok: true;
  pubkey: string;
  expectedSha256: string;
  authEvent: NostrEvent;
}

export type BlossomAuthResult = BlossomAuthOk | BlossomAuthFailure;

function findTag(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1];
  return undefined;
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

export function parseBlossomAuthHeader(header: string | null): BlossomAuthResult | { ok: true; event: NostrEvent } {
  if (!header) return { ok: false, status: 401, code: "missing_auth" };
  const m = /^Nostr\s+(\S+)\s*$/i.exec(header);
  if (!m) return { ok: false, status: 401, code: "bad_auth" };
  const json = decodeBase64ToString(m[1]!);
  if (json === null) return { ok: false, status: 401, code: "bad_auth" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, status: 401, code: "bad_auth" };
  }
  if (!isValidNostrEvent(parsed)) return { ok: false, status: 401, code: "bad_auth" };
  return { ok: true, event: parsed };
}

export interface VerifyBlossomAuthArgs {
  action: "upload";
  // If provided, the auth event's `x` tag MUST equal this hex (case-insensitive).
  expectedSha256?: string;
  // Override now() — for testing only.
  nowSec?: number;
}

export function verifyBlossomAuth(
  header: string | null,
  args: VerifyBlossomAuthArgs,
): BlossomAuthResult {
  const parsed = parseBlossomAuthHeader(header);
  if (!parsed.ok) return parsed;
  // Type-narrow: a parse-success returns { ok: true; event }.
  const event = (parsed as { ok: true; event: NostrEvent }).event;

  if (event.kind !== BLOSSOM_AUTH_KIND) {
    return { ok: false, status: 401, code: "wrong_kind" };
  }

  const action = findTag(event.tags, "t");
  if (action !== args.action) {
    return { ok: false, status: 401, code: "wrong_action" };
  }

  const xTag = findTag(event.tags, "x");
  if (xTag === undefined || !HEX64.test(xTag.toLowerCase())) {
    return { ok: false, status: 400, code: "invalid_hash" };
  }
  const xHex = xTag.toLowerCase();

  if (args.expectedSha256 !== undefined) {
    if (xHex !== args.expectedSha256.toLowerCase()) {
      return { ok: false, status: 400, code: "invalid_hash" };
    }
  }

  const now = args.nowSec ?? Math.floor(Date.now() / 1000);

  if (now - event.created_at > BLOSSOM_AUTH_MAX_AGE_SEC || event.created_at - now > 60) {
    return { ok: false, status: 401, code: "stale_auth", reason: "created_at_too_old" };
  }

  const expiration = findTag(event.tags, "expiration");
  if (expiration === undefined) {
    return { ok: false, status: 401, code: "stale_auth", reason: "expired" };
  }
  const expSec = Number(expiration);
  if (!Number.isFinite(expSec) || expSec <= now) {
    return { ok: false, status: 401, code: "stale_auth", reason: "expired" };
  }

  const expectedId = canonicalEventId(event);
  if (expectedId !== event.id.toLowerCase()) {
    return { ok: false, status: 401, code: "bad_auth" };
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
    return { ok: false, status: 401, code: "bad_auth" };
  }

  return { ok: true, pubkey: event.pubkey, expectedSha256: xHex, authEvent: event };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(buf));
}
