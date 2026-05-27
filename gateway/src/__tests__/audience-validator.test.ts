import { describe, expect, it } from "vitest";
import {
  parseAudienceDeclaration,
  validateAudienceEvent,
  type AudienceLookup,
} from "../audience-validator";
import type { NostrEvent } from "../relay-pool";

const AUD_ID_PUB = "a".repeat(64);
const EPOCH_PUB = "b".repeat(64);
const MEMBER_1 = "1".repeat(64);
const MEMBER_2 = "2".repeat(64);
const FUTURE = Math.floor(Date.now() / 1000) + 3600 * 24 * 7;

const VALID_CONTENT = JSON.stringify({
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Audience",
  name: "team-design",
  description: "design notes shared with Allison",
  epoch: 7,
});

function canonical(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "deadbeef".repeat(8),
    pubkey: AUD_ID_PUB,
    created_at: 1777344600,
    kind: 30520,
    tags: [
      ["d", "team-design"],
      ["fa:context", "https://4a4.ai/ns/v0"],
      ["alt", "Audience: team-design (2 members, epoch 7)"],
      ["fa:epoch", "7"],
      ["fa:epoch-pubkey", EPOCH_PUB],
      ["p", MEMBER_1],
      ["p", MEMBER_2],
    ],
    content: VALID_CONTENT,
    sig: "00".repeat(64),
    ...overrides,
  };
}

describe("validateAudienceEvent", () => {
  it("accepts a canonical SPEC-v0.5 §1 example", () => {
    expect(validateAudienceEvent(canonical())).toEqual({ ok: true });
  });

  it("rejects a missing fa:epoch tag", () => {
    const e = canonical();
    e.tags = e.tags.filter((t) => t[0] !== "fa:epoch");
    const r = validateAudienceEvent(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/fa:epoch/);
  });

  it("rejects fa:epoch with a leading zero", () => {
    const e = canonical();
    e.tags = e.tags.map((t) => (t[0] === "fa:epoch" ? ["fa:epoch", "07"] : t));
    const r = validateAudienceEvent(e);
    expect(r.ok).toBe(false);
  });

  it("rejects fa:epoch-pubkey that is not 32-byte hex", () => {
    const e = canonical();
    e.tags = e.tags.map((t) =>
      t[0] === "fa:epoch-pubkey" ? ["fa:epoch-pubkey", "abcd"] : t,
    );
    const r = validateAudienceEvent(e);
    expect(r.ok).toBe(false);
  });

  it("rejects content.epoch ≠ fa:epoch tag", () => {
    const content = JSON.stringify({
      "@context": "https://4a4.ai/ns/v0",
      "@type": "Audience",
      name: "x",
      description: "y",
      epoch: 99,
    });
    const r = validateAudienceEvent(canonical({ content }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/epoch/);
  });

  it("rejects an expired fa:pending tag", () => {
    const e = canonical();
    e.tags.push(["fa:pending", `${"c".repeat(64)}:1`]); // expired
    const r = validateAudienceEvent(e);
    expect(r.ok).toBe(false);
  });

  it("accepts a valid fa:pending tag with a future expiration", () => {
    const e = canonical();
    e.tags.push(["fa:pending", `${"c".repeat(64)}:${FUTURE}`]);
    expect(validateAudienceEvent(e)).toEqual({ ok: true });
  });

  it("rejects a pubkey rotation via the lookup hook (§1.4 invariant)", () => {
    const lookup: AudienceLookup = {
      priorAudienceDeclarationPubkey: () => "f".repeat(64),
    };
    const r = validateAudienceEvent(canonical(), lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot rotate/);
  });

  it("parseAudienceDeclaration extracts members and pending", () => {
    const e = canonical();
    e.tags.push(["fa:pending", `${"c".repeat(64)}:${FUTURE}`]);
    const r = parseAudienceDeclaration(e);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.epoch).toEqual(7);
      expect(r.value.members).toEqual([MEMBER_1, MEMBER_2]);
      expect(r.value.pending.length).toEqual(1);
      expect(r.value.pending[0]!.invitePub).toEqual("c".repeat(64));
    }
  });

  it("parseAudienceDeclaration still rejects an expired pending by default (publish-strict)", () => {
    const e = canonical();
    e.tags.push(["fa:pending", `${"c".repeat(64)}:1`]); // expired
    const r = parseAudienceDeclaration(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expiration is in the past/);
  });

  it("dropExpiredPending drops the lapsed invite instead of failing the declaration (read-strict)", () => {
    const e = canonical();
    e.tags.push(["fa:pending", `${"c".repeat(64)}:1`]); // expired ~lifecycle-normal
    e.tags.push(["fa:pending", `${"d".repeat(64)}:${FUTURE}`]); // still live
    const r = parseAudienceDeclaration(e, { dropExpiredPending: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The expired one is filtered out; the live one survives. Members are
      // untouched, so a member's stream still resolves.
      expect(r.value.members).toEqual([MEMBER_1, MEMBER_2]);
      expect(r.value.pending.map((p) => p.invitePub)).toEqual(["d".repeat(64)]);
    }
  });

  it("dropExpiredPending parses a declaration whose ONLY pending is expired", () => {
    const e = canonical();
    e.tags.push(["fa:pending", `${"c".repeat(64)}:1`]); // the project-studio repro
    const r = parseAudienceDeclaration(e, { dropExpiredPending: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pending).toEqual([]);
  });
});
