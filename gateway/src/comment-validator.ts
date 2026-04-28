// Well-formedness validator for kind:30507 (Comment) events.
//
// Per SPEC.md §Credibility events / SPEC-phase3-credibility.md §3.1, a Comment
// event MUST carry a fixed set of tags, a content payload that parses as a
// JSON-LD Comment object, and a `blake3` tag matching BLAKE3(content). This
// validator checks well-formedness only.
//
// Out of scope: paired-rationale resolution (§4.1), thread-shape conventions
// (§3.2), and any client/aggregator methodology.

import { blake3ContentTag } from "./lib/blake3-tag";
import {
  FA_CONTEXT_V0,
  parseCommentContent,
} from "./lib/score-shape";
import type { NostrEvent } from "./relay-pool";

const KIND_COMMENT = 30507;

const REQUIRED_TAGS = ["d", "e", "blake3", "alt", "fa:context"] as const;

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

function findTag(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1];
  return undefined;
}

export function validateCommentEvent(event: NostrEvent): ValidationResult {
  if (event.kind !== KIND_COMMENT) {
    return { ok: false, error: `kind must be ${KIND_COMMENT}, got ${event.kind}` };
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

  const parsed = parseCommentContent(event.content);
  if (!parsed.ok) {
    return { ok: false, error: `content: ${parsed.error}` };
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
