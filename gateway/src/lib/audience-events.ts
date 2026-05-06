// Pure builders for v0.5 audience-related event templates.
//
// All builders return EventTemplate (no signature, no id) so the caller can
// sign with whatever key is appropriate per SPEC-v0.5:
//
//   kind:30520 — signed by aud_id
//   kind:30521 — signed by caller's identity (current member) or aud_id
//                (founding grant)
//   kind:30510-30514 — signed by publisher identity
//   kind:30522 — signed by invite_priv
//
// The kind:30521 builder takes already-encrypted ciphertext as input — the
// caller is responsible for NIP-44 v2-encrypting the bare epoch private key.
// Same for kind:30510-30514: caller passes the encrypted-payload ciphertext.

import { blake3ContentTag } from "./blake3-tag";
import type { EventTemplate } from "../kms";

export const FA_CONTEXT_V0 = "https://4a4.ai/ns/v0";
export const KIND_AUDIENCE = 30520;
export const KIND_KEYGRANT = 30521;
export const KIND_CLAIM = 30522;
export const ENCRYPTED_VARIANT_KINDS = [30510, 30511, 30512, 30513, 30514] as const;
export type EncryptedVariantKind = (typeof ENCRYPTED_VARIANT_KINDS)[number];

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface BuildAudienceDeclarationInput {
  /** The aud_id pubkey (32-byte hex). Used in `a` tag references downstream. */
  audIdPub: string;
  slug: string;
  name: string;
  description?: string;
  epoch: number;
  /** 32-byte hex pubkey of the current aud_epoch_n. */
  epochPub: string;
  /** Identity pubkeys of current members. */
  members: string[];
  /** Outstanding pending invites: invite_pub + expirationUnix. */
  pending?: { invitePub: string; expirationUnix: number }[];
  /** NIP-40 audience-retirement timestamp; optional. */
  expiration?: number;
  /** Override created_at (used by tests for determinism). */
  createdAt?: number;
}

export function buildAudienceDeclaration(
  input: BuildAudienceDeclarationInput,
): EventTemplate {
  const memberCount = input.members.length;
  const altSummary = `Audience: ${input.slug} (${memberCount} member${memberCount === 1 ? "" : "s"}, epoch ${input.epoch})`;
  const tags: string[][] = [
    ["d", input.slug],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", altSummary],
    ["fa:epoch", String(input.epoch)],
    ["fa:epoch-pubkey", input.epochPub],
  ];
  for (const m of input.members) tags.push(["p", m]);
  for (const p of input.pending ?? []) {
    tags.push(["fa:pending", `${p.invitePub}:${p.expirationUnix}`]);
  }
  if (input.expiration !== undefined) {
    tags.push(["expiration", String(input.expiration)]);
  }
  const contentObj: Record<string, unknown> = {
    "@context": FA_CONTEXT_V0,
    "@type": "Audience",
    name: input.name,
    epoch: input.epoch,
  };
  if (input.description !== undefined) contentObj.description = input.description;
  return {
    kind: KIND_AUDIENCE,
    created_at: input.createdAt ?? nowSec(),
    tags,
    content: JSON.stringify(contentObj),
  };
}

export interface BuildKeyGrantInput {
  audIdPub: string;
  slug: string;
  epoch: number;
  /** Recipient identity pubkey. */
  recipientPub: string;
  /** NIP-44 v2 ciphertext of the bare 32-byte epoch private key. */
  ciphertext: string;
  createdAt?: number;
}

export function buildKeyGrant(input: BuildKeyGrantInput): EventTemplate {
  const aTag = `${KIND_AUDIENCE}:${input.audIdPub}:${input.slug}`;
  const dTag = `${input.slug}:${input.epoch}:${input.recipientPub}`;
  return {
    kind: KIND_KEYGRANT,
    created_at: input.createdAt ?? nowSec(),
    tags: [
      ["d", dTag],
      ["fa:context", FA_CONTEXT_V0],
      ["alt", `KeyGrant: ${input.slug} epoch ${input.epoch}`],
      ["a", aTag],
      ["fa:epoch", String(input.epoch)],
      ["p", input.recipientPub],
    ],
    content: input.ciphertext,
  };
}

export interface BuildAudienceClaimInput {
  audIdPub: string;
  slug: string;
  epoch: number;
  invitePub: string;
  inviterPub: string;
  claimPub: string;
  note?: string;
  expiration?: number;
  createdAt?: number;
}

export function buildAudienceClaim(input: BuildAudienceClaimInput): EventTemplate {
  const aTag = `${KIND_AUDIENCE}:${input.audIdPub}:${input.slug}`;
  const dTag = `${input.slug}:${input.epoch}:${input.invitePub}`;
  const tags: string[][] = [
    ["d", dTag],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", `claim audience ${input.slug} epoch ${input.epoch}`],
    ["a", aTag],
    ["fa:epoch", String(input.epoch)],
    ["p", input.inviterPub],
    ["fa:claim-pubkey", input.claimPub],
  ];
  if (input.expiration !== undefined) {
    tags.push(["expiration", String(input.expiration)]);
  }
  const contentObj: Record<string, unknown> = {
    "@context": FA_CONTEXT_V0,
    "@type": "AudienceClaim",
    audience: input.slug,
    epoch: input.epoch,
    claimPubkey: input.claimPub,
  };
  if (input.note !== undefined) contentObj.note = input.note;
  return {
    kind: KIND_CLAIM,
    created_at: input.createdAt ?? nowSec(),
    tags,
    content: JSON.stringify(contentObj),
  };
}

export interface BuildEncryptedVariantInput {
  kind: EncryptedVariantKind;
  audIdPub: string;
  slug: string;
  epoch: number;
  /** Identity pubkeys of all current members (publisher MUST address every one). */
  members: string[];
  /** d-slug for the addressable. */
  dTag: string;
  /** One-line alt summary; MUST NOT leak inner payload contents. */
  alt: string;
  /** NIP-44 v2 ciphertext of the JSON-LD payload. */
  ciphertext: string;
  createdAt?: number;
}

export function buildEncryptedVariant(input: BuildEncryptedVariantInput): EventTemplate {
  const aTag = `${KIND_AUDIENCE}:${input.audIdPub}:${input.slug}`;
  const tags: string[][] = [
    ["d", input.dTag],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", input.alt],
    ["a", aTag],
    ["fa:epoch", String(input.epoch)],
  ];
  for (const m of input.members) tags.push(["p", m]);
  tags.push(["blake3", blake3ContentTag(input.ciphertext)]);
  return {
    kind: input.kind,
    created_at: input.createdAt ?? nowSec(),
    tags,
    content: input.ciphertext,
  };
}

export function audienceAddress(audIdPub: string, slug: string): string {
  return `${KIND_AUDIENCE}:${audIdPub}:${slug}`;
}

export function parseAudienceAddress(
  address: string,
): { kind: number; pubkey: string; slug: string } | null {
  const parts = address.split(":");
  if (parts.length !== 3) return null;
  const [kindStr, pubkey, slug] = parts as [string, string, string];
  if (kindStr !== String(KIND_AUDIENCE)) return null;
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  if (!/^[A-Za-z0-9-]+$/.test(slug)) return null;
  return { kind: KIND_AUDIENCE, pubkey, slug };
}
