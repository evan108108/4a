// kinds 30550-30554 fa:Kanban* validators (evenflow EFB-24).
//
// The public half of the evenflow board vocabulary. Private boards gift-wrap
// their events as 30555-30557 and publish through /v0/audience/raw/publish-
// wraps, so nothing encrypted ever reaches this file; everything that does is
// already meant to be world-readable.
//
// Same split as the 30560 tide (kanban-tide-validator.ts): evenflow builds and
// SIGNS these with its own key, the gateway validates and fans out. The
// gateway holds no key for them and never re-signs.
//
// All five are parameterized-replaceable, so the `d` tag is the entity's
// identity and a republish CORRECTS that entity rather than appending. That is
// what lets a consumer rebuild evenflow's caches by replay, and it is why the
// per-kind checks below pin which id belongs in `d`: key an issue on its board
// and every issue on that board collapses onto one event.
//
// Standalone module (no Workers-runtime imports) so it unit-tests like the
// other validators — publish.ts transitively pulls relay-pool.ts and
// `cloudflare:workers`, which the Node test runner can't load.

import { blake3ContentTag } from "./lib/blake3-tag";

export const KIND_KANBAN_BOARD = 30550;
export const KIND_KANBAN_ISSUE = 30551;
export const KIND_KANBAN_COMMENT = 30552;
export const KIND_KANBAN_STATUS_CHANGE = 30553;
export const KIND_KANBAN_SPRINT = 30554;

const CONTEXT_URL = "https://4a4.ai/ns/v0";

/** Minimal shape this validator needs; SignedEvent satisfies it. */
export interface KanbanEventLike {
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
}

export interface KanbanValidationOk {
  readonly ok: true;
  readonly value: {
    readonly kind: number;
    readonly type: string;
    readonly boardId: string;
    readonly dTag: string;
    /** Present on the kinds that hang off an issue (comment, status change). */
    readonly issueId: string | null;
    readonly sprintId: string | null;
    readonly deleted: boolean;
  };
}

export interface KanbanValidationErr {
  readonly ok: false;
  readonly error: string;
}

export type KanbanValidationResult = KanbanValidationOk | KanbanValidationErr;

const findTag = (tags: string[][], name: string): string | undefined =>
  tags.find((t) => t[0] === name)?.[1];

const fail = (error: string): KanbanValidationErr => ({ ok: false, error });

interface KindSpec {
  /** content["@type"] this kind must carry. */
  readonly type: string;
  /**
   * fa: tags required beyond the shared envelope. The `d` tag's identity is
   * checked against the first entry when `dFromTag` is set — that is how each
   * kind pins its own entity rather than accepting any id.
   */
  readonly requiredTags: readonly string[];
  /**
   * Which tag `d` must equal, when the identity is mirrored in a tag.
   * KanbanBoard mirrors fa:board; KanbanSprint mirrors fa:sprint. Issues,
   * comments and status changes carry ids that appear nowhere else, so `d` is
   * only required to be non-empty for them.
   */
  readonly dFromTag?: string;
}

const SPECS: Readonly<Record<number, KindSpec>> = {
  [KIND_KANBAN_BOARD]: {
    type: "KanbanBoard",
    requiredTags: ["fa:slug"],
    dFromTag: "fa:board",
  },
  [KIND_KANBAN_ISSUE]: {
    type: "KanbanIssue",
    requiredTags: ["fa:type", "fa:status", "fa:container"],
  },
  [KIND_KANBAN_COMMENT]: {
    type: "KanbanComment",
    requiredTags: ["fa:issue"],
  },
  [KIND_KANBAN_STATUS_CHANGE]: {
    type: "KanbanStatusChange",
    requiredTags: ["fa:issue"],
  },
  [KIND_KANBAN_SPRINT]: {
    type: "KanbanSprint",
    requiredTags: ["fa:sprint", "fa:status"],
    dFromTag: "fa:sprint",
  },
};

/**
 * Validate a caller-signed 30550-30554.
 *
 * Signature and canonical id are NOT checked here — `requireSignedEvent` in
 * audience-raw.ts does that before this runs. This is purely about whether the
 * event says something coherent.
 */
export function validateKanbanPlaintextEvent(event: KanbanEventLike): KanbanValidationResult {
  const spec = SPECS[event.kind];
  if (spec === undefined) {
    return fail(`kind must be one of 30550-30554, got ${event.kind}`);
  }

  if (findTag(event.tags, "fa:context") !== CONTEXT_URL) {
    return fail(`tag "fa:context" must equal "${CONTEXT_URL}"`);
  }

  const boardId = findTag(event.tags, "fa:board");
  if (boardId === undefined || boardId.length === 0) {
    return fail('tag "fa:board" missing or empty');
  }

  const dTag = findTag(event.tags, "d");
  if (dTag === undefined || dTag.length === 0) {
    return fail('tag "d" missing or empty');
  }
  if (spec.dFromTag !== undefined) {
    const expected = findTag(event.tags, spec.dFromTag);
    if (dTag !== expected) {
      return fail(`tag "d" must equal tag "${spec.dFromTag}" (${expected ?? "missing"})`);
    }
  }

  for (const name of spec.requiredTags) {
    const v = findTag(event.tags, name);
    if (v === undefined || v.length === 0) {
      return fail(`tag "${name}" missing or empty`);
    }
  }

  const alt = findTag(event.tags, "alt");
  if (alt === undefined || alt.length === 0) {
    return fail('tag "alt" missing or empty');
  }
  const blake3 = findTag(event.tags, "blake3");
  if (blake3 === undefined) {
    return fail('tag "blake3" missing');
  }
  if (blake3 !== blake3ContentTag(event.content)) {
    return fail('tag "blake3" does not match content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return fail("content must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("content must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  if (body["@context"] !== CONTEXT_URL) {
    return fail(`content @context must equal "${CONTEXT_URL}"`);
  }
  if (body["@type"] !== spec.type) {
    return fail(`content @type must equal "${spec.type}" for kind ${event.kind}`);
  }

  // A tombstone is a normal replaceable event carrying deleted:true at the
  // entity's own address — evenflow does NOT use NIP-09 here, because a
  // deletion published anywhere else would leave the last live version
  // standing and a replaying consumer would resurrect the entity.
  const deletedRaw = body["deleted"];
  if (deletedRaw !== undefined && typeof deletedRaw !== "boolean") {
    return fail("content deleted must be a boolean when present");
  }

  return {
    ok: true,
    value: {
      kind: event.kind,
      type: spec.type,
      boardId,
      dTag,
      issueId: findTag(event.tags, "fa:issue") ?? null,
      sprintId: findTag(event.tags, "fa:sprint") ?? null,
      deleted: deletedRaw === true,
    },
  };
}
