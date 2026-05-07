// T1b — Studio kinds 30530-30536 in the encrypted-variant allowlist.
//
// Confirms that:
//   - validateEncryptedVariantEvent accepts every Studio kind (30530-30536).
//   - validateEncryptedVariantEvent still rejects out-of-range kinds: 30509,
//     30515-30529 (gap between v0.5 base and Studio), 30537-30539 (reserved
//     Studio v0.x headroom), 30540+.
//   - A canonical Studio rumor wrapped in kind:1059 passes
//     validateGiftWrapEvent (the gift-wrap validator never inspects the
//     inner; this test asserts that the Studio kind allowance does not
//     accidentally regress envelope-shape acceptance).
//   - validateStudioWireEvent (the parallel Studio-specific validator) still
//     accepts Studio kinds and still rejects 30537+. Exercised here as
//     belt-and-suspenders for the call-site that runs both validators.
//
// Why "both validators" coexist: per sonata-studio-v0-spec.md §1.5, Studio
// kinds are wire-equivalent to v0.5 encrypted variants. Phase 2 broadens
// ENCRYPTED_VARIANT_KINDS to include them so the existing publish/build
// path accepts Studio kinds without a parallel code path. The
// Studio-specific validator stays as a checkpoint for receivers who want
// kind-range narrowing (e.g. the sonata-studio plugin's projection layer).

import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { blake3ContentTag } from "../lib/blake3-tag";
import { encryptString as nip44EncryptString } from "../lib/nip44";
import { ENCRYPTED_VARIANT_KINDS } from "../lib/audience-events";
import { validateEncryptedVariantEvent } from "../encrypted-variant-validator";
import { validateGiftWrapEvent } from "../gift-wrap-validator";
import {
  validateStudioWireEvent,
  STUDIO_KINDS,
} from "../studio-v0/validators";
import type { AudienceLookup } from "../audience-validator";
import type { NostrEvent } from "../relay-pool";

// ── Test fixtures ───────────────────────────────────────────────────────────

const AUD_ID_PUB = "a".repeat(64);
const PUB_PRIV = hexToBytes(
  "1111111111111111111111111111111111111111111111111111111111111111",
);
const PUB_PUB = bytesToHex(schnorr.getPublicKey(PUB_PRIV));
const MEMBER_1 = "4".repeat(64);
const MEMBER_2 = "5".repeat(64);
const SLUG = "rt-test";
const EPOCH = 1;
const A_TAG = `30520:${AUD_ID_PUB}:${SLUG}`;

const EPOCH_PRIV = hexToBytes(
  "2222222222222222222222222222222222222222222222222222222222222222",
);
const EPOCH_PUB = bytesToHex(schnorr.getPublicKey(EPOCH_PRIV));

// A canonical Studio:Card plaintext (the spec's §3.2 example, abridged) — the
// validator under test only inspects the wire envelope, not the plaintext, so
// the actual ciphertext content is opaque from this test's perspective.
const STUDIO_CARD_PLAINTEXT = JSON.stringify({
  "@context": "https://sonata.4a4.ai/ns/studio-v0",
  "@type": "Card",
  kind: "note",
  track: "inbox",
  title: "hello",
  summary: "hi",
  blocks: [{ type: "text", body: "world" }],
  createdBy: PUB_PUB,
});

function studioCiphertext(): string {
  return nip44EncryptString(STUDIO_CARD_PLAINTEXT, PUB_PRIV, EPOCH_PUB);
}

