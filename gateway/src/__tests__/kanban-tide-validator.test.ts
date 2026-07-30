// kind:30560 fa:KanbanTideSnapshot validator (evenflow EFB-22).
//
// Evenflow builds and signs these itself; the gateway only checks them. So
// this file is the contract between the two repos — the same relationship
// audience-validator.ts has with evenflow's lib/audience/audience-events.ts.
// A change here that isn't mirrored there is a silent publish failure.
//
// Signature and canonical id are NOT this validator's job (requireSignedEvent
// handles those upstream), so nothing here signs anything.

import { describe, expect, it } from "vitest";
import { blake3ContentTag } from "../lib/blake3-tag";
import {
  KIND_KANBAN_TIDE,
  validateKanbanTideEvent,
  type TideEventLike,
} from "../kanban-tide-validator";

const CONTEXT = "https://4a4.ai/ns/v0";
const BOARD = "4042afb7-d1fe-4a80-a311-9de404b0ee14";
const SPRINT = "01e70cc9-0aaa-4ca9-88d4-ea897f42685e";
const DAY = "2026-07-29";

const content = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    "@context": CONTEXT,
    "@type": "KanbanTideSnapshot",
    committed_pts: 11,
    done_pts: 6,
    remaining_pts: 5,
    adds_today: 0,
    drops_today: 0,
    ...over,
  });

/** A valid sprint-scoped event; `over` replaces whole fields. */
const event = (over: Partial<TideEventLike> = {}, contentOver = {}): TideEventLike => {
  const body = content(contentOver);
  return {
    kind: KIND_KANBAN_TIDE,
    content: body,
    tags: [
      ["d", `${SPRINT}:${DAY}`],
      ["fa:context", CONTEXT],
      ["alt", `Tide ${DAY}: 5 of 11 pts remaining`],
      ["blake3", blake3ContentTag(body)],
      ["fa:board", BOARD],
      ["fa:day", DAY],
      ["fa:scope", "sprint"],
      ["fa:sprint", SPRINT],
    ],
    ...over,
  };
};

/** Rebuild tags with one entry replaced or removed (undefined = remove). */
const withTag = (name: string, value: string | undefined): TideEventLike => {
  const base = event();
  const tags = base.tags.filter((t) => t[0] !== name);
  if (value !== undefined) tags.push([name, value]);
  return { ...base, tags };
};

