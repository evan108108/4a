// Unit tests for validateCommentEvent.
//
// Fixtures derive from the canonical example in SPEC-phase3-credibility.md §3.4.
// The `blake3` tag is computed at test time via the same helper the validator
// uses.

import { describe, expect, it } from "vitest";
import { blake3ContentTag } from "../lib/blake3-tag";
import { validateCommentEvent } from "../comment-validator";
import type { NostrEvent } from "../relay-pool";

const SPEC_COMMENT_CONTENT =
  '{"@context":"https://4a4.ai/ns/v0","@type":"Comment","intent":"justify","body":"Reproduced the benchmark on commit 7f3c with identical wall-clock numbers (±2%). The claim\'s confidence interval seems tight but within tolerance for the workload class. Marking 0.82 rather than 0.95 because I did not reproduce the cold-start path.","target":{"@id":"nostr:5a2c3f9e4b1d7a6e8c0f1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f"}}';

const SCORE_EVENT_ID =
  "5a2c3f9e4b1d7a6e8c0f1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f";

function canonicalCommentEvent(
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  const content = overrides.content ?? SPEC_COMMENT_CONTENT;
  return {
    id: "1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890",
    pubkey:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    created_at: 1777344610,
    kind: 30507,
    tags: [
      ["d", "justify-score-9f8e7d6c-1"],
      ["e", SCORE_EVENT_ID],
      [
        "a",
        "30506:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:9f8e7d6c5b4a39281706f5e4d3c2b1a0908070605040302010f0e0d0c0b0a090",
      ],
      ["blake3", blake3ContentTag(content)],
      ["alt", "rationale for score 0.82 of claim 9f8e7d6c…"],
      ["fa:context", "https://4a4.ai/ns/v0"],
    ],
    content,
    sig:
      "deadbeef00000000000000000000000000000000000000000000000000000000" +
      "deadbeef00000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

describe("validateCommentEvent", () => {
  it("accepts the canonical SPEC §3.4 example", () => {
    const result = validateCommentEvent(canonicalCommentEvent());
    expect(result).toEqual({ ok: true });
  });

  it("rejects content that is missing `body`", () => {
    const content =
      '{"@context":"https://4a4.ai/ns/v0","@type":"Comment","intent":"justify","target":{"@id":"nostr:' +
      SCORE_EVENT_ID +
      '"}}';
    const event = canonicalCommentEvent({ content });
    event.tags = event.tags.map((t) =>
      t[0] === "blake3" ? ["blake3", blake3ContentTag(content)] : t,
    );
    const result = validateCommentEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/missing body/);
  });

  it("rejects an event missing the `e` tag", () => {
    const event = canonicalCommentEvent();
    event.tags = event.tags.filter((t) => t[0] !== "e");
    const result = validateCommentEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/missing required tag "e"/);
  });

  it("rejects a BLAKE3 tag that does not match the content", () => {
    const event = canonicalCommentEvent();
    event.tags = event.tags.map((t) =>
      t[0] === "blake3" ? ["blake3", "bk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] : t,
    );
    const result = validateCommentEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blake3 tag mismatch/);
  });

  it("rejects a kind other than 30507", () => {
    const event = canonicalCommentEvent({ kind: 30506 });
    const result = validateCommentEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/kind must be 30507/);
  });
});
