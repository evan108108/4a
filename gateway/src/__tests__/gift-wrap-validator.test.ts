import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { encryptString } from "../lib/nip44";
import { validateGiftWrapEvent } from "../gift-wrap-validator";
import type { NostrEvent } from "../relay-pool";

const EPH_PRIV = hexToBytes(
  "1010101010101010101010101010101010101010101010101010101010101010",
);
const EPH_PUB = bytesToHex(schnorr.getPublicKey(EPH_PRIV));
const RECIPIENT_PRIV = hexToBytes(
  "2020202020202020202020202020202020202020202020202020202020202020",
);
const RECIPIENT_PUB = bytesToHex(schnorr.getPublicKey(RECIPIENT_PRIV));

function canonical(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "deadbeef".repeat(8),
    pubkey: EPH_PUB,
    created_at: 1777344600,
    kind: 1059,
    tags: [["p", RECIPIENT_PUB]],
    content: encryptString("opaque seal contents", EPH_PRIV, RECIPIENT_PUB),
    sig: "00".repeat(64),
    ...overrides,
  };
}

describe("validateGiftWrapEvent", () => {
  it("accepts a canonical gift-wrap shape", () => {
    expect(validateGiftWrapEvent(canonical())).toEqual({ ok: true });
  });

  it("rejects when more than one tag is present", () => {
    const e = canonical();
    e.tags = [
      ["p", RECIPIENT_PUB],
      ["a", "30520:..."],
    ];
    const r = validateGiftWrapEvent(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exactly one tag/);
  });

  it("rejects when the only tag is not a p tag", () => {
    const e = canonical();
    e.tags = [["e", RECIPIENT_PUB]];
    const r = validateGiftWrapEvent(e);
    expect(r.ok).toBe(false);
  });

  it("rejects when content is not valid NIP-44 v2", () => {
    const r = validateGiftWrapEvent(canonical({ content: "garbage" }));
    expect(r.ok).toBe(false);
  });

  it("rejects when ephemeral pubkey reuse is configured + tripped", () => {
    const r = validateGiftWrapEvent(canonical(), {
      detectEphemeralReuse: () => true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reused/);
  });

  it("rejects kind ≠ 1059", () => {
    const r = validateGiftWrapEvent(canonical({ kind: 1060 }));
    expect(r.ok).toBe(false);
  });
});
