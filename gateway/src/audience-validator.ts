// Well-formedness validator for kind:30520 (Audience declaration) events.
//
// Per SPEC-v0.5 §1.6 — checks event-shape, required tags, content/JSON-LD,
// and the cross-field invariant that `content.epoch` equals the `fa:epoch`
// tag. The "pubkey never rotates" check (§1.4) is delegated to the optional
// `lookup.priorAudienceDeclarationPubkey` so tests can run without relays.
//
// All checks are pure-function and I/O-free except for what the lookup
// interface exposes; the gateway and tests inject implementations.
//
// Out of scope here: signature verification (the relay-pool already does
// schnorr verify on every accepted event), and aggregator-side semantics.

import type { NostrEvent } from "./relay-pool";

const KIND_AUDIENCE = 30520;
const FA_CONTEXT_V0 = "https://4a4.ai/ns/v0";
const HEX64 = /^[0-9a-f]{64}$/i;
const SLUG = /^[A-Za-z0-9-]+$/;

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Lookup interface for cross-event invariants. Validators that don't need
 * relay state can pass `{}`; validators called from the gateway pass an
 * implementation backed by the relay pool.
 */
export interface AudienceLookup {
  /**
   * Return the pubkey of any prior `kind:30520` event with the same `d` slug,
   * or `undefined` if none has been seen. Used to enforce §1.4: the audience
   * identity key never rotates.
   */
  priorAudienceDeclarationPubkey?(slug: string): string | undefined;
  /**
   * Return the parsed current `kind:30520` declaration for a given audience
   * address (`30520:<aud_id-hex>:<slug>`), or `undefined`. Used by the
   * key-grant, encrypted-variant, and claim validators that need to check
   * §2.6/§3.6/§5.7 invariants against the declaration.
   */
  currentDeclarationByAddress?(address: string): AudienceDeclaration | undefined;
}

export interface AudienceDeclaration {
  /** The audience identity pubkey (signs the declaration). */
  audIdPub: string;
  /** Audience slug, the `d` tag value. */
  slug: string;
  /** Current epoch number. */
  epoch: number;
  /** 32-byte hex pubkey of the current `aud_epoch_n`. */
  epochPub: string;
  /** Current member identity pubkeys. */
  members: string[];
  /** Outstanding pending invite pubkeys (parsed from `fa:pending`). */
  pending: { invitePub: string; expirationUnix: number }[];
  /**
   * Room lifecycle status from `fa:status` (sonata-studio-room-lifecycle.md
   * §4.1). Absence means "active"; only "closed" is significant. Unknown
   * values fall back to "active" so future status flavors don't break the
   * legacy guard.
   */
  status: "active" | "closed";
  /**
   * Unix-seconds timestamp at which the founder closed the room. Parsed
   * from `fa:closed-at`; only meaningful when `status === "closed"`.
   */
  closedAt?: number;
}

function findTag(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1];
  return undefined;
}

