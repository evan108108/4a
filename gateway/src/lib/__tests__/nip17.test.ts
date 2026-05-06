import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  KIND_GIFT_WRAP,
  KIND_SEAL,
  __getEventHash,
  __signEvent,
  createGiftWrap,
  createSeal,
  unwrap,
  verifyEventSignature,
  wrap,
  type NostrEvent,
} from "../nip17";

function keypair(seedHex: string): { priv: Uint8Array; pub: string } {
  const priv = hexToBytes(seedHex);
  return { priv, pub: bytesToHex(schnorr.getPublicKey(priv)) };
}

function buildSignedRumor(publisherPriv: Uint8Array): NostrEvent {
  // A minimal kind:30510 (encrypted Observation) rumor — content is opaque
  // to NIP-17, so we don't need real NIP-44 ciphertext here.
  const pubkey = bytesToHex(schnorr.getPublicKey(publisherPriv));
  return __signEvent(
    {
      pubkey,
      kind: 30510,
      created_at: 1777344600,
      tags: [
        ["d", "team-design-note-1"],
        ["fa:context", "https://4a4.ai/ns/v0"],
        ["alt", "encrypted Observation in team-design"],
        ["a", "30520:" + "00".repeat(32) + ":team-design"],
        ["fa:epoch", "7"],
        ["p", "11".repeat(32)],
      ],
      content: "AgAAAAA…",
    },
    publisherPriv,
  );
}

describe("nip17 wrap/unwrap round-trip", () => {
  const publisher = keypair(
    "1111111111111111111111111111111111111111111111111111111111111111",
  );
  const recipient = keypair(
    "2222222222222222222222222222222222222222222222222222222222222222",
  );

  it("wraps a signed rumor and recovers it on unwrap", () => {
    const rumor = buildSignedRumor(publisher.priv);
    expect(verifyEventSignature(rumor)).toBe(true);

    const giftWrap = wrap(rumor, publisher.priv, recipient.pub);

    expect(giftWrap.kind).toEqual(KIND_GIFT_WRAP);
    expect(giftWrap.tags).toEqual([["p", recipient.pub]]);
    // Gift-wrap signed by ephemeral key — pubkey MUST NOT equal publisher.
    expect(giftWrap.pubkey).not.toEqual(publisher.pub);
    expect(verifyEventSignature(giftWrap)).toBe(true);

    const { rumor: out, publisherPub } = unwrap(giftWrap, recipient.priv);
    expect(publisherPub).toEqual(publisher.pub);
    expect(out.id).toEqual(rumor.id);
    expect(out.kind).toEqual(rumor.kind);
    expect(out.content).toEqual(rumor.content);
    expect(out.tags).toEqual(rumor.tags);
  });

  it("ephemeral pubkeys differ across two wraps of the same rumor", () => {
    const rumor = buildSignedRumor(publisher.priv);
    const w1 = wrap(rumor, publisher.priv, recipient.pub);
    const w2 = wrap(rumor, publisher.priv, recipient.pub);
    expect(w1.pubkey).not.toEqual(w2.pubkey);
  });

  it("rejects a gift-wrap addressed to a different recipient", () => {
    const rumor = buildSignedRumor(publisher.priv);
    const other = keypair(
      "3333333333333333333333333333333333333333333333333333333333333333",
    );
    const giftWrap = wrap(rumor, publisher.priv, other.pub);
    expect(() => unwrap(giftWrap, recipient.priv)).toThrow();
  });

  it("rejects a tampered seal signature", () => {
    const rumor = buildSignedRumor(publisher.priv);
    const seal = createSeal(rumor, publisher.priv, recipient.pub);
    // Tamper: re-sign with a different key but keep the publisher's pubkey
    // — this is what an attacker who learned the ciphertext but not the
    // publisher's private key could attempt.
    const attacker = keypair(
      "4444444444444444444444444444444444444444444444444444444444444444",
    );
    const tamperedSeal = { ...seal };
    tamperedSeal.sig = bytesToHex(
      schnorr.sign(hexToBytes(seal.id), attacker.priv),
    );
    const giftWrap = createGiftWrap(tamperedSeal, recipient.pub);
    expect(() => unwrap(giftWrap, recipient.priv)).toThrow(/seal signature/);
  });

  it("seal carries no tags besides what NIP-59 requires (none)", () => {
    const rumor = buildSignedRumor(publisher.priv);
    const seal = createSeal(rumor, publisher.priv, recipient.pub);
    expect(seal.kind).toEqual(KIND_SEAL);
    expect(seal.tags).toEqual([]);
  });

  it("verifyEventSignature catches an id/content mismatch", () => {
    const rumor = buildSignedRumor(publisher.priv);
    const tampered: NostrEvent = { ...rumor, content: "AgAAAAB…changed" };
    expect(verifyEventSignature(tampered)).toBe(false);
  });
});
