import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { encrypt as nip44Encrypt } from "../lib/nip44";
import {
  validateKeyGrantEvent,
  KEYGRANT_KIND,
} from "../keygrant-validator";
import type { AudienceLookup } from "../audience-validator";
import type { NostrEvent } from "../relay-pool";

const AUD_ID_PRIV = hexToBytes(
  "1111111111111111111111111111111111111111111111111111111111111111",
);
const AUD_ID_PUB = bytesToHex(schnorr.getPublicKey(AUD_ID_PRIV));
const EPOCH_PRIV = hexToBytes(
  "2222222222222222222222222222222222222222222222222222222222222222",
);
const EPOCH_PUB = bytesToHex(schnorr.getPublicKey(EPOCH_PRIV));
const RECIPIENT_PRIV = hexToBytes(
  "3333333333333333333333333333333333333333333333333333333333333333",
);
const RECIPIENT_PUB = bytesToHex(schnorr.getPublicKey(RECIPIENT_PRIV));
const SLUG = "team-design";
const EPOCH = 7;
const A_TAG = `30520:${AUD_ID_PUB}:${SLUG}`;

function realCiphertext(): string {
  return nip44Encrypt(EPOCH_PRIV, AUD_ID_PRIV, RECIPIENT_PUB);
}

function canonical(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "deadbeef".repeat(8),
    pubkey: AUD_ID_PUB, // founding grant signed by aud_id
    created_at: 1777344600,
    kind: KEYGRANT_KIND,
    tags: [
      ["d", `${SLUG}:${EPOCH}:${RECIPIENT_PUB}`],
      ["fa:context", "https://4a4.ai/ns/v0"],
      ["alt", `KeyGrant: ${SLUG} epoch ${EPOCH}`],
      ["a", A_TAG],
      ["fa:epoch", String(EPOCH)],
      ["p", RECIPIENT_PUB],
    ],
    content: realCiphertext(),
    sig: "00".repeat(64),
    ...overrides,
  };
}

const declarationLookup: AudienceLookup = {
  currentDeclarationByAddress: (addr) =>
    addr === A_TAG
      ? {
          audIdPub: AUD_ID_PUB,
          slug: SLUG,
          epoch: EPOCH,
          epochPub: EPOCH_PUB,
          members: [RECIPIENT_PUB],
          pending: [],
        }
      : undefined,
};

describe("validateKeyGrantEvent", () => {
  it("accepts the canonical founding-grant shape", () => {
    expect(validateKeyGrantEvent(canonical(), declarationLookup)).toEqual({
      ok: true,
    });
  });

  it("rejects an a-tag that does not resolve to a known declaration", () => {
    const e = canonical();
    e.tags = e.tags.map((t) =>
      t[0] === "a" ? ["a", `30520:${"f".repeat(64)}:other`] : t,
    );
    const r = validateKeyGrantEvent(e, declarationLookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not resolve/);
  });

  it("rejects when fa:epoch ≠ d-tag epoch", () => {
    const e = canonical();
    e.tags = e.tags.map((t) =>
      t[0] === "fa:epoch" ? ["fa:epoch", "8"] : t,
    );
    const r = validateKeyGrantEvent(e, declarationLookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/epoch/);
  });

  it("rejects when content is not a valid NIP-44 v2 ciphertext", () => {
    const r = validateKeyGrantEvent(
      canonical({ content: "not-base64-at-all" }),
      declarationLookup,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects when recipient is neither a member nor a pending invite", () => {
    const r = validateKeyGrantEvent(canonical(), {
      currentDeclarationByAddress: () => ({
        audIdPub: AUD_ID_PUB,
        slug: SLUG,
        epoch: EPOCH,
        epochPub: EPOCH_PUB,
        members: ["9".repeat(64)],
        pending: [],
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/recipient is not/);
  });

  it("rejects when granter is not a member nor the audience identity", () => {
    const ATTACKER_PRIV = hexToBytes("a".repeat(64));
    const ATTACKER_PUB = bytesToHex(schnorr.getPublicKey(ATTACKER_PRIV));
    const e = canonical({ pubkey: ATTACKER_PUB });
    const r = validateKeyGrantEvent(e, declarationLookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/granter/);
  });

  it("rejects when p tag does not match d-tag recipient", () => {
    const e = canonical();
    e.tags = e.tags.map((t) =>
      t[0] === "p" ? ["p", "9".repeat(64)] : t,
    );
    const r = validateKeyGrantEvent(e, declarationLookup);
    expect(r.ok).toBe(false);
  });
});
