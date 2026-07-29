import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { validateAudienceClaimEvent } from "../audience-claim-validator";
import type { AudienceLookup } from "../audience-validator";
import type { NostrEvent } from "../relay-pool";

const AUD_ID_PUB = "a".repeat(64);
const INVITE_PRIV = hexToBytes(
  "5555555555555555555555555555555555555555555555555555555555555555",
);
const INVITE_PUB = bytesToHex(schnorr.getPublicKey(INVITE_PRIV));
const INVITER_PUB = "9".repeat(64);
const CLAIM_PUB = "c".repeat(64);
const SLUG = "team-design";
const EPOCH = 1;
const A_TAG = `30520:${AUD_ID_PUB}:${SLUG}`;
const FUTURE = Math.floor(Date.now() / 1000) + 3600 * 24 * 7;

const VALID_CONTENT = JSON.stringify({
  "@context": "https://4a4.ai/ns/v0",
  "@type": "AudienceClaim",
  audience: SLUG,
  epoch: EPOCH,
  claimPubkey: CLAIM_PUB,
  note: "thanks for the invite",
});

function canonical(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "deadbeef".repeat(8),
    pubkey: INVITE_PUB,
    created_at: 1777344600,
    kind: 30522,
    tags: [
      ["d", `${SLUG}:${EPOCH}:${INVITE_PUB}`],
      ["fa:context", "https://4a4.ai/ns/v0"],
      ["alt", `claim audience ${SLUG} epoch ${EPOCH}`],
      ["a", A_TAG],
      ["fa:epoch", String(EPOCH)],
      ["p", INVITER_PUB],
      ["fa:claim-pubkey", CLAIM_PUB],
      ["expiration", String(FUTURE)],
    ],
    content: VALID_CONTENT,
    sig: "00".repeat(64),
    ...overrides,
  };
}

const lookup: AudienceLookup = {
  currentDeclarationByAddress: (addr) =>
    addr === A_TAG
      ? {
          audIdPub: AUD_ID_PUB,
          slug: SLUG,
          epoch: EPOCH,
          epochPub: "b".repeat(64),
          members: ["m".repeat(64)],
          pending: [{ invitePub: INVITE_PUB, expirationUnix: FUTURE }],
          status: "active",
        }
      : undefined,
};

describe("validateAudienceClaimEvent", () => {
  it("accepts the canonical claim shape", () => {
    expect(validateAudienceClaimEvent(canonical(), lookup)).toEqual({ ok: true });
  });

  it("rejects when signing pubkey is not the invite_pub from d", () => {
    const ATTACKER = bytesToHex(schnorr.getPublicKey(hexToBytes("a".repeat(64))));
    const r = validateAudienceClaimEvent(canonical({ pubkey: ATTACKER }), lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invite-pub/);
  });

  it("rejects when invite_pub is not in fa:pending on the declaration", () => {
    const r = validateAudienceClaimEvent(canonical(), {
      currentDeclarationByAddress: () => ({
        audIdPub: AUD_ID_PUB,
        slug: SLUG,
        epoch: EPOCH,
        epochPub: "b".repeat(64),
        members: [],
        pending: [],
        status: "active",
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/fa:pending/);
  });

  it("rejects when content.claimPubkey ≠ fa:claim-pubkey tag", () => {
    const content = JSON.stringify({
      "@context": "https://4a4.ai/ns/v0",
      "@type": "AudienceClaim",
      audience: SLUG,
      epoch: EPOCH,
      claimPubkey: "f".repeat(64),
    });
    const r = validateAudienceClaimEvent(canonical({ content }), lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/claimPubkey/);
  });

  it("rejects expired claims", () => {
    const e = canonical();
    e.tags = e.tags.map((t) =>
      t[0] === "expiration" ? ["expiration", "1"] : t,
    );
    const r = validateAudienceClaimEvent(e, lookup);
    expect(r.ok).toBe(false);
  });

  it("rejects when fa:claim-pubkey is not 32-byte hex", () => {
    const e = canonical();
    e.tags = e.tags.map((t) =>
      t[0] === "fa:claim-pubkey" ? ["fa:claim-pubkey", "abcd"] : t,
    );
    const r = validateAudienceClaimEvent(e, lookup);
    expect(r.ok).toBe(false);
  });
});
