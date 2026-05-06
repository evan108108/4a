// Well-formedness validator for kind:30510-30514 (encrypted variants).
//
// Per SPEC-v0.5 §3.6 — checks tag shape, BLAKE3-of-ciphertext, and the
// invariant that the `p`-tag set equals the current declaration's member
// set (the publisher MUST address every current member; missing or extra
// `p` tags are a publish-time error).
//
// Note: these events MUST NOT be published bare — they are wrapped in
// kind:1059 gift-wraps before fan-out per §4. This validator is run at
// rumor-build time inside the publish path; the wire-level check that the
// rumor never escaped a wrap is enforced by the §4.5 gift-wrap validator
// rejecting bare 30510-30514 deliveries.

import type { AudienceLookup } from "./audience-validator";
import { blake3ContentTag } from "./lib/blake3-tag";
import { isStructurallyValid as nip44IsStructurallyValid } from "./lib/nip44";
import type { NostrEvent } from "./relay-pool";

export const ENCRYPTED_VARIANT_KINDS = [30510, 30511, 30512, 30513, 30514] as const;
type EncryptedVariantKind = (typeof ENCRYPTED_VARIANT_KINDS)[number];

const FA_CONTEXT_V0 = "https://4a4.ai/ns/v0";
const HEX64 = /^[0-9a-f]{64}$/i;
const ADDRESS_PATTERN = /^30520:[0-9a-f]{64}:[A-Za-z0-9-]+$/;

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

function findTag(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1];
  return undefined;
}

function findAllTags(tags: string[][], name: string): string[] {
  const out: string[] = [];
  for (const t of tags) if (t[0] === name && typeof t[1] === "string") out.push(t[1]);
  return out;
}

function setEqualLower(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a.map((x) => x.toLowerCase()));
  for (const x of b) if (!setA.has(x.toLowerCase())) return false;
  return true;
}

export function validateEncryptedVariantEvent(
  event: NostrEvent,
  lookup: AudienceLookup,
): ValidationResult {
  if (!ENCRYPTED_VARIANT_KINDS.includes(event.kind as EncryptedVariantKind)) {
    return {
      ok: false,
      error: `kind ${event.kind} not in encrypted-variant range 30510-30514`,
    };
  }
  const dTag = findTag(event.tags, "d");
  if (!dTag || dTag.length === 0) {
    return { ok: false, error: 'tag "d" missing' };
  }
  const faContext = findTag(event.tags, "fa:context");
  if (faContext !== FA_CONTEXT_V0) {
    return { ok: false, error: `fa:context must equal "${FA_CONTEXT_V0}"` };
  }
  const altTag = findTag(event.tags, "alt");
  if (!altTag || altTag.length === 0) {
    return { ok: false, error: 'tag "alt" missing or empty' };
  }
  const aTag = findTag(event.tags, "a");
  if (!aTag || !ADDRESS_PATTERN.test(aTag)) {
    return { ok: false, error: '"a" tag must match 30520:<aud_id-hex>:<slug>' };
  }
  const epochTag = findTag(event.tags, "fa:epoch");
  if (!epochTag || !/^[1-9]\d*$/.test(epochTag)) {
    return { ok: false, error: '"fa:epoch" must be a positive integer' };
  }
  const epoch = Number(epochTag);

  const pTags = findAllTags(event.tags, "p");
  if (pTags.length === 0) {
    return { ok: false, error: 'must carry at least one "p" tag (per current member)' };
  }
  for (const p of pTags) {
    if (!HEX64.test(p)) {
      return { ok: false, error: `"p" tag value not 32-byte hex: ${p}` };
    }
  }
  const blake3Tag = findTag(event.tags, "blake3");
  if (!blake3Tag) {
    return { ok: false, error: '"blake3" tag missing' };
  }
  const expectedBlake3 = blake3ContentTag(event.content);
  if (blake3Tag !== expectedBlake3) {
    return {
      ok: false,
      error: `blake3 tag mismatch: tag="${blake3Tag}", expected="${expectedBlake3}"`,
    };
  }
  if (!nip44IsStructurallyValid(event.content)) {
    return { ok: false, error: "content is not valid NIP-44 v2 ciphertext" };
  }

  if (lookup.currentDeclarationByAddress) {
    const decl = lookup.currentDeclarationByAddress(aTag);
    if (!decl) {
      return { ok: false, error: '"a" tag does not resolve to a known kind:30520 declaration' };
    }
    if (decl.epoch !== epoch) {
      return {
        ok: false,
        error: `fa:epoch (${epoch}) does not equal current declaration epoch (${decl.epoch})`,
      };
    }
    if (!setEqualLower(pTags, decl.members)) {
      return {
        ok: false,
        error: '"p" tag set does not equal the current declaration member set',
      };
    }
  }

  return { ok: true };
}
