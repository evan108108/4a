// Schnorr-sign an arbitrary Nostr event template with a raw 32-byte priv.
//
// The KMS-backed signEventWithDerivedKey path in `kms.ts` is the right call
// for events authored by an OAuth-derived custodial identity. This helper
// covers the cases where the signing key is NOT KMS-derived:
//
//   - Audience identity (aud_id) signs the kind:30520 declaration.
//   - One-shot invite_priv signs the kind:30522 audience-claim.
//   - Audience epoch keys do not sign anything; they only encrypt.
//
// Same canonical NIP-01 id derivation as kms.ts so the wire format is
// indistinguishable.

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { EventTemplate, SignedEvent } from "../kms";

export function signEventWithRawKey(
  template: EventTemplate,
  priv: Uint8Array,
): SignedEvent {
  if (priv.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${priv.length}`);
  }
  const pubkey = bytesToHex(schnorr.getPublicKey(priv));
  const serialized = JSON.stringify([
    0,
    pubkey,
    template.created_at,
    template.kind,
    template.tags,
    template.content,
  ]);
  const idBytes = sha256(new TextEncoder().encode(serialized));
  const id = bytesToHex(idBytes);
  const sig = bytesToHex(schnorr.sign(idBytes, priv));
  return { ...template, id, pubkey, sig };
}

export { hexToBytes, bytesToHex };
