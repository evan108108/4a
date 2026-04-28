// Unit tests for validateScoreEvent.
//
// Fixtures derive from the canonical example in SPEC-phase3-credibility.md §2.3.
// The `blake3` tag is computed at test time via the same helper the validator
// uses, so any change to the BLAKE3 helper is picked up automatically.

import { describe, expect, it } from "vitest";
import { blake3ContentTag } from "../lib/blake3-tag";
import type { NostrEvent } from "../relay-pool";
import { validateScoreEvent } from "../score-validator";

const SPEC_SCORE_CONTENT =
  '{"@context":"https://4a4.ai/ns/v0","@type":"Score","value":0.82,"tier":"verified","target":{"@id":"nostr:9f8e7d6c5b4a39281706f5e4d3c2b1a0908070605040302010f0e0d0c0b0a090"}}';

const TARGET_ID =
  "9f8e7d6c5b4a39281706f5e4d3c2b1a0908070605040302010f0e0d0c0b0a090";

function canonicalScoreEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const content = overrides.content ?? SPEC_SCORE_CONTENT;
  return {
    id: "5a2c3f9e4b1d7a6e8c0f1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f",
    pubkey:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    created_at: 1777344600,
    kind: 30506,
    tags: [
      ["d", TARGET_ID],
      ["e", TARGET_ID],
      [
        "a",
        "30501:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210:next-jit-claim-1",
      ],
      ["blake3", blake3ContentTag(content)],
      ["alt", "score 0.82 of claim 9f8e7d6c…"],
      ["fa:context", "https://4a4.ai/ns/v0"],
    ],
    content,
    sig:
      "deadbeef00000000000000000000000000000000000000000000000000000000" +
      "deadbeef00000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

describe("validateScoreEvent", () => {
  it("accepts the canonical SPEC §2.3 example", () => {
    const result = validateScoreEvent(canonicalScoreEvent());
    expect(result).toEqual({ ok: true });
  });

  it("rejects value=1.5 (out of range)", () => {
    const content =
      '{"@context":"https://4a4.ai/ns/v0","@type":"Score","value":1.5,"target":{"@id":"nostr:' +
      TARGET_ID +
      '"}}';
    const event = canonicalScoreEvent({ content });
    // recompute blake3 for the new content so the failure is on value, not blake3
    event.tags = event.tags.map((t) =>
      t[0] === "blake3" ? ["blake3", blake3ContentTag(content)] : t,
    );
    const result = validateScoreEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/\[0, 1\]/);
  });

  it('rejects value="0.8" (string, not number)', () => {
    const content =
      '{"@context":"https://4a4.ai/ns/v0","@type":"Score","value":"0.8","target":{"@id":"nostr:' +
      TARGET_ID +
      '"}}';
    const event = canonicalScoreEvent({ content });
    event.tags = event.tags.map((t) =>
      t[0] === "blake3" ? ["blake3", blake3ContentTag(content)] : t,
    );
    const result = validateScoreEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/value must be a number/);
  });

  it("rejects an event missing the `e` tag", () => {
    const event = canonicalScoreEvent();
    event.tags = event.tags.filter((t) => t[0] !== "e");
    const result = validateScoreEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/missing required tag "e"/);
  });

  it("rejects a BLAKE3 tag that does not match the content", () => {
    const event = canonicalScoreEvent();
    event.tags = event.tags.map((t) =>
      t[0] === "blake3" ? ["blake3", "bk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] : t,
    );
    const result = validateScoreEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blake3 tag mismatch/);
  });

  it("rejects an fa:context other than the v0 URL", () => {
    const event = canonicalScoreEvent();
    event.tags = event.tags.map((t) =>
      t[0] === "fa:context" ? ["fa:context", "https://example.com/wrong"] : t,
    );
    const result = validateScoreEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fa:context must equal/);
  });

  it("rejects a kind other than 30506", () => {
    const event = canonicalScoreEvent({ kind: 30501 });
    const result = validateScoreEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/kind must be 30506/);
  });
});
