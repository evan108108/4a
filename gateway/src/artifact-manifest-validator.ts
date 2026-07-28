// Well-formedness + authorization validator for kind:30540 (ArtifactManifest)
// events — the meaning layer that marks a Blossom blob as a renderable public
// artifact.
//
// Per the public-artifacts plan ("The manifest event schema"): shape, canonical
// id, schnorr signature, required tags (d / blob / type / alt / blake3),
// content JSON, created_at skew, and the anti-hijack invariant that the
// manifest signer IS the blob's uploader (checked against the uploader_pubkey
// R2 customMetadata written at BUD-01 upload).
//
// All checks are pure-function and I/O-free except the injected BlobLookup
// (one R2 head per publish); the gateway and tests inject implementations —
// same dependency-injection style as audience-validator.ts.

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { blake3ContentTag } from "./lib/blake3-tag";
import type { NostrEvent } from "./relay-pool";

export const ARTIFACT_MANIFEST_KIND = 30540;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const D_TAG = /^[A-Za-z0-9_-]{1,64}$/;
const MIME_TYPE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]{0,126}$/;
const MAX_TITLE_CHARS = 200;
// Manifests may not be timestamped more than 15 min in the future — prevents
// pinning an unsupersedeable far-future created_at (replaceable-supersede
// compares created_at in the relay pool).
const MAX_FUTURE_SKEW_SEC = 15 * 60;

/**
 * Blob metadata lookup — R2 head over `blob/<sha256>`. Returns the uploader
 * binding metadata, or null when no such blob exists. Injected so vitest can
 * drive the validator without R2.
 */
export interface BlobLookup {
  headBlob(sha256: string): Promise<{ uploaderPubkey?: string } | null>;
}

export type ManifestValidationResult =
  | { ok: true; event: NostrEvent }
  | { ok: false; status: number; code: string; message: string };

export function findTag(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1];
  return undefined;
}

// Shape check — same pattern as lib/blossom-auth.ts (copied, not imported;
// that module is upload-auth-specific).
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

function fail(status: number, code: string, message: string): ManifestValidationResult {
  return { ok: false, status, code, message };
}

export async function validateArtifactManifest(args: {
  event: unknown;
  blobLookup: BlobLookup;
  // Override now() — for testing only.
  nowSec?: number;
}): Promise<ManifestValidationResult> {
  const { event, blobLookup } = args;

  if (!isValidNostrEvent(event)) {
    return fail(400, "invalid_event", "body.event is not a well-formed Nostr event");
  }
  if (event.kind !== ARTIFACT_MANIFEST_KIND) {
    return fail(400, "wrong_kind", `kind must be ${ARTIFACT_MANIFEST_KIND}, got ${event.kind}`);
  }
  if (canonicalEventId(event) !== event.id.toLowerCase()) {
    return fail(400, "id_mismatch", "event id does not match the canonical NIP-01 id");
  }
  let sigOk = false;
  try {
    sigOk = schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return fail(400, "bad_signature", "schnorr signature verification failed");
  }

  const d = findTag(event.tags, "d");
  if (!d || !D_TAG.test(d)) {
    return fail(400, "bad_d_tag", 'tag "d" missing or not matching ^[A-Za-z0-9_-]{1,64}$');
  }
  const blob = findTag(event.tags, "blob");
  if (!blob || !HEX64.test(blob.toLowerCase())) {
    return fail(400, "bad_blob_tag", 'tag "blob" missing or not a 64-hex sha256');
  }
  const type = findTag(event.tags, "type");
  if (!type || !MIME_TYPE.test(type)) {
    return fail(400, "bad_type_tag", 'tag "type" missing or not a valid MIME type');
  }
  const title = findTag(event.tags, "title");
  if (title !== undefined && title.length > MAX_TITLE_CHARS) {
    return fail(400, "bad_title", `tag "title" exceeds ${MAX_TITLE_CHARS} chars`);
  }
  const alt = findTag(event.tags, "alt");
  if (!alt || alt.length === 0) {
    return fail(400, "missing_alt", 'tag "alt" missing or empty');
  }
  const blake3Tag = findTag(event.tags, "blake3");
  if (!blake3Tag || blake3Tag !== blake3ContentTag(event.content)) {
    return fail(400, "blake3_mismatch", 'tag "blake3" missing or does not match BLAKE3(content)');
  }
  if (event.content !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.content);
    } catch {
      return fail(400, "bad_content", 'content must be "" or a JSON object');
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail(400, "bad_content", 'content must be "" or a JSON object');
    }
  }
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  if (event.created_at - now > MAX_FUTURE_SKEW_SEC) {
    return fail(400, "future_created_at", "created_at is more than 15 minutes in the future");
  }

  // R2-backed checks last — everything above is free, this is a network head.
  const meta = await blobLookup.headBlob(blob.toLowerCase());
  if (!meta) {
    return fail(404, "blob_not_found", `no blob stored for sha256 ${blob.toLowerCase()}`);
  }
  // Anti-hijack invariant: the manifest signer must be the blob's uploader.
  if ((meta.uploaderPubkey ?? "").toLowerCase() !== event.pubkey.toLowerCase()) {
    return fail(403, "not_uploader", "manifest signer is not the uploader of this blob");
  }

  return { ok: true, event };
}
