// Well-formedness validator for kind:30522 (AudienceClaim) events.
//
// Per SPEC-v0.5 §5.7 — checks tag shape, content JSON-LD, and the
// fa:claim-pubkey ↔ content.claimPubkey ↔ p tag invariants. Cross-event
// invariant: the signing pubkey must appear as a fa:pending invite pubkey
// on the current declaration for the named epoch.

import type { AudienceLookup } from "./audience-validator";
import type { NostrEvent } from "./relay-pool";

const KIND_AUDIENCE_CLAIM = 30522;
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

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function validateAudienceClaimEvent(
  event: NostrEvent,
  lookup: AudienceLookup,
): ValidationResult {
  if (event.kind !== KIND_AUDIENCE_CLAIM) {
    return { ok: false, error: `kind must be ${KIND_AUDIENCE_CLAIM}, got ${event.kind}` };
  }

  const dTag = findTag(event.tags, "d");
  if (!dTag) return { ok: false, error: 'tag "d" missing' };
  const dParts = dTag.split(":");
  if (dParts.length !== 3) {
    return { ok: false, error: '"d" must be "<slug>:<epoch>:<invite-pub-hex>"' };
  }
  const [dSlug, dEpoch, dInvitePub] = dParts as [string, string, string];
  if (!/^[A-Za-z0-9-]+$/.test(dSlug)) {
    return { ok: false, error: '"d" slug invalid' };
  }
  if (!/^[1-9]\d*$/.test(dEpoch)) {
    return { ok: false, error: '"d" epoch must be a positive integer' };
  }
  if (!HEX64.test(dInvitePub)) {
    return { ok: false, error: '"d" invite-pub must be 32-byte hex' };
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
  if (epoch !== Number(dEpoch)) {
    return {
      ok: false,
      error: `fa:epoch (${epoch}) does not match d-tag epoch (${dEpoch})`,
    };
  }
  const pTag = findTag(event.tags, "p");
  if (!pTag || !HEX64.test(pTag)) {
    return { ok: false, error: '"p" (inviter pubkey) must be 32-byte hex' };
  }
  const claimPubTag = findTag(event.tags, "fa:claim-pubkey");
  if (!claimPubTag || !HEX64.test(claimPubTag)) {
    return { ok: false, error: '"fa:claim-pubkey" must be 32-byte hex' };
  }

  // Optional expiration.
  const exp = findTag(event.tags, "expiration");
  if (exp !== undefined) {
    const e = Number(exp);
    if (!Number.isFinite(e) || !Number.isSafeInteger(e)) {
      return { ok: false, error: '"expiration" must be a unix timestamp integer' };
    }
    if (e <= nowSec()) {
      return { ok: false, error: '"expiration" is in the past' };
    }
  }

  // Content JSON-LD.
  let body: unknown;
  try {
    body = JSON.parse(event.content);
  } catch (err) {
    return {
      ok: false,
      error: `content is not valid JSON: ${err instanceof Error ? err.message : err}`,
    };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "content must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  if (obj["@context"] !== FA_CONTEXT_V0) {
    return { ok: false, error: 'content."@context" must equal the v0 context URL' };
  }
  if (obj["@type"] !== "AudienceClaim") {
    return { ok: false, error: 'content."@type" must be "AudienceClaim"' };
  }
  if (typeof obj.audience !== "string" || obj.audience !== dSlug) {
    return { ok: false, error: "content.audience must equal the d-tag slug" };
  }
  if (typeof obj.epoch !== "number" || obj.epoch !== epoch) {
    return { ok: false, error: "content.epoch must equal the fa:epoch tag" };
  }
  if (typeof obj.claimPubkey !== "string" || obj.claimPubkey.toLowerCase() !== claimPubTag.toLowerCase()) {
    return { ok: false, error: "content.claimPubkey must equal the fa:claim-pubkey tag" };
  }

  // Signing pubkey MUST be invite_pub from the d-tag.
  if (event.pubkey.toLowerCase() !== dInvitePub.toLowerCase()) {
    return {
      ok: false,
      error: 'signing pubkey does not match the invite-pub component of "d"',
    };
  }

  // Cross-event: invite_pub must be in the current declaration's fa:pending.
  if (lookup.currentDeclarationByAddress) {
    const decl = lookup.currentDeclarationByAddress(aTag);
    if (!decl) {
      return { ok: false, error: '"a" tag does not resolve to a known kind:30520 declaration' };
    }
    const pending = decl.pending.some(
      (p) => p.invitePub.toLowerCase() === dInvitePub.toLowerCase(),
    );
    if (!pending) {
      return {
        ok: false,
        error: "signing pubkey is not a fa:pending invite on the current declaration",
      };
    }
  }

  return { ok: true };
}

export const AUDIENCE_CLAIM_KIND = KIND_AUDIENCE_CLAIM;
