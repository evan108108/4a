// Round-trip tests for sonata-studio-v0 validators.
//
// Per sonata-studio-v0-spec.md §1–§9: each canonical example MUST validate;
// each kind has at least three plausible-but-invalid mutations that MUST fail.

import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { blake3ContentTag } from "../lib/blake3-tag";
import { encryptString as nip44EncryptString } from "../lib/nip44";
import type { AudienceLookup } from "../audience-validator";
import type { NostrEvent } from "../relay-pool";
import {
  STUDIO_KINDS,
  STUDIO_KIND_CARD,
  STUDIO_KIND_TRACK,
  STUDIO_KIND_DISPATCH_INTENT,
  STUDIO_KIND_COMMENT,
  STUDIO_KIND_QUESTION,
  STUDIO_KIND_ANSWER,
  STUDIO_KIND_ROOM,
  STUDIO_CONTEXT_V0,
  validateStudioWireEvent,
  validateCardPayload,
  validateTrackPayload,
  validateDispatchIntentPayload,
  validateCommentPayload,
  validateQuestionPayload,
  validateAnswerPayload,
  validateRoomPayload,
  payloadValidatorFor,
} from "../studio-v0/validators";

// --- shared audience fixtures (mirror encrypted-variant-validator.test.ts) --

const AUD_ID_PUB = "a".repeat(64);
const PUB_PRIV = hexToBytes(
  "1111111111111111111111111111111111111111111111111111111111111111",
);
const PUB_PUB = bytesToHex(schnorr.getPublicKey(PUB_PRIV));
const MEMBER_1 = "4".repeat(64);
const MEMBER_2 = "5".repeat(64);
const SLUG = "scout-acme-corp";
const EPOCH = 7;
const A_TAG = `30520:${AUD_ID_PUB}:${SLUG}`;

const EPOCH_PRIV = hexToBytes(
  "2222222222222222222222222222222222222222222222222222222222222222",
);
const EPOCH_PUB = bytesToHex(schnorr.getPublicKey(EPOCH_PRIV));

function ciphertextOf(plaintext: string): string {
  return nip44EncryptString(plaintext, PUB_PRIV, EPOCH_PUB);
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
          status: "active",
        }
      : undefined,
};

// --- §1 wire-level tests -----------------------------------------------------

