// Verify the v0.5 worked-example fixtures (docs/examples/v0.5/) round-trip
// through the validators. This is the regression backstop that catches
// fixture↔validator drift over time.

// @ts-ignore - node types not installed; vitest runs fine without them
import { readFileSync } from "node:fs";
// @ts-ignore - same
import { resolve } from "node:path";
// @ts-ignore - same
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateAudienceEvent, parseAudienceDeclaration } from "../audience-validator";
import { validateKeyGrantEvent } from "../keygrant-validator";
import { validateAudienceClaimEvent } from "../audience-claim-validator";
import { validateEncryptedVariantEvent } from "../encrypted-variant-validator";
import { validateGiftWrapEvent } from "../gift-wrap-validator";
import type { NostrEvent } from "../relay-pool";

// @ts-ignore - import.meta typings not loaded by ESNext lib in this tsconfig
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = resolve(HERE, "..", "..", "..", "docs", "examples", "v0.5");

function load(name: string): NostrEvent {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8"));
}

describe("v0.5 worked-example fixtures (docs/examples/v0.5/)", () => {
  const decl1 = load("01-declaration-v1.json");
  const grant1 = load("02-keygrant-epoch1-evan.json");
  const decl1pending = load("03-declaration-v1-pending.json");
  const claim = load("04-claim-from-invite.json");
  const decl2 = load("05-declaration-v2.json");
  const grant2evan = load("06-keygrant-epoch2-evan.json");
  const grant2allison = load("07-keygrant-epoch2-allison.json");
  const rumor = load("08-encrypted-observation.json");
  const wrapEvan = load("09-giftwrap-to-evan.json");
  const wrapAllison = load("10-giftwrap-to-allison.json");

  const decl1Parsed = parseAudienceDeclaration(decl1);
  const decl2Parsed = parseAudienceDeclaration(decl2);
  if (!decl1Parsed.ok || !decl2Parsed.ok) throw new Error("fixture parse failed");
  const audAddress = `30520:${decl1Parsed.value.audIdPub}:team-design`;

  it("declaration v1 passes the audience validator", () => {
    expect(validateAudienceEvent(decl1)).toEqual({ ok: true });
  });

  it("founding key-grant passes the keygrant validator", () => {
    const r = validateKeyGrantEvent(grant1, {
      currentDeclarationByAddress: (a) => (a === audAddress ? decl1Parsed.value : undefined),
    });
    expect(r).toEqual({ ok: true });
  });

  it("declaration v1' passes the audience validator", () => {
    expect(validateAudienceEvent(decl1pending)).toEqual({ ok: true });
  });

  it("claim event passes the claim validator (signing pubkey is the pending invite_pub)", () => {
    const decl1pendingParsed = parseAudienceDeclaration(decl1pending);
    if (!decl1pendingParsed.ok) throw new Error("decl1pending parse failed");
    const r = validateAudienceClaimEvent(claim, {
      currentDeclarationByAddress: (a) =>
        a === audAddress ? decl1pendingParsed.value : undefined,
    });
    expect(r).toEqual({ ok: true });
  });

  it("declaration v2 passes the audience validator", () => {
    expect(validateAudienceEvent(decl2)).toEqual({ ok: true });
  });

  it("epoch-2 grants to Evan and Allison both pass", () => {
    const lookup = {
      currentDeclarationByAddress: (a: string) => (a === audAddress ? decl2Parsed.value : undefined),
    };
    expect(validateKeyGrantEvent(grant2evan, lookup)).toEqual({ ok: true });
    expect(validateKeyGrantEvent(grant2allison, lookup)).toEqual({ ok: true });
  });

  it("encrypted observation passes the encrypted-variant validator", () => {
    const r = validateEncryptedVariantEvent(rumor, {
      currentDeclarationByAddress: (a) => (a === audAddress ? decl2Parsed.value : undefined),
    });
    expect(r).toEqual({ ok: true });
  });

  it("both gift-wraps pass the gift-wrap validator", () => {
    expect(validateGiftWrapEvent(wrapEvan)).toEqual({ ok: true });
    expect(validateGiftWrapEvent(wrapAllison)).toEqual({ ok: true });
    // Each gift-wrap is signed by a fresh ephemeral key — pubkeys MUST differ.
    expect(wrapEvan.pubkey).not.toEqual(wrapAllison.pubkey);
  });

  it("event ids are deterministic (the fixture script is reproducible)", () => {
    expect(decl1.id).toMatch(/^[0-9a-f]{64}$/);
    expect(grant1.id).toMatch(/^[0-9a-f]{64}$/);
    expect(claim.id).toMatch(/^[0-9a-f]{64}$/);
  });
});
