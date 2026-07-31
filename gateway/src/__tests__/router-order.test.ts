// Router-order regression guard (evenflow EFB-22 / EFB-24).
//
// The bug this exists to stop has already shipped once. `/v0/publish/*` is
// matched by a generic `startsWith` that hands everything to publish.ts's
// JWT+KMS handler, which answers 404 "unknown publish path" for anything it
// doesn't know. The caller-signed NIP-98 kanban routes share that prefix, so
// if either is mounted BELOW the generic check it becomes unreachable — and
// the symptom is a 404 from a route that plainly exists in the source, which
// is a genuinely confusing afternoon.
//
// Comments at the mount sites say this. A comment did not prevent it the first
// time, so this asserts it instead.
//
// Deliberately a source-level check rather than a request-level one: router.ts
// transitively imports relay-pool.ts and `cloudflare:workers`, which the Node
// test runner cannot load. That is the same constraint that keeps the kanban
// validators in standalone modules.
//
// The source arrives via vite's `?raw` rather than node:fs — this project is
// typed for the Workers runtime and has no node types, so readFileSync/
// __dirname fail tsc even though they run fine under vitest.

import { describe, expect, it } from "vitest";
// @ts-expect-error — vite `?raw` import, no ambient declaration in this project.
import ROUTER from "../router.ts?raw";

/** Index of the generic catch-all that swallows unmatched /v0/publish/ paths. */
const genericPublishIndex = (): number => {
  const i = ROUTER.indexOf('url.pathname.startsWith("/v0/publish/")');
  expect(i, "generic /v0/publish/ startsWith not found — did router.ts change shape?").
    toBeGreaterThan(-1);
  return i;
};

describe("specific /v0/publish/* routes mount above the generic startsWith", () => {
  it.each([
    ["kanban tide (30560)", "KANBAN_TIDE_PATH"],
    ["kanban plaintext (30550-30554)", "KANBAN_PLAINTEXT_PATH"],
  ])("%s", (_label, constant) => {
    const mount = ROUTER.indexOf(`url.pathname === ${constant}`);
    expect(mount, `${constant} is not mounted in router.ts`).toBeGreaterThan(-1);
    expect(
      mount,
      `${constant} must be checked BEFORE the generic /v0/publish/ startsWith, ` +
        "or publish.ts swallows it and returns 404 unknown publish path",
    ).toBeLessThan(genericPublishIndex());
  });
});