function canonicalWireEvent(
  kind: number,
  dTag: string,
  innerPlaintext: string,
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  const ct = overrides.content ?? ciphertextOf(innerPlaintext);
  return {
    id: "deadbeef".repeat(8),
    pubkey: PUB_PUB,
    created_at: 1778098535,
    kind,
    tags: [
      ["d", dTag],
      ["fa:context", "https://4a4.ai/ns/v0"],
      ["alt", `Studio ${kind} in ${SLUG}`],
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

const CARD_PLAINTEXT = JSON.stringify({
  "@context": STUDIO_CONTEXT_V0,
  "@type": "Card",
  kind: "lead",
  track: "discovered",
  title: "Acme Corp — TechCrunch coverage",
  summary: "Series B announcement triggers AEC opportunity flag.",
  blocks: [{ type: "text", body: "long body" }],
  createdBy: "npub1exampleworker",
});

describe("validateStudioWireEvent", () => {
  it("accepts the canonical Card wire event", () => {
    const e = canonicalWireEvent(STUDIO_KIND_CARD, "card-acme-1", CARD_PLAINTEXT);
    expect(validateStudioWireEvent(e, lookup)).toEqual({ ok: true });
  });

  it("accepts every Studio kind 30530-30536", () => {
    for (const kind of STUDIO_KINDS) {
      const e = canonicalWireEvent(kind, `slug-${kind}`, CARD_PLAINTEXT);
      const r = validateStudioWireEvent(e, lookup);
      expect(r, `kind ${kind} expected ok, got ${JSON.stringify(r)}`).toEqual({ ok: true });
    }
  });

  it("rejects kind 30529 (out of Studio range)", () => {
    const e = canonicalWireEvent(STUDIO_KIND_CARD, "x", CARD_PLAINTEXT, { kind: 30529 });
    const r = validateStudioWireEvent(e, lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/30530-30536/);
  });

  it("rejects kind 30537 (reserved, not yet defined)", () => {
    const e = canonicalWireEvent(STUDIO_KIND_CARD, "x", CARD_PLAINTEXT, { kind: 30537 });
    const r = validateStudioWireEvent(e, lookup);
    expect(r.ok).toBe(false);
  });

  it("rejects when fa:context is the studio inner context (a common mistake)", () => {
    const e = canonicalWireEvent(STUDIO_KIND_CARD, "x", CARD_PLAINTEXT);
    e.tags = e.tags.map((t) =>
      t[0] === "fa:context" ? ["fa:context", STUDIO_CONTEXT_V0] : t,
    );
    const r = validateStudioWireEvent(e, lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/fa:context/);
  });

  it("rejects when blake3 tag does not match ciphertext", () => {
    const e = canonicalWireEvent(STUDIO_KIND_CARD, "x", CARD_PLAINTEXT);
    e.tags = e.tags.map((t) =>
      t[0] === "blake3" ? ["blake3", "bk-aaaa"] : t,
    );
    const r = validateStudioWireEvent(e, lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/blake3/);
  });

  it("rejects when p-tag set is missing a current member", () => {
    const e = canonicalWireEvent(STUDIO_KIND_CARD, "x", CARD_PLAINTEXT);
    e.tags = e.tags.filter((t) => !(t[0] === "p" && t[1] === MEMBER_2));
    const r = validateStudioWireEvent(e, lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/member set/);
  });

  it("rejects when content is not valid NIP-44 v2 ciphertext", () => {
    const bogus = "not-base64-at-all";
    const e = canonicalWireEvent(STUDIO_KIND_CARD, "x", CARD_PLAINTEXT, {
      content: bogus,
    });
    e.tags = e.tags.map((t) =>
      t[0] === "blake3" ? ["blake3", blake3ContentTag(bogus)] : t,
    );
    const r = validateStudioWireEvent(e, lookup);
    expect(r.ok).toBe(false);
  });

  it("rejects when fa:epoch does not match declaration", () => {
    const e = canonicalWireEvent(STUDIO_KIND_CARD, "x", CARD_PLAINTEXT);
    e.tags = e.tags.map((t) => (t[0] === "fa:epoch" ? ["fa:epoch", "9"] : t));
    const r = validateStudioWireEvent(e, lookup);
    expect(r.ok).toBe(false);
  });
});

// --- §3 Card payload ---------------------------------------------------------

const CANONICAL_CARD = {
  "@context": STUDIO_CONTEXT_V0,
  "@type": "Card",
  kind: "lead",
  track: "discovered",
  title: "Acme Corp — TechCrunch coverage",
  summary: "Series B announcement triggers AEC opportunity flag.",
  blocks: [
    { type: "text", body: "Long-form context about Acme Corp..." },
    { type: "link", href: "https://techcrunch.com/example", label: "Coverage" },
    { type: "field", key: "score", value: "0.78" },
  ],
  createdBy: "npub1examplepubkeyofthescoutworker",
  relatedTo: [],
  tags: ["scout", "high-priority"],
};

describe("validateCardPayload", () => {
  it("accepts the canonical Card example", () => {
    expect(validateCardPayload(CANONICAL_CARD)).toEqual({ ok: true });
  });
  it("rejects missing @context", () => {
    const c = { ...CANONICAL_CARD, "@context": "https://example.com/wrong" };
    const r = validateCardPayload(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/@context/);
  });
  it("rejects wrong @type", () => {
    const c = { ...CANONICAL_CARD, "@type": "Track" };
    expect(validateCardPayload(c).ok).toBe(false);
  });
  it("rejects missing track", () => {
    const c = { ...CANONICAL_CARD } as Record<string, unknown>;
    delete c.track;
    expect(validateCardPayload(c).ok).toBe(false);
  });
  it("rejects track that is not a slug", () => {
    const c = { ...CANONICAL_CARD, track: "has spaces" };
    const r = validateCardPayload(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/slug/);
  });
  it("rejects title exceeding 200 characters", () => {
    const c = { ...CANONICAL_CARD, title: "x".repeat(201) };
    expect(validateCardPayload(c).ok).toBe(false);
  });
  it("rejects a block missing the `type` field", () => {
    const c = { ...CANONICAL_CARD, blocks: [{ body: "no type" }] };
    expect(validateCardPayload(c).ok).toBe(false);
  });
});

// --- §4 Track payload --------------------------------------------------------

const CANONICAL_TRACK = {
  "@context": STUDIO_CONTEXT_V0,
  "@type": "Track",
  name: "enrich-acme-corp",
  title: "Enrich Acme Corp lead",
  description: "Discovery → enrichment → scoring for Acme Corp",
  layout: "column",
  createdBy: "npub1examplefounder",
  closedAt: null,
};

describe("validateTrackPayload", () => {
  it("accepts the canonical Track example", () => {
    expect(validateTrackPayload(CANONICAL_TRACK)).toEqual({ ok: true });
  });
  it("rejects layout outside the v0 enum", () => {
    const t = { ...CANONICAL_TRACK, layout: "kanban" };
    const r = validateTrackPayload(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/layout/);
  });
  it("rejects closedAt that is not null or a number", () => {
    const t = { ...CANONICAL_TRACK, closedAt: "2026-05-06" };
    expect(validateTrackPayload(t).ok).toBe(false);
  });
  it("rejects a name that is not a slug", () => {
    const t = { ...CANONICAL_TRACK, name: "has spaces" };
    expect(validateTrackPayload(t).ok).toBe(false);
  });
  it("accepts closedAt as a Unix timestamp", () => {
    const t = { ...CANONICAL_TRACK, closedAt: 1778098535 };
    expect(validateTrackPayload(t)).toEqual({ ok: true });
  });
});

// --- §5 DispatchIntent payload ----------------------------------------------

const CANONICAL_DI = {
  "@context": STUDIO_CONTEXT_V0,
  "@type": "DispatchIntent",
  eventId: "dce405255c7d4318aa45a0459a1c0433",
  candidates: ["worker-2", "worker-4", "scheduler"],
  chosen: "worker-2",
  reason: "worker-4 busy on prstar-pr-1234; worker-2 idle and event_type=email matches",
  signals: { "worker-2-status": "idle", "worker-4-status": "busy", "queue-depth": 3 },
  track: "scout-leads-2026-05",
  createdBy: "npub1examplesupervisor",
  createdAt: 1778098535152,
};

describe("validateDispatchIntentPayload", () => {
  it("accepts the canonical DispatchIntent example", () => {
    expect(validateDispatchIntentPayload(CANONICAL_DI)).toEqual({ ok: true });
  });
  it("rejects when chosen is not in candidates", () => {
    const d = { ...CANONICAL_DI, chosen: "worker-9" };
    const r = validateDispatchIntentPayload(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/candidates/);
  });
  it("rejects empty candidates array", () => {
    const d = { ...CANONICAL_DI, candidates: [] as string[] };
    expect(validateDispatchIntentPayload(d).ok).toBe(false);
  });
  it("rejects nested-object signal value (no nested objects in v0)", () => {
    const d = { ...CANONICAL_DI, signals: { worker: { status: "idle" } } };
    const r = validateDispatchIntentPayload(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/signals/);
  });
  it("rejects createdAt that is not a positive integer", () => {
    const d = { ...CANONICAL_DI, createdAt: -1 };
    expect(validateDispatchIntentPayload(d).ok).toBe(false);
  });
});

// --- §6 Comment payload -----------------------------------------------------

const CANONICAL_COMMENT = {
  "@context": STUDIO_CONTEXT_V0,
  "@type": "Comment",
  target: { "@id": "nostr:5a2c3f9e4b1d7a6e8c0f1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f" },
  body: "Confirmed via D1 — the lead is already in CBBLD with score 78.",
  createdBy: "npub1examplecommenter",
  intent: "verify",
};

describe("validateCommentPayload", () => {
  it("accepts the canonical Comment example", () => {
    expect(validateCommentPayload(CANONICAL_COMMENT)).toEqual({ ok: true });
  });
  it("rejects missing target.@id", () => {
    const c = { ...CANONICAL_COMMENT, target: {} };
    const r = validateCommentPayload(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/target/);
  });
  it("rejects target.@id with malformed identifier", () => {
    const c = { ...CANONICAL_COMMENT, target: { "@id": "not-a-valid-id" } };
    expect(validateCommentPayload(c).ok).toBe(false);
  });
  it("rejects empty body", () => {
    const c = { ...CANONICAL_COMMENT, body: "" };
    expect(validateCommentPayload(c).ok).toBe(false);
  });
  it("accepts target.@id as a 4A address", () => {
    const c = {
      ...CANONICAL_COMMENT,
      target: { "@id": `30530:${PUB_PUB}:card-acme-1` },
    };
    expect(validateCommentPayload(c)).toEqual({ ok: true });
  });
});

// --- §7 Question payload ----------------------------------------------------

const CANONICAL_QUESTION = {
  "@context": STUDIO_CONTEXT_V0,
  "@type": "Question",
  body: "Should the next pre-filter pass run rejection-sampling on usaspending or grants_gov first?",
  createdBy: "npub1examplequestioner",
  track: "scout-prefilter-tightening",
  tags: ["scout", "decision-needed"],
};

describe("validateQuestionPayload", () => {
  it("accepts the canonical Question example", () => {
    expect(validateQuestionPayload(CANONICAL_QUESTION)).toEqual({ ok: true });
  });
  it("rejects empty body", () => {
    const q = { ...CANONICAL_QUESTION, body: "" };
    expect(validateQuestionPayload(q).ok).toBe(false);
  });
  it("rejects body exceeding 4000 characters", () => {
    const q = { ...CANONICAL_QUESTION, body: "a".repeat(4001) };
    expect(validateQuestionPayload(q).ok).toBe(false);
  });
  it("rejects tags that include a non-string entry", () => {
    const q = { ...CANONICAL_QUESTION, tags: ["ok", 42] as unknown };
    expect(validateQuestionPayload(q).ok).toBe(false);
  });
});

// --- §8 Answer payload ------------------------------------------------------

const CANONICAL_ANSWER = {
  "@context": STUDIO_CONTEXT_V0,
  "@type": "Answer",
  target: { "@id": "nostr:8d7a6b5c4e3f2d1c0b9a8f7e6d5c4b3a2918273645546372819afedcba012345" },
  body: "Run rejection-sampling on usaspending first — bigger volume, bigger churn-reduction signal.",
  createdBy: "npub1exampleanswerer",
};

describe("validateAnswerPayload", () => {
  it("accepts the canonical Answer example", () => {
    expect(validateAnswerPayload(CANONICAL_ANSWER)).toEqual({ ok: true });
  });
  it("rejects missing target", () => {
    const a = { ...CANONICAL_ANSWER } as Record<string, unknown>;
    delete a.target;
    expect(validateAnswerPayload(a).ok).toBe(false);
  });
  it("rejects empty body", () => {
    const a = { ...CANONICAL_ANSWER, body: "" };
    expect(validateAnswerPayload(a).ok).toBe(false);
  });
  it("rejects wrong @type", () => {
    const a = { ...CANONICAL_ANSWER, "@type": "Comment" };
    expect(validateAnswerPayload(a).ok).toBe(false);
  });
});

// --- §9 Room payload --------------------------------------------------------

const CANONICAL_ROOM = {
  "@context": STUDIO_CONTEXT_V0,
  "@type": "Room",
  slug: "scout-acme-corp",
  title: "Scout — Acme Corp room",
  description: "Federated workspace for the Scout enrichment pipeline of Acme Corp.",
  project: "scout",
  defaultTracks: ["discovered", "enriched", "scored"],
  createdBy: "npub1examplefounder",
};

describe("validateRoomPayload", () => {
  it("accepts the canonical Room example", () => {
    expect(validateRoomPayload(CANONICAL_ROOM)).toEqual({ ok: true });
  });
  it("rejects slug that is not a valid audience slug", () => {
    const r = { ...CANONICAL_ROOM, slug: "has spaces" };
    const res = validateRoomPayload(r);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/slug/);
  });
  it("rejects defaultTracks entry that is not a slug", () => {
    const r = { ...CANONICAL_ROOM, defaultTracks: ["ok", "has spaces"] };
    expect(validateRoomPayload(r).ok).toBe(false);
  });
  it("rejects project that is not a slug", () => {
    const r = { ...CANONICAL_ROOM, project: "has spaces" };
    expect(validateRoomPayload(r).ok).toBe(false);
  });
  it("rejects missing createdBy", () => {
    const r = { ...CANONICAL_ROOM } as Record<string, unknown>;
    delete r.createdBy;
    expect(validateRoomPayload(r).ok).toBe(false);
  });
});

// --- dispatcher --------------------------------------------------------------

describe("payloadValidatorFor", () => {
  it("returns the matching validator for each Studio kind", () => {
    expect(payloadValidatorFor(STUDIO_KIND_CARD)).toBe(validateCardPayload);
    expect(payloadValidatorFor(STUDIO_KIND_TRACK)).toBe(validateTrackPayload);
    expect(payloadValidatorFor(STUDIO_KIND_DISPATCH_INTENT)).toBe(validateDispatchIntentPayload);
    expect(payloadValidatorFor(STUDIO_KIND_COMMENT)).toBe(validateCommentPayload);
    expect(payloadValidatorFor(STUDIO_KIND_QUESTION)).toBe(validateQuestionPayload);
    expect(payloadValidatorFor(STUDIO_KIND_ANSWER)).toBe(validateAnswerPayload);
    expect(payloadValidatorFor(STUDIO_KIND_ROOM)).toBe(validateRoomPayload);
  });

  it("returns undefined for reserved kinds 30537-30539", () => {
    for (const k of [30537, 30538, 30539]) {
      expect(payloadValidatorFor(k)).toBeUndefined();
    }
  });

  it("returns undefined for kinds outside the Studio range", () => {
    for (const k of [30529, 30540, 30510, 1059]) {
      expect(payloadValidatorFor(k)).toBeUndefined();
    }
  });
});
