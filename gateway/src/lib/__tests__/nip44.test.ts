// NIP-44 v2 test suite.
//
// Three layers of confidence:
//   1. Round-trip: every plaintext decrypts back to itself.
//   2. Cross-impl: our ciphertexts decrypt under nostr-tools' implementation
//      and vice-versa. This is the authoritative compatibility check —
//      nostr-tools is the de-facto reference implementation in the JS
//      ecosystem and matches the NIP-44 spec test vectors.
//   3. Failure modes: MAC tamper, version-byte tamper, malformed base64
//      all reject.

import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { base64 } from "@scure/base";
import * as nip44Tools from "nostr-tools/nip44";
import {
  decrypt,
  decryptString,
  encrypt,
  encryptString,
  getConversationKey,
  isStructurallyValid,
} from "../nip44";

function fixedKeypair(seedHex: string): { priv: Uint8Array; pub: string } {
  const priv = hexToBytes(seedHex);
  return { priv, pub: bytesToHex(schnorr.getPublicKey(priv)) };
}

describe("nip44.getConversationKey", () => {
  it("is symmetric across the two parties", () => {
    const a = fixedKeypair(
      "1111111111111111111111111111111111111111111111111111111111111111",
    );
    const b = fixedKeypair(
      "2222222222222222222222222222222222222222222222222222222222222222",
    );
    const ck1 = getConversationKey(a.priv, b.pub);
    const ck2 = getConversationKey(b.priv, a.pub);
    expect(bytesToHex(ck1)).toEqual(bytesToHex(ck2));
  });

  it("matches nostr-tools' conversation key", () => {
    const a = fixedKeypair(
      "3333333333333333333333333333333333333333333333333333333333333333",
    );
    const b = fixedKeypair(
      "4444444444444444444444444444444444444444444444444444444444444444",
    );
    const ours = getConversationKey(a.priv, b.pub);
    const theirs = nip44Tools.getConversationKey(a.priv, b.pub);
    expect(bytesToHex(ours)).toEqual(bytesToHex(theirs));
  });
});

describe("nip44 round-trip", () => {
  const sender = fixedKeypair(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const recipient = fixedKeypair(
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );

  it("round-trips a short utf8 string", () => {
    const plain = "hello team-design";
    const wire = encryptString(plain, sender.priv, recipient.pub);
    const got = decryptString(wire, recipient.priv, sender.pub);
    expect(got).toEqual(plain);
  });

  it("round-trips the raw 32-byte secp256k1 scalar (key-grant payload)", () => {
    // Per SPEC-v0.5 §2.2: key-grants encrypt the bare 32-byte scalar.
    const epochPriv = hexToBytes(
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
    const wire = encrypt(epochPriv, sender.priv, recipient.pub);
    const got = decrypt(wire, recipient.priv, sender.pub);
    expect(bytesToHex(got)).toEqual(bytesToHex(epochPriv));
    expect(got.length).toEqual(32);
  });

  it("round-trips a JSON-LD payload as a string (encrypted-variant content)", () => {
    const plain = JSON.stringify({
      "@context": "https://4a4.ai/ns/v0",
      "@type": "Observation",
      "schema:about": "https://example.org/team-design/note-1",
      "fa:value": 0.7,
      "schema:description": "design review at 4pm",
    });
    const wire = encryptString(plain, sender.priv, recipient.pub);
    expect(decryptString(wire, recipient.priv, sender.pub)).toEqual(plain);
  });

  it("round-trips a 1-byte plaintext (minimum padding bucket)", () => {
    const wire = encrypt(new Uint8Array([0xab]), sender.priv, recipient.pub);
    expect(Array.from(decrypt(wire, recipient.priv, sender.pub))).toEqual([0xab]);
  });

  it("round-trips a 4096-byte plaintext", () => {
    const big = new Uint8Array(4096);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const wire = encrypt(big, sender.priv, recipient.pub);
    const got = decrypt(wire, recipient.priv, sender.pub);
    expect(got.length).toEqual(4096);
    expect(bytesToHex(got)).toEqual(bytesToHex(big));
  });
});

describe("nip44 cross-implementation compatibility (nostr-tools)", () => {
  const sender = fixedKeypair(
    "5555555555555555555555555555555555555555555555555555555555555555",
  );
  const recipient = fixedKeypair(
    "6666666666666666666666666666666666666666666666666666666666666666",
  );
  const plain = "the quick brown fox jumps over the lazy dog";

  it("ours encrypts, nostr-tools decrypts", () => {
    const wire = encryptString(plain, sender.priv, recipient.pub);
    const ck = nip44Tools.getConversationKey(recipient.priv, sender.pub);
    expect(nip44Tools.decrypt(wire, ck)).toEqual(plain);
  });

  it("nostr-tools encrypts, ours decrypts", () => {
    const ck = nip44Tools.getConversationKey(sender.priv, recipient.pub);
    const wire = nip44Tools.encrypt(plain, ck);
    expect(decryptString(wire, recipient.priv, sender.pub)).toEqual(plain);
  });
});

describe("nip44 failure modes", () => {
  const sender = fixedKeypair(
    "7777777777777777777777777777777777777777777777777777777777777777",
  );
  const recipient = fixedKeypair(
    "8888888888888888888888888888888888888888888888888888888888888888",
  );

  it("rejects a tampered MAC", () => {
    const wire = encryptString("integrity matters", sender.priv, recipient.pub);
    // Flip the last base64 char (which is part of the MAC) to a different
    // valid base64 char so the string still decodes but the MAC bytes change.
    const last = wire.slice(-1);
    const replacement = last === "A" ? "B" : "A";
    const tampered = wire.slice(0, -1) + replacement;
    expect(() => decryptString(tampered, recipient.priv, sender.pub)).toThrow(/MAC/);
  });

  it("rejects an unsupported version byte", () => {
    const wire = encryptString("hello", sender.priv, recipient.pub);
    const buf = base64.decode(wire);
    buf[0] = 0x03;
    const reencoded = base64.encode(buf);
    expect(() => decryptString(reencoded, recipient.priv, sender.pub)).toThrow(/version/);
  });

  it("rejects malformed base64", () => {
    expect(() => decryptString("@@@not-base64@@@", recipient.priv, sender.pub)).toThrow();
  });

  it("isStructurallyValid accepts a real ciphertext and rejects garbage", () => {
    const wire = encryptString("hi", sender.priv, recipient.pub);
    expect(isStructurallyValid(wire)).toBe(true);
    expect(isStructurallyValid("")).toBe(false);
    expect(isStructurallyValid("#1abc")).toBe(false);
    expect(isStructurallyValid("not base64 at all !!!")).toBe(false);
  });
});
