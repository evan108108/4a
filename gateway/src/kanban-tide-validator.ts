// kind:30560 fa:KanbanTideSnapshot validator (evenflow EFB-22).
//
// One day's points-remaining reading for a sprint, or for a whole board when
// the team runs kanban-only. Evenflow computes the numbers by replaying its
// own audit rows, BUILDS AND SIGNS the event with its own key, and posts it
// NIP-98-authed. The gateway validates and fans out — it never signs a tide
// event and holds no key for one.
//
// That's the same split the audience family uses (evenflow's
// lib/audience/audience-events.ts builds, this repo's audience-validator.ts
// checks), and for the same reason: the publisher already has keys, so
// borrowing a gateway-derived identity would say something untrue about who
// authored the reading.
//
// Standalone module (no Workers-runtime imports) so it unit-tests like the
// other validators — publish.ts transitively pulls relay-pool.ts and
// `cloudflare:workers`, which the Node test runner can't load.
//
// The encrypted variant (30565) never comes through here: private boards
// gift-wrap their own and publish via /v0/audience/raw/publish-wraps. It also
// deliberately omits the fa:sprint / fa:day / fa:board tags below — on a
// private board those would leak in cleartext which sprint moved and when, so
// the encrypted envelope keeps them inside the ciphertext.

import { blake3ContentTag } from "./lib/blake3-tag";

export const KIND_KANBAN_TIDE = 30560;

const CONTEXT_URL = "https://4a4.ai/ns/v0";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Minimal shape this validator needs; SignedEvent satisfies it. */
export interface TideEventLike {
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
}

export interface TideValidationOk {
  readonly ok: true;
  /** Parsed for the response body and for logging — never re-signed. */
  readonly value: {
    readonly boardId: string;
    readonly sprintId: string | null;
    readonly day: string;
    readonly dTag: string;
    readonly committedPts: number;
    readonly donePts: number;
    readonly remainingPts: number;
  };
}

export interface TideValidationErr {
  readonly ok: false;
  readonly error: string;
}

export type TideValidationResult = TideValidationOk | TideValidationErr;

const findTag = (tags: string[][], name: string): string | undefined =>
  tags.find((t) => t[0] === name)?.[1];

const fail = (error: string): TideValidationErr => ({ ok: false, error });

/** Story points are whole and non-negative; anything else is sender error. */
const points = (raw: unknown, field: string): number | string => {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return `content.${field} must be a non-negative integer`;
  }
  return raw;
};

/**
 * Validate a caller-signed kind:30560.
 *
 * Signature and canonical id are NOT checked here — `requireSignedEvent` in
 * audience-raw.ts does that before this runs. This is purely about whether
 * the event says something coherent.
 */
export function validateKanbanTideEvent(event: TideEventLike): TideValidationResult {
  if (event.kind !== KIND_KANBAN_TIDE) {
    return fail(`kind must be ${KIND_KANBAN_TIDE}, got ${event.kind}`);
  }
  if (findTag(event.tags, "fa:context") !== CONTEXT_URL) {
    return fail(`tag "fa:context" must equal "${CONTEXT_URL}"`);
  }

  const boardId = findTag(event.tags, "fa:board");
  if (boardId === undefined || boardId.length === 0) {
    return fail('tag "fa:board" missing or empty');
  }
  const day = findTag(event.tags, "fa:day");
  if (day === undefined || !DAY_PATTERN.test(day)) {
    return fail('tag "fa:day" must be a YYYY-MM-DD calendar date');
  }
  const scope = findTag(event.tags, "fa:scope");
  if (scope !== "sprint" && scope !== "board") {
    return fail('tag "fa:scope" must be "sprint" or "board"');
  }
  const sprintId = findTag(event.tags, "fa:sprint") ?? null;
  if (scope === "sprint" && (sprintId === null || sprintId.length === 0)) {
    return fail('tag "fa:sprint" is required when fa:scope is "sprint"');
  }
  if (scope === "board" && sprintId !== null) {
    return fail('tag "fa:sprint" must be absent when fa:scope is "board"');
  }

  // 30560 is parameterized-replaceable, so the d tag decides what a republish
  // REPLACES. Keyed on the subject alone, every day of a sprint would collapse
  // onto one event and the sparkline would have a single bar — so the day is
  // required to be in there, and to agree with fa:day.
  const dTag = findTag(event.tags, "d");
  const subject = sprintId ?? boardId;
  if (dTag !== `${subject}:${day}`) {
    return fail(`tag "d" must be "${subject}:${day}", got ${dTag ?? "(missing)"}`);
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
  if (body["@type"] !== "KanbanTideSnapshot") {
    return fail('content @type must equal "KanbanTideSnapshot"');
  }

  const committedPts = points(body["committed_pts"], "committed_pts");
  if (typeof committedPts === "string") return fail(committedPts);
  const donePts = points(body["done_pts"], "done_pts");
  if (typeof donePts === "string") return fail(donePts);
  const remainingPts = points(body["remaining_pts"], "remaining_pts");
  if (typeof remainingPts === "string") return fail(remainingPts);
  const addsToday = points(body["adds_today"], "adds_today");
  if (typeof addsToday === "string") return fail(addsToday);
  const dropsToday = points(body["drops_today"], "drops_today");
  if (typeof dropsToday === "string") return fail(dropsToday);

  // Readings that don't reconcile mean the sender's arithmetic is wrong, and
  // fanning that out would persist the error on relays permanently.
  if (donePts > committedPts) {
    return fail("content done_pts cannot exceed committed_pts");
  }
  if (remainingPts !== committedPts - donePts) {
    return fail("content remaining_pts must equal committed_pts minus done_pts");
  }

  return {
    ok: true,
    value: { boardId, sprintId, day, dTag, committedPts, donePts, remainingPts },
  };
}