describe("validateKanbanTideEvent — accepts", () => {
  it("a sprint-scoped snapshot, returning the parsed reading", () => {
    const result = validateKanbanTideEvent(event());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      boardId: BOARD,
      sprintId: SPRINT,
      day: DAY,
      dTag: `${SPRINT}:${DAY}`,
      committedPts: 11,
      donePts: 6,
      remainingPts: 5,
    });
  });

  it("a kanban-only snapshot keyed on the board", () => {
    const body = content({ committed_pts: 3, done_pts: 0, remaining_pts: 3 });
    const result = validateKanbanTideEvent({
      kind: KIND_KANBAN_TIDE,
      content: body,
      tags: [
        ["d", `${BOARD}:${DAY}`],
        ["fa:context", CONTEXT],
        ["alt", `Tide ${DAY}: 3 of 3 pts remaining`],
        ["blake3", blake3ContentTag(body)],
        ["fa:board", BOARD],
        ["fa:day", DAY],
        ["fa:scope", "board"],
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sprintId).toBeNull();
  });

  it("an all-zero day — a brand-new sprint is not an error", () => {
    const result = validateKanbanTideEvent(
      event({}, { committed_pts: 0, done_pts: 0, remaining_pts: 0 }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("cross-repo contract", () => {
  // Captured verbatim from evenflow's buildSprintTide (lib/audience/
  // audience-events.ts). Evenflow builds and signs; this repo only checks —
  // so the two hold the shape independently and drift is a silent 400 in
  // production. Regenerate by logging a built template on the evenflow side.
  const GOLDEN: TideEventLike = {
    kind: 30560,
    tags: [
      ["d", "01e70cc9-0aaa-4ca9-88d4-ea897f42685e:2026-07-29"],
      ["fa:context", "https://4a4.ai/ns/v0"],
      ["alt", "Tide 2026-07-29: 5 of 11 pts remaining"],
      ["blake3", "bk-foiq6vdxzvjrj7nkrp2jthuve4qq55i7hzk4sd7h23jyj5smpxea"],
      ["fa:board", "4042afb7-d1fe-4a80-a311-9de404b0ee14"],
      ["fa:day", "2026-07-29"],
      ["fa:scope", "sprint"],
      ["fa:sprint", "01e70cc9-0aaa-4ca9-88d4-ea897f42685e"],
    ],
    content:
      '{"@context":"https://4a4.ai/ns/v0","@type":"KanbanTideSnapshot","committed_pts":11,"done_pts":6,"remaining_pts":5,"adds_today":0,"drops_today":0}',
  };

  it("accepts a real event built by evenflow", () => {
    const result = validateKanbanTideEvent(GOLDEN);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (result.ok) {
      expect(result.value.boardId).toBe("4042afb7-d1fe-4a80-a311-9de404b0ee14");
      expect(result.value.remainingPts).toBe(5);
    }
  });

  it("agrees with evenflow on the blake3 digest of that exact content", () => {
    // If either side changed how the content is serialized, this diverges.
    expect(blake3ContentTag(GOLDEN.content)).toBe(
      "bk-foiq6vdxzvjrj7nkrp2jthuve4qq55i7hzk4sd7h23jyj5smpxea",
    );
  });
});

describe("validateKanbanTideEvent — rejects", () => {
  const rejects = (e: TideEventLike, match: RegExp) => {
    const result = validateKanbanTideEvent(e);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(match);
  };

  it("the wrong kind", () => {
    rejects(event({ kind: 30565 }), /kind must be 30560/);
  });

  it("a missing or wrong fa:context", () => {
    rejects(withTag("fa:context", undefined), /fa:context/);
    rejects(withTag("fa:context", "https://example.com/ns"), /fa:context/);
  });

  it("a malformed fa:day", () => {
    for (const day of ["2026-7-9", "29-07-2026", "yesterday"]) {
      rejects(withTag("fa:day", day), /fa:day/);
    }
  });

  it("a d tag that omits the day", () => {
    // The whole point: without the day, each republish REPLACES the previous
    // one and a sprint keeps exactly one bar of history.
    rejects(withTag("d", SPRINT), /tag "d" must be/);
  });

  it("a d tag that disagrees with fa:day", () => {
    rejects(withTag("d", `${SPRINT}:2026-01-01`), /tag "d" must be/);
  });

  it("scope/sprint mismatches in both directions", () => {
    rejects(withTag("fa:sprint", undefined), /fa:sprint" is required/);
    const boardScoped = withTag("fa:scope", "board");
    rejects(boardScoped, /fa:sprint" must be absent/);
    rejects(withTag("fa:scope", "team"), /fa:scope/);
  });

  it("a blake3 tag that doesn't match the content", () => {
    rejects(withTag("blake3", "bk-notarealdigest"), /blake3" does not match/);
    rejects(withTag("blake3", undefined), /blake3" missing/);
  });

  it("a missing alt tag", () => {
    rejects(withTag("alt", undefined), /alt" missing/);
  });

  it("content that isn't the right JSON-LD shape", () => {
    const bad = (body: string): TideEventLike => {
      const base = event();
      return {
        ...base,
        content: body,
        tags: base.tags.map((t) => (t[0] === "blake3" ? ["blake3", blake3ContentTag(body)] : t)),
      };
    };
    rejects(bad("not json"), /valid JSON/);
    rejects(bad("[]"), /JSON object/);
    rejects(bad(JSON.stringify({ "@context": CONTEXT, "@type": "Wrong" })), /@type/);
  });

  it("points that are negative, fractional, or not numbers", () => {
    rejects(event({}, { committed_pts: -1 }), /committed_pts/);
    rejects(event({}, { done_pts: 1.5 }), /done_pts/);
    rejects(event({}, { remaining_pts: "5" }), /remaining_pts/);
    rejects(event({}, { adds_today: null }), /adds_today/);
  });

  it("readings that don't reconcile", () => {
    // Fanning out bad arithmetic would persist it on relays permanently.
    rejects(event({}, { remaining_pts: 4 }), /remaining_pts must equal/);
    rejects(event({}, { done_pts: 12, remaining_pts: -1 }), /done_pts|remaining_pts/);
  });
});
