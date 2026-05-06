import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  decodeInviteKey,
  decodeInviteKeyOrThrow,
  encodeInviteKey,
  INVITE_HRP,
} from "../invite-key";

const KNOWN_PRIV =
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

describe("invite-key bech32 codec", () => {
  it("round-trips a 32-byte private key", () => {
    const priv = hexToBytes(KNOWN_PRIV);
    const encoded = encodeInviteKey(priv);
    expect(encoded.startsWith(INVITE_HRP + "1")).toBe(true);
    const decoded = decodeInviteKey(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(Array.from(decoded.priv)).toEqual(Array.from(priv));
    }
  });

  it("encodeInviteKey rejects payloads that aren't 32 bytes", () => {
    expect(() => encodeInviteKey(new Uint8Array(31))).toThrow();
    expect(() => encodeInviteKey(new Uint8Array(33))).toThrow();
  });

  it("rejects an nsec-style HRP", () => {
    // A valid bech32 string with a non-4ainv HRP. We can construct one by
    // re-encoding the same payload under a different HRP using a tiny inline
    // bech32 helper to avoid a circular-import gotcha.
    const priv = hexToBytes(KNOWN_PRIV);
    const ours = encodeInviteKey(priv);
    // Replace the HRP in-place with "nsec" — produces a wrong-HRP string with
    // a still-valid-looking checksum once decoded by @scure/base. We rely on
    // the codec's HRP-mismatch detection.
    const mutated = "nsec" + ours.slice(INVITE_HRP.length);
    const r = decodeInviteKey(mutated);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Either bad_checksum (because checksum is HRP-bound) or wrong_hrp.
      expect(["wrong_hrp", "bad_checksum", "bad_format"]).toContain(r.error.kind);
    }
  });

  it("rejects a corrupted checksum", () => {
    const priv = hexToBytes(KNOWN_PRIV);
    const ours = encodeInviteKey(priv);
    // Flip the last data char into a different valid bech32 char.
    const last = ours.slice(-1);
    const replacement = last === "q" ? "p" : "q";
    const corrupted = ours.slice(0, -1) + replacement;
    const r = decodeInviteKey(corrupted);
    expect(r.ok).toBe(false);
  });

  it("rejects empty input", () => {
    const r = decodeInviteKey("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toEqual("bad_format");
  });

  it("decodeInviteKeyOrThrow throws on bad input", () => {
    expect(() => decodeInviteKeyOrThrow("garbage")).toThrow();
  });
});
