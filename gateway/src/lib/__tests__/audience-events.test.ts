// Round-trip test: every event template produced by the audience-events
// builders, signed with a real secp256k1 key, MUST pass its corresponding
// validator. This catches drift between SPEC-v0.5 → builder shape →
// validator rules without needing the route handlers.

import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  audienceAddress,
  buildAudienceClaim,
  buildAudienceDeclaration,
  buildEncryptedVariant,
  buildKeyGrant,
  parseAudienceAddress,
} from "../audience-events";
import { encrypt as nip44Encrypt, encryptString as nip44EncryptString } from "../nip44";
import { signEventWithRawKey } from "../sign";
import { validateAudienceEvent } from "../../audience-validator";
import { validateKeyGrantEvent } from "../../keygrant-validator";
import { validateAudienceClaimEvent } from "../../audience-claim-validator";
import { validateEncryptedVariantEvent } from "../../encrypted-variant-validator";

const AUD_ID_PRIV = hexToBytes(
  "1111111111111111111111111111111111111111111111111111111111111111",
);
const AUD_ID_PUB = bytesToHex(schnorr.getPublicKey(AUD_ID_PRIV));
const EPOCH_PRIV = hexToBytes(
  "2222222222222222222222222222222222222222222222222222222222222222",
);
const EPOCH_PUB = bytesToHex(schnorr.getPublicKey(EPOCH_PRIV));
const MEMBER_PRIV = hexToBytes(
  "3333333333333333333333333333333333333333333333333333333333333333",
);
const MEMBER_PUB = bytesToHex(schnorr.getPublicKey(MEMBER_PRIV));
const SLUG = "team-design";
const FUTURE = Math.floor(Date.now() / 1000) + 7 * 86400;

describe("audience-events end-to-end shape", () => {
  it("declaration → validator passes", () => {
    const tpl = buildAudienceDeclaration({
      audIdPub: AUD_ID_PUB,
      slug: SLUG,
      name: "team-design",
      description: "design notes shared with Allison",
      epoch: 1,
      epochPub: EPOCH_PUB,
      members: [MEMBER_PUB],
    });
    const signed = signEventWithRawKey(tpl, AUD_ID_PRIV);
    expect(validateAudienceEvent(signed)).toEqual({ ok: true });
  });

  it("declaration with pending invites → validator passes", () => {
    const tpl = buildAudienceDeclaration({
      audIdPub: AUD_ID_PUB,
      slug: SLUG,
      name: "x",
      epoch: 2,
      epochPub: EPOCH_PUB,
      members: [MEMBER_PUB],
      pending: [{ invitePub: "9".repeat(64), expirationUnix: FUTURE }],
    });
    const signed = signEventWithRawKey(tpl, AUD_ID_PRIV);
    expect(validateAudienceEvent(signed)).toEqual({ ok: true });
  });

  it("founding key-grant → validator passes (signed by aud_id)", () => {
    const ciphertext = nip44Encrypt(EPOCH_PRIV, AUD_ID_PRIV, MEMBER_PUB);
    const tpl = buildKeyGrant({
      audIdPub: AUD_ID_PUB,
      slug: SLUG,
      epoch: 1,
      recipientPub: MEMBER_PUB,
      ciphertext,
    });
    const signed = signEventWithRawKey(tpl, AUD_ID_PRIV);
    const lookup = {
      currentDeclarationByAddress: () => ({
        audIdPub: AUD_ID_PUB,
        slug: SLUG,
        epoch: 1,
        epochPub: EPOCH_PUB,
        members: [MEMBER_PUB],
        pending: [],
        status: "active" as const,
      }),
    };
    expect(validateKeyGrantEvent(signed, lookup)).toEqual({ ok: true });
  });

  it("audience claim → validator passes (signed by invite_priv)", () => {
    const INVITE_PRIV = hexToBytes(
      "4444444444444444444444444444444444444444444444444444444444444444",
    );
    const INVITE_PUB = bytesToHex(schnorr.getPublicKey(INVITE_PRIV));
    const CLAIM_PUB = "c".repeat(64);
    const INVITER_PUB = "9".repeat(64);
    const tpl = buildAudienceClaim({
      audIdPub: AUD_ID_PUB,
      slug: SLUG,
      epoch: 1,
      invitePub: INVITE_PUB,
      inviterPub: INVITER_PUB,
      claimPub: CLAIM_PUB,
      note: "thanks!",
      expiration: FUTURE,
    });
    const signed = signEventWithRawKey(tpl, INVITE_PRIV);
    const lookup = {
      currentDeclarationByAddress: () => ({
        audIdPub: AUD_ID_PUB,
        slug: SLUG,
        epoch: 1,
        epochPub: EPOCH_PUB,
        members: [],
        pending: [{ invitePub: INVITE_PUB, expirationUnix: FUTURE }],
        status: "active" as const,
      }),
    };
    expect(validateAudienceClaimEvent(signed, lookup)).toEqual({ ok: true });
  });

  it("encrypted variant → validator passes for kind:30510", () => {
    const PUBLISHER_PRIV = MEMBER_PRIV;
    const payload = JSON.stringify({
      "@context": "https://4a4.ai/ns/v0",
      "@type": "Observation",
      "schema:about": "https://example.org/note-1",
    });
    const ciphertext = nip44EncryptString(payload, PUBLISHER_PRIV, EPOCH_PUB);
    const tpl = buildEncryptedVariant({
      kind: 30510,
      audIdPub: AUD_ID_PUB,
      slug: SLUG,
      epoch: 1,
      members: [MEMBER_PUB],
      dTag: "team-design-note-1",
      alt: "encrypted Observation in team-design",
      ciphertext,
    });
    const signed = signEventWithRawKey(tpl, PUBLISHER_PRIV);
    const lookup = {
      currentDeclarationByAddress: () => ({
        audIdPub: AUD_ID_PUB,
        slug: SLUG,
        epoch: 1,
        epochPub: EPOCH_PUB,
        members: [MEMBER_PUB],
        pending: [],
        status: "active" as const,
      }),
    };
    expect(validateEncryptedVariantEvent(signed, lookup)).toEqual({ ok: true });
  });

  it("audienceAddress + parseAudienceAddress round-trip", () => {
    const addr = audienceAddress(AUD_ID_PUB, SLUG);
    const parsed = parseAudienceAddress(addr);
    expect(parsed?.pubkey).toEqual(AUD_ID_PUB);
    expect(parsed?.slug).toEqual(SLUG);
    expect(parsed?.kind).toEqual(30520);
    expect(parseAudienceAddress("not-an-address")).toBeNull();
    expect(parseAudienceAddress("30501:" + AUD_ID_PUB + ":" + SLUG)).toBeNull();
  });
});
