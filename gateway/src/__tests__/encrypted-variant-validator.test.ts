import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { blake3ContentTag } from "../lib/blake3-tag";
import { encryptString as nip44EncryptString } from "../lib/nip44";
import { validateEncryptedVariantEvent } from "../encrypted-variant-validator";
import type { AudienceLookup } from "../audience-validator";
import type { NostrEvent } from "../relay-pool";

const AUD_ID_PUB = "a".repeat(64);
const PUB_PRIV = hexToBytes(
  "1111111111111111111111111111111111111111111111111111111111111111",
);
const PUB_PUB = bytesToHex(schnorr.getPublicKey(PUB_PRIV));
const MEMBER_1 = "4".repeat(64);
const MEMBER_2 = "5".repeat(64);
const SLUG = "team-design";
const EPOCH = 7;
const A_TAG = `30520:${AUD_ID_PUB}:${SLUG}`;

const EPOCH_PRIV = hexToBytes(
  "2222222222222222222222222222222222222222222222222222222222222222",
);
const EPOCH_PUB = bytesToHex(schnorr.getPublicKey(EPOCH_PRIV));

const PAYLOAD = JSON.stringify({
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Observation",
  "schema:about": "https://example.org/team-design/note-1",
});

function ciphertext(): string {
  return nip44EncryptString(PAYLOAD, PUB_PRIV, EPOCH_PUB);
}

function canonical(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const ct = overrides.content ?? ciphertext();
  return {
    id: "deadbeef".repeat(8),
    pubkey: PUB_PUB,
    created_at: 1777344600,
    kind: 30510,
    tags: [
      ["d", "team-design-note-1"],
      ["fa:context", "https://4a4.ai/ns/v0"],
      ["alt", `encrypted Observation in ${SLUG}`],
      ["a", A_TAG],
      ["fa:epoch", String(EPOCH)],
      ["p", MEMBER_1],
      ["p", MEMBER_2],
      ["blake3", blake3ContentTag(ct)],
    ],
    content: ct,
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
          epochPub: EPOCH_PUB,
          members: [MEMBER_1, MEMBER_2],
          pending: [],
        }
      : undefined,
};

describe("validateEncryptedVariantEvent", () => {
  it("accepts the canonical kind:30510 example with all members in p tags", () => {
    expect(validateEncryptedVariantEvent(canonical(), lookup)).toEqual({ ok: true });
  });

  it("accepts kind:30511..30514 too", () => {
    for (const kind of [30511, 30512, 30513, 30514]) {
      expect(validateEncryptedVariantEvent(canonical({ kind }), lookup)).toEqual({
        ok: true,
      });
    }
  });

  it("rejects kind:30509 (out of encrypted-variant range)", () => {
    const r = validateEncryptedVariantEvent(canonical({ kind: 30509 }), lookup);
    expect(r.ok).toBe(false);
  });

  it("rejects when blake3 tag doesn't match the ciphertext", () => {
    const e = canonical();
    e.tags = e.tags.map((t) => (t[0] === "blake3" ? ["blake3", "bk-aaaa"] : t));
    const r = validateEncryptedVariantEvent(e, lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/blake3/);
  });

  it("rejects when content is not valid NIP-44 v2 ciphertext", () => {
    const ct = "not-base64-at-all";
    const e = canonical({
      content: ct,
      tags: canonical().tags.map((t) =>
        t[0] === "blake3" ? ["blake3", blake3ContentTag(ct)] : t,
      ),
    });
    const r = validateEncryptedVariantEvent(e, lookup);
    expect(r.ok).toBe(false);
  });

  it("rejects when p-tag set is missing a current member", () => {
    const e = canonical();
    e.tags = e.tags.filter((t) => !(t[0] === "p" && t[1] === MEMBER_2));
    const r = validateEncryptedVariantEvent(e, lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/member set/);
  });

  it("rejects when p-tag set has an extra non-member", () => {
    const e = canonical();
    e.tags.push(["p", "9".repeat(64)]);
    const r = validateEncryptedVariantEvent(e, lookup);
    expect(r.ok).toBe(false);
  });

  it("rejects when fa:epoch does not match the current declaration", () => {
    const e = canonical();
    e.tags = e.tags.map((t) => (t[0] === "fa:epoch" ? ["fa:epoch", "8"] : t));
    const r = validateEncryptedVariantEvent(e, lookup);
    expect(r.ok).toBe(false);
  });

  it("rejects when a-tag references an unknown audience", () => {
    const e = canonical();
    e.tags = e.tags.map((t) =>
      t[0] === "a" ? ["a", `30520:${"f".repeat(64)}:nonexistent`] : t,
    );
    const r = validateEncryptedVariantEvent(e, lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not resolve/);
  });
});
