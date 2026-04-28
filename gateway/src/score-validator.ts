// Well-formedness validator for kind:30506 (Score) events.
//
// Per SPEC.md §Credibility events / SPEC-phase3-credibility.md §2.1, a Score
// event MUST carry a fixed set of tags, a numeric `value` in [0, 1], a content
// payload that parses as a JSON-LD Score object, and a `blake3` tag matching
// BLAKE3(content). This validator checks all of that — and only that.
//
// Out of scope on purpose: paired-rationale resolution (§4.1) and any
// aggregator methodology. Those are not protocol-level format concerns.

import { blake3ContentTag } from "./lib/blake3-tag";
import {
  FA_CONTEXT_V0,
  parseScoreContent,
} from "./lib/score-shape";
import type { NostrEvent } from "./relay-pool";

const KIND_SCORE = 30506;

const REQUIRED_TAGS = ["d", "e", "blake3", "alt", "fa:context"] as const;

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

function findTag(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1];
  return undefined;
}

export function validateScoreEvent(event: NostrEvent): ValidationResult {
  if (event.kind !== KIND_SCORE) {
    return { ok: false, error: `kind must be ${KIND_SCORE}, got ${event.kind}` };
  }

  for (const name of REQUIRED_TAGS) {
    const value = findTag(event.tags, name);
    if (value === undefined || value.length === 0) {
      return { ok: false, error: `missing required tag "${name}"` };
    }
  }

  const faContext = findTag(event.tags, "fa:context");
  if (faContext !== FA_CONTEXT_V0) {
    return {
      ok: false,
      error: `fa:context must equal "${FA_CONTEXT_V0}", got "${faContext}"`,
    };
  }

  const parsed = parseScoreContent(event.content);
  if (!parsed.ok) {
    return { ok: false, error: `content: ${parsed.error}` };
  }

  // parseScoreContent already enforces value ∈ [0, 1] as a finite number, but
  // re-assert here so a refactor to the parser cannot silently weaken the
  // protocol-level guarantee.
  const { value } = parsed.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return { ok: false, error: "value must be a finite number in [0, 1]" };
  }

  const blake3Tag = findTag(event.tags, "blake3")!;
  const expected = blake3ContentTag(event.content);
  if (blake3Tag !== expected) {
    return {
      ok: false,
      error: `blake3 tag mismatch: tag="${blake3Tag}", expected="${expected}"`,
    };
  }

  return { ok: true };
}