function findAllTags(tags: string[][], name: string): string[] {
  const out: string[] = [];
  for (const t of tags) if (t[0] === name && typeof t[1] === "string") out.push(t[1]);
  return out;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Parse a `kind:30520` event into a structured declaration. Returns
 * `{ ok: false, error }` on the same conditions that `validateAudienceEvent`
 * would reject; the lookup-fed validators reuse this so they don't have to
 * re-implement parsing.
 */
export function parseAudienceDeclaration(
  event: NostrEvent,
):
  | { ok: true; value: AudienceDeclaration }
  | { ok: false; error: string } {
  if (event.kind !== KIND_AUDIENCE) {
    return { ok: false, error: `kind must be ${KIND_AUDIENCE}, got ${event.kind}` };
  }

  const dTag = findTag(event.tags, "d");
  if (!dTag || !SLUG.test(dTag)) {
    return { ok: false, error: 'tag "d" missing or not a valid audience slug' };
  }
  const faContext = findTag(event.tags, "fa:context");
  if (faContext !== FA_CONTEXT_V0) {
    return { ok: false, error: `fa:context must equal "${FA_CONTEXT_V0}"` };
  }
  const altTag = findTag(event.tags, "alt");
  if (!altTag || altTag.length === 0) {
    return { ok: false, error: 'tag "alt" missing or empty' };
  }
  const epochTag = findTag(event.tags, "fa:epoch");
  if (!epochTag || !/^[1-9]\d*$/.test(epochTag)) {
    return {
      ok: false,
      error: '"fa:epoch" must be a positive decimal integer (no leading zeros)',
    };
  }
  const epoch = Number(epochTag);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    return { ok: false, error: '"fa:epoch" out of safe-integer range' };
  }
  const epochPub = findTag(event.tags, "fa:epoch-pubkey");
  if (!epochPub || !HEX64.test(epochPub)) {
    return { ok: false, error: '"fa:epoch-pubkey" must be 32-byte hex' };
  }
  const members = findAllTags(event.tags, "p");
  for (const p of members) {
    if (!HEX64.test(p)) {
      return { ok: false, error: `"p" tag value not 32-byte hex: ${p}` };
    }
  }

  // Optional fa:pending tags.
  const pending: { invitePub: string; expirationUnix: number }[] = [];
  for (const t of event.tags) {
    if (t[0] !== "fa:pending") continue;
    const v = t[1];
    if (typeof v !== "string") {
      return { ok: false, error: '"fa:pending" missing value' };
    }
    const idx = v.lastIndexOf(":");
    if (idx <= 0) {
      return { ok: false, error: '"fa:pending" must be "<invite_pub>:<expiration>"' };
    }
    const invitePub = v.slice(0, idx);
    const expStr = v.slice(idx + 1);
    if (!HEX64.test(invitePub)) {
      return { ok: false, error: `"fa:pending" invite_pub not 32-byte hex` };
    }
    const expirationUnix = Number(expStr);
    if (!Number.isFinite(expirationUnix) || !Number.isSafeInteger(expirationUnix)) {
      return { ok: false, error: '"fa:pending" expiration must be an integer unix timestamp' };
    }
    if (expirationUnix <= nowSec()) {
      return { ok: false, error: '"fa:pending" expiration is in the past' };
    }
    pending.push({ invitePub, expirationUnix });
  }

  // content JSON-LD invariant.
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
  if (obj["@type"] !== "Audience") {
    return { ok: false, error: 'content."@type" must be "Audience"' };
  }
  if (typeof obj.epoch !== "number" || obj.epoch !== epoch) {
    return { ok: false, error: "content.epoch must equal the fa:epoch tag" };
  }

  // Room-lifecycle status tags (fa:status, fa:closed-at). Absence ≡ active
  // per §3.1; unknown values likewise fall back to active so the validator
  // stays permissive for forward-compat.
  let status: "active" | "closed" = "active";
  let closedAt: number | undefined;
  for (const t of event.tags) {
    if (t[0] === "fa:status") {
      if (t[1] === "closed") status = "closed";
    } else if (t[0] === "fa:closed-at") {
      const n = Number(t[1]);
      if (Number.isFinite(n) && n > 0) closedAt = n;
    }
  }

  const value: AudienceDeclaration = {
    audIdPub: event.pubkey,
    slug: dTag,
    epoch,
    epochPub,
    members,
    pending,
    status,
  };
  if (closedAt !== undefined) value.closedAt = closedAt;
  return { ok: true, value };
}

/**
 * Top-level validator: reject malformed events at publish time, plus the
 * §1.4 "audience identity key never rotates" cross-event check.
 */
export function validateAudienceEvent(
  event: NostrEvent,
  lookup: AudienceLookup = {},
): ValidationResult {
  const parsed = parseAudienceDeclaration(event);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (lookup.priorAudienceDeclarationPubkey) {
    const prior = lookup.priorAudienceDeclarationPubkey(parsed.value.slug);
    if (prior !== undefined && prior !== event.pubkey) {
      return {
        ok: false,
        error: `audience identity key cannot rotate: prior pubkey ${prior}, this event ${event.pubkey}`,
      };
    }
  }
  return { ok: true };
}

export const AUDIENCE_KIND = KIND_AUDIENCE;
export const AUDIENCE_FA_CONTEXT = FA_CONTEXT_V0;
export { HEX64, SLUG };