function canonicalStudioRumor(
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  const ct = overrides.content ?? studioCiphertext();
  return {
    id: "deadbeef".repeat(8),
    pubkey: PUB_PUB,
    created_at: 1777344600,
    kind: 30530,
    tags: [
      ["d", "rt-test-card-1"],
      ["fa:context", "https://4a4.ai/ns/v0"],
      ["alt", `Studio Card in ${SLUG}`],
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Studio kinds in encrypted-variant allowlist (T1b)", () => {
  it("ENCRYPTED_VARIANT_KINDS includes all Studio kinds 30530-30536", () => {
    for (const k of [30530, 30531, 30532, 30533, 30534, 30535, 30536]) {
      expect(ENCRYPTED_VARIANT_KINDS.includes(k as never)).toBe(true);
    }
  });

  it("ENCRYPTED_VARIANT_KINDS still includes the v0.5 base 30510-30514", () => {
    for (const k of [30510, 30511, 30512, 30513, 30514]) {
      expect(ENCRYPTED_VARIANT_KINDS.includes(k as never)).toBe(true);
    }
  });

  it("STUDIO_KINDS is exactly 30530-30536", () => {
    expect([...STUDIO_KINDS]).toEqual([
      30530, 30531, 30532, 30533, 30534, 30535, 30536,
    ]);
  });
});

describe("validateEncryptedVariantEvent on Studio kinds", () => {
  it("accepts a canonical kind:30530 (Studio:Card) rumor", () => {
    expect(validateEncryptedVariantEvent(canonicalStudioRumor(), lookup)).toEqual({
      ok: true,
    });
  });

  it("accepts every Studio kind 30531-30536", () => {
    for (const kind of [30531, 30532, 30533, 30534, 30535, 30536]) {
      const r = validateEncryptedVariantEvent(
        canonicalStudioRumor({ kind }),
        lookup,
      );
      expect(r).toEqual({ ok: true });
    }
  });

  it("rejects 30537 (reserved Studio v0.x headroom)", () => {
    const r = validateEncryptedVariantEvent(
      canonicalStudioRumor({ kind: 30537 }),
      lookup,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not in encrypted-variant range/);
  });

  it("rejects 30538 + 30539 (rest of reserved headroom)", () => {
    for (const kind of [30538, 30539]) {
      const r = validateEncryptedVariantEvent(
        canonicalStudioRumor({ kind }),
        lookup,
      );
      expect(r.ok).toBe(false);
    }
  });

  it("rejects kinds in the gap between base and Studio (30515-30529)", () => {
    for (const kind of [30515, 30520, 30525, 30529]) {
      const r = validateEncryptedVariantEvent(
        canonicalStudioRumor({ kind }),
        lookup,
      );
      expect(r.ok).toBe(false);
    }
  });

  it("rejects 30540 (well past Studio range)", () => {
    const r = validateEncryptedVariantEvent(
      canonicalStudioRumor({ kind: 30540 }),
      lookup,
    );
    expect(r.ok).toBe(false);
  });
});

describe("validateGiftWrapEvent does not regress on Studio kinds", () => {
  it("a kind:1059 envelope wrapping a Studio rumor passes (envelope-only check)", () => {
    // The gift-wrap validator never inspects the seal/rumor — see
    // gift-wrap-validator.ts top comment. This test asserts that adding
    // Studio kinds to the encrypted-variant allowlist did not introduce any
    // coupling that breaks envelope acceptance.
    const ephPriv = hexToBytes(
      "3030303030303030303030303030303030303030303030303030303030303030",
    );
    const ephPub = bytesToHex(schnorr.getPublicKey(ephPriv));
    const recipientPriv = hexToBytes(
      "4040404040404040404040404040404040404040404040404040404040404040",
    );
    const recipientPub = bytesToHex(schnorr.getPublicKey(recipientPriv));
    // Inner content is opaque to the validator — any well-formed NIP-44 v2
    // ciphertext is accepted. We use a plausible "seal containing a Studio
    // rumor" stub.
    const sealCiphertext = nip44EncryptString(
      JSON.stringify(canonicalStudioRumor()),
      ephPriv,
      recipientPub,
    );
    const wrap: NostrEvent = {
      id: "deadbeef".repeat(8),
      pubkey: ephPub,
      created_at: 1777344600,
      kind: 1059,
      tags: [["p", recipientPub]],
      content: sealCiphertext,
      sig: "00".repeat(64),
    };
    expect(validateGiftWrapEvent(wrap)).toEqual({ ok: true });
  });
});

describe("validateStudioWireEvent (parallel narrowing validator)", () => {
  it("accepts a canonical kind:30530 rumor", () => {
    expect(validateStudioWireEvent(canonicalStudioRumor(), lookup)).toEqual({
      ok: true,
    });
  });

  it("accepts every Studio kind 30530-30536", () => {
    for (const kind of [30530, 30531, 30532, 30533, 30534, 30535, 30536]) {
      const r = validateStudioWireEvent(canonicalStudioRumor({ kind }), lookup);
      expect(r).toEqual({ ok: true });
    }
  });

  it("rejects 30537 (still out of Studio range)", () => {
    const r = validateStudioWireEvent(
      canonicalStudioRumor({ kind: 30537 }),
      lookup,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not in studio-v0 range/);
  });

  it("rejects 30510 (out of Studio range — base v0.5 kind)", () => {
    // Studio narrowing rejects v0.5 base kinds even though the encrypted-
    // variant validator accepts them. This is intentional: receivers that
    // want only Studio events use the narrowing validator.
    const r = validateStudioWireEvent(
      canonicalStudioRumor({ kind: 30510 }),
      lookup,
    );
    expect(r.ok).toBe(false);
  });
});
