// Well-formedness validator for kind:1059 (NIP-17 gift-wrap) events
// addressed to a 4A audience-relevant recipient.
//
// Per SPEC-v0.5 §4.5 — checks the NIP-17 envelope shape (single `p` tag, no
// other tags, NIP-44 v2 ciphertext content). Optional ephemeral-pubkey
// reuse detection is left to the gateway's runtime tracking; this validator
// is a pure function and only enforces the wire shape.
//
// The validator MUST NOT inspect the seal or rumor — that requires the
// recipient's identity key, which the gateway only has under capability-
// based delegation (§2.5).

import { isStructurallyValid as nip44IsStructurallyValid } from "./lib/nip44";
import type { NostrEvent } from "./relay-pool";

const KIND_GIFT_WRAP = 1059;
const HEX64 = /^[0-9a-f]{64}$/i;

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export interface GiftWrapValidatorConfig {
  /**
   * If true, also reject gift-wraps whose ephemeral pubkey was used in any
   * other gift-wrap recently observed. Tracking is the caller's
   * responsibility; we just call the predicate.
   */
  detectEphemeralReuse?: (ephPubkey: string) => boolean;
}

export function validateGiftWrapEvent(
  event: NostrEvent,
  config: GiftWrapValidatorConfig = {},
): ValidationResult {
  if (event.kind !== KIND_GIFT_WRAP) {
    return { ok: false, error: `kind must be ${KIND_GIFT_WRAP}, got ${event.kind}` };
  }
  if (!Array.isArray(event.tags)) {
    return { ok: false, error: "tags must be an array" };
  }
  if (event.tags.length !== 1) {
    return {
      ok: false,
      error: `gift-wrap MUST carry exactly one tag (got ${event.tags.length})`,
    };
  }
  const t = event.tags[0]!;
  if (!Array.isArray(t) || t.length < 2 || t[0] !== "p") {
    return { ok: false, error: 'gift-wrap tag must be ["p", "<recipient-hex>"]' };
  }
  const recipient = t[1];
  if (typeof recipient !== "string" || !HEX64.test(recipient)) {
    return { ok: false, error: '"p" recipient must be 32-byte hex' };
  }

  if (typeof event.content !== "string" || event.content.length === 0) {
    return { ok: false, error: "content must be a non-empty NIP-44 v2 ciphertext" };
  }
  if (!nip44IsStructurallyValid(event.content)) {
    return { ok: false, error: "content is not valid NIP-44 v2 ciphertext" };
  }
  if (!HEX64.test(event.pubkey)) {
    return { ok: false, error: "pubkey must be 32-byte hex" };
  }

  if (config.detectEphemeralReuse && config.detectEphemeralReuse(event.pubkey)) {
    return { ok: false, error: "ephemeral pubkey was reused across gift-wraps" };
  }

  return { ok: true };
}

export const GIFT_WRAP_KIND = KIND_GIFT_WRAP;
