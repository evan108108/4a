import { describe, expect, it } from "vitest";
import {
  generateAudienceIdentity,
  generateEpochKeypair,
  pubkeyFromPriv,
} from "../audience-keys";

describe("audience-keys", () => {
  it("generateAudienceIdentity produces a 32-byte priv and 64-char hex pub", () => {
    const kp = generateAudienceIdentity();
    expect(kp.priv.length).toEqual(32);
    expect(kp.pub).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateEpochKeypair produces a fresh, distinct keypair each call", () => {
    const a = generateEpochKeypair();
    const b = generateEpochKeypair();
    expect(a.pub).not.toEqual(b.pub);
    expect(Array.from(a.priv)).not.toEqual(Array.from(b.priv));
  });

  it("pubkeyFromPriv is consistent with generateEpochKeypair's pub", () => {
    const kp = generateEpochKeypair();
    expect(pubkeyFromPriv(kp.priv)).toEqual(kp.pub);
  });

  it("pubkeyFromPriv rejects non-32-byte input", () => {
    expect(() => pubkeyFromPriv(new Uint8Array(31))).toThrow();
  });
});
