// Well-formedness validator for kind:30521 (KeyGrant) events.
//
// Per SPEC-v0.5 §2.6 — checks tag shape, the `a` tag resolution against the
// current declaration, the recipient invariant (must be a current member or
// pending invite), the granter invariant (must be a current member, or the
// audience identity for the founding grant), and structural validity of the
// NIP-44 v2 ciphertext content.
//
// The lookup interface comes from `audience-validator.ts`; gateway provides
// an implementation backed by relay state, tests stub.

import type { AudienceLookup } from "./audience-validator";
import { isStructurallyValid as nip44IsStructurallyValid } from "./lib/nip44";
import type { NostrEvent } from "./relay-pool";

const KIND_KEYGRANT = 30521;
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

export function validateKeyGrantEvent(
  event: NostrEvent,
  lookup: AudienceLookup,
): ValidationResult {
  if (event.kind !== KIND_KEYGRANT) {
    return { ok: false, error: `kind must be ${KIND_KEYGRANT}, got ${event.kind}` };
  }

  const dTag = findTag(event.tags, "d");
  if (!dTag || dTag.length === 0) {
    return { ok: false, error: 'tag "d" missing' };
  }
  // SPEC §2.1: composite d = "<slug>:<epoch>:<recipient-hex>".
  const dParts = dTag.split(":");
  if (dParts.length !== 3) {
    return {
      ok: false,
      error: '"d" must be "<audience-slug>:<epoch>:<recipient-hex>"',
    };
  }
  const [dSlug, dEpoch, dRecipient] = dParts as [string, string, string];
  if (!/^[A-Za-z0-9-]+$/.test(dSlug)) {
    return { ok: false, error: '"d" slug component invalid' };
  }
  if (!/^[1-9]\d*$/.test(dEpoch)) {
    return { ok: false, error: '"d" epoch component must be a positive integer' };
  }
  if (!HEX64.test(dRecipient)) {
    return { ok: false, error: '"d" recipient component must be 32-byte hex' };
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
  const pTags = findAllTags(event.tags, "p");
  if (pTags.length !== 1) {
    return { ok: false, error: '"p" tag must appear exactly once' };
  }
  const recipient = pTags[0]!;
  if (!HEX64.test(recipient)) {
    return { ok: false, error: '"p" recipient must be 32-byte hex' };
  }
  if (recipient.toLowerCase() !== dRecipient.toLowerCase()) {
    return {
      ok: false,
      error: '"p" recipient does not match the recipient component of "d"',
    };
  }

  if (typeof event.content !== "string" || event.content.length === 0) {
    return { ok: false, error: "content must be a non-empty NIP-44 v2 ciphertext" };
  }
  if (!nip44IsStructurallyValid(event.content)) {
    return { ok: false, error: "content is not valid NIP-44 v2 ciphertext" };
  }

  // Cross-event invariants — only run if the lookup has a declaration source.
  if (lookup.currentDeclarationByAddress) {
    const decl = lookup.currentDeclarationByAddress(aTag);
    if (!decl) {
      return { ok: false, error: `"a" tag does not resolve to a known kind:30520 declaration` };
    }
    if (decl.epoch !== epoch) {
      return {
        ok: false,
        error: `fa:epoch (${epoch}) does not equal current declaration epoch (${decl.epoch})`,
      };
    }
    const isMember = decl.members.some((m) => m.toLowerCase() === recipient.toLowerCase());
    const isPending = decl.pending.some(
      (p) => p.invitePub.toLowerCase() === recipient.toLowerCase(),
    );
    if (!isMember && !isPending) {
      return {
        ok: false,
        error: "recipient is not a current member or pending invite of the audience",
      };
    }
    // Granter must be a current member, or the audience identity (founding grant).
    const granter = event.pubkey.toLowerCase();
    const granterIsMember = decl.members.some((m) => m.toLowerCase() === granter);
    const granterIsAudIdentity = decl.audIdPub.toLowerCase() === granter;
    if (!granterIsMember && !granterIsAudIdentity) {
      return {
        ok: false,
        error: "granter is not a current member nor the audience identity",
      };
    }
  }

  return { ok: true };
}

export const KEYGRANT_KIND = KIND_KEYGRANT;
