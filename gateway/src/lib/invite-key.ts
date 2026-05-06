// Bech32 codec for 4A invite keys.
//
// Per SPEC-v0.5 §6.2, an invite_priv is encoded as bech32 (BIP-0173) with
// HRP "4ainv" and a 32-byte big-endian secp256k1 private-key payload, e.g.
//
//   4ainv1qrzg2njhlnkkkkkkkk...
//
// Reasoning recorded in the SPEC: bech32 is the encoding NIP-19 uses for
// npub/nsec/nprofile/nevent — Nostr libs already speak it — and the
// distinct HRP makes invite keys non-confusable with regular Nostr keys
// when they appear in URLs, paste fields, or screenshots.

import { bech32 } from "@scure/base";

export const INVITE_HRP = "4ainv" as const;
const INVITE_PRIV_BYTES = 32;
// bech32 has a documented 90-char limit; lift the cap so a 32-byte payload
// always fits inside the codec helpers (`4ainv1` + 52 data + 6 checksum = 64).
const BECH32_LIMIT = 256;

export type DecodeError =
  | { kind: "wrong_hrp"; got: string }
  | { kind: "bad_checksum" }
  | { kind: "bad_length"; got: number }
  | { kind: "bad_format"; reason: string };

export type DecodeResult =
  | { ok: true; priv: Uint8Array }
  | { ok: false; error: DecodeError };

/**
 * Encode a 32-byte secp256k1 private key as a 4ainv1… bech32 string.
 */
export function encodeInviteKey(priv: Uint8Array): string {
  if (priv.length !== INVITE_PRIV_BYTES) {
    throw new Error(`invite_priv must be ${INVITE_PRIV_BYTES} bytes, got ${priv.length}`);
  }
  const words = bech32.toWords(priv);
  return bech32.encode(INVITE_HRP, words, BECH32_LIMIT);
}

/**
 * Decode a `4ainv1…` string back to its 32-byte payload. Returns a tagged
 * result so callers can distinguish "wrong HRP" (probably a typo or a key
 * for a different protocol) from "bad checksum" (transcription error) from
 * "wrong length" (malformed payload).
 */
export function decodeInviteKey(input: string): DecodeResult {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: { kind: "bad_format", reason: "empty input" } };
  }
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(input as `${string}1${string}`, BECH32_LIMIT);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (/checksum/i.test(reason)) {
      return { ok: false, error: { kind: "bad_checksum" } };
    }
    return { ok: false, error: { kind: "bad_format", reason } };
  }
  if (decoded.prefix !== INVITE_HRP) {
    return { ok: false, error: { kind: "wrong_hrp", got: decoded.prefix } };
  }
  let bytes: Uint8Array;
  try {
    bytes = bech32.fromWords(decoded.words);
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "bad_format",
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if (bytes.length !== INVITE_PRIV_BYTES) {
    return { ok: false, error: { kind: "bad_length", got: bytes.length } };
  }
  return { ok: true, priv: new Uint8Array(bytes) };
}

/**
 * Throwing variant for call sites that have already validated the format.
 */
export function decodeInviteKeyOrThrow(input: string): Uint8Array {
  const r = decodeInviteKey(input);
  if (!r.ok) {
    throw new Error(`invalid 4ainv1 invite key: ${r.error.kind}`);
  }
  return r.priv;
}
