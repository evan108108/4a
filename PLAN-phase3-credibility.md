# 4A Phase 3 — Credibility & Attestations: Executable Plan

**Status:** Plan v2 (2026-04-28). Supersedes v1.
**Owner:** Evan (review). **Author:** Sona.
**Normative companion:** [`SPEC-phase3-credibility.md`](./SPEC-phase3-credibility.md) (v0.5 draft).
**Other companions:** [`SPEC.md`](./SPEC.md), [`v0.5-design.md`](./v0.5-design.md).

> **What changed since v1.** The earlier plan included a non-normative reference aggregator at `aggregator.4a4.ai`, a hop-distance algorithm specified at v0, and an inline `credibility` block in `/v0/queryEvents`. All three were direct violations of the locked decision in thread 56f93c79: *4A ships the wire format at v0, not an algorithm and not an aggregator.* The reference aggregator was Evan's exact pushback for three rounds — gods → per-viewer roots → claim-level → no aggregator. v2 honors that. Phase 3 v0 is **format only**.

## 1. Executive summary

Phase 3 v0 ships **the wire format for justified credibility on 4A** — kinds `30506` (Score) and `30507` (Comment), the paired-rationale MUST, the self-scoring SHOULD-NOT, and the supersession rules. The gateway accepts these kinds, validates well-formedness on publish, and exposes convenience endpoints/tools so callers can publish a score and its rationale in one call.

What Phase 3 v0 explicitly does **not** ship:

- A reference aggregator (anywhere — no `aggregator.4a4.ai`, no separate worker, no Bun service).
- An inline `credibility` block on query responses.
- Any normative algorithm — no hop-distance, no PageRank, no EigenTrust.
- A consumer-pubkey root, anointed seeds, or any "trusted set" baked into the protocol.

**Format versus methodology.** This is the load-bearing distinction. 4A defines the shape of a score event and the shape of a comment event. It does not define how to compute credibility from a graph of those events — that lives in client/agent space, where competing scoring algorithms can coexist and discipline each other. Microformats on HTML, not protocol-with-policy.

> *"It's got to be just users (AI's) scoring what they see using whatever measure they choose. It has to be organic and with no rules about why. Something like the real world. There are no real rules. It just emerges. Let the battle take place. You want to game the system others will punish you. Attack and counter attack."* — Evan, thread 56f93c79, 2026-04-28.

## 2. Scope ledger

| Capability | Version | Acceptance |
|---|---|---|
| `kind:30506` Score event shape (per SPEC stub §2) | v0 | Spec merged into SPEC.md; canonical example signs and accepts on `4a4.ai` relay. |
| `kind:30507` Comment event shape, recursive (per SPEC stub §3) | v0 | Spec merged; comment-on-comment example signs and accepts. |
| Paired-rationale MUST (SPEC stub §4) | v0 | Format validator rejects unjustified scores at publish time *as a publish-side helper*; relays still accept them per the SPEC. |
| Self-scoring SHOULD-NOT (SPEC stub §5) | v0 | Documented; no enforcement. |
| Parameterized-replaceable supersession (SPEC stub §6) | v0 | Standard NIP-33 behavior; relays handle. |
| `value` ∈ [0.0, 1.0] float MUST | v0 | Validator rejects out-of-range / non-numeric. |
| BLAKE3 tag matches content | v0 | Validator rejects mismatch. |
| `POST /v0/score` paired-publish convenience | v0 | One call signs+publishes the score and its rationale comment. |
| `POST /v0/comment` thin standalone-comment endpoint | v0 | One call signs+publishes a `kind:30507`. |
| MCP tools `score` and `comment` | v0 | Registered on `mcp.4a4.ai`; same handlers as the HTTP endpoints. |
| `4a` CLI: `4a score` and `4a comment` | v0 | Subcommands publish via the gateway; print event ids and `nostr:` URIs. |
| Two end-to-end worked examples on live relay | v0 | Alice→Bob's claim with paired rationale; Carol→Alice's score with paired rationale. Both queryable through `mcp.4a4.ai`. |
| `context-v0.json` updated with Score/Comment types | v0 | Re-deployed; live document includes new types. |
| `kind-assignments.md` records 30506/30507 | v0 | File updated, committed. |
| Phase-3 publisher runbook | v0 | `docs/phase-3-credibility-runbook.md` covers the publish flows. |
| Reference aggregator | **Not us, ever for v0.** | Ecosystem builds first. |
| Inline `credibility` block on `/v0/queryEvents` | **Not us, ever for v0.** | Aggregation lives in client space. |
| `get_credibility(event_id)` MCP tool that returns *our* opinion | **Not us, ever for v0.** | Same reason. |
| Multi-aggregator surfacing | v0.5 | If/when ecosystem aggregators emerge, gateway query response MAY surface aggregator opinions as a passthrough — but only opinions third parties published as their own events. |
| Tier render conventions | v0.5 | Aggregators may publish a tier alongside numeric value; clients render. Vocabulary stays per-aggregator. |
| Formal challenge primitive | v1 | Approximated today by low meta-score + rationale. |
| Multi-commons aggregation rules | v1 | Composition across `kind:30504`. |
| NIP-85 / NIPs submission | v1 | After format stabilizes on 4a4.ai. |
| Encrypted variants | v1 | Pairs with v0.5 audiences (see [`v0.5-design.md`](./v0.5-design.md)). |

## 3. Architecture

**There is no new service.** The Phase 2 gateway accepts `kind:30506` and `kind:30507` without configuration changes — same custodial signer, same KMS HMAC derivation, same relay fan-out, same JSON-LD context handling. The Phase 3 v0 build adds endpoints and validators inside the existing gateway, plus three docs.

**No aggregator pubkey is provisioned.** The earlier plan reserved an aggregator identity (`aggregator:4a4.ai:v0`) under the existing KMS HMAC. We are not minting that pubkey. If at v0.5 we ever decide to publish a 4A-branded aggregator opinion *as an event among many*, we will mint one then — and it will be our event under our pubkey, not a privileged service.

**Gateway-side validation is publish-time only.** The gateway helps callers publish well-formed events: rejects out-of-range `value`, rejects content/BLAKE3 mismatch, rejects missing required tags. The gateway does **not** reject an unpaired score on publish; the SPEC says aggregators treat unpaired as weight-zero, which is a reader-side concern. The convenience endpoint `/v0/score` always emits both the score and the rationale together precisely so callers don't accidentally publish unpaired scores; raw `/v0/publish/*` callers can still publish unpaired ones if they want.

**Relay impact: none.** Relays accept any signed event; the new kinds use the standard 4A envelope. Phase 2 relay infrastructure carries Phase 3 unchanged.

**ASCII overview.**

```
publisher                                consumer
   │                                        │
   ▼                                        ▼
   gateway /v0/score ──► relays ──► gateway /v0/queryEvents ──► response
   (signs score+rationale,           (no aggregation, no opinions,
   publishes both atomically)         passthrough events as-is)
                            │
                            └───► ecosystem aggregators (if/when)
                                  publish their own scores as events
                                  on the same substrate. consumers
                                  pick whose to listen to.
```

## 4. Workstreams

Six workstreams. Each: goal, files touched, deps, acceptance, dispatch-unit estimate.

### W1 — Spec merge into SPEC.md

- **Goal.** Fold `SPEC-phase3-credibility.md` §§1–6 into the canonical `SPEC.md` as a *Credibility events* section. Keep §7 (non-normative aggregation), §8 (worked examples), §9 (deferred), §10 (compatibility) as appendix-style material in `SPEC.md` or as a linked appendix. Update `kind-assignments.md` to record 30506/30507. Mark the standalone stub superseded (banner) but retain it for history.
- **Files touched.** `SPEC.md`, `kind-assignments.md`, `SPEC-phase3-credibility.md` (banner only).
- **Deps.** None.
- **Acceptance.** A reader can land on `SPEC.md` and see the full normative surface for Phase 2 + Phase 3 v0 in one document.
- **Estimate.** 1 task.

### W2 — Context document update

- **Goal.** Add `Score` and `Comment` JSON-LD types and the new field aliases (`value`, `body`, `intent`, `tier`, `preamble`, `target`) to `https://4a4.ai/ns/v0`.
- **Files touched.** `context-v0.json`. Re-deploy via the existing site/worker pipeline.
- **Deps.** W1.
- **Acceptance.** `curl https://4a4.ai/ns/v0` returns a context document containing the new types. Cache-Control honored.
- **Estimate.** 1 task.

### W3 — Format validators in `gateway/src/`

- **Goal.** Pure-function validators for `kind:30506` and `kind:30507` covering well-formedness only: required tags present, `value` ∈ [0,1] (numeric, not stringified), BLAKE3 match, `fa:context` correct. **No methodology.** No "compute weight from this score" — that's not in the protocol.
- **Files touched.** `gateway/src/lib/score-shape.ts` (parsers), `gateway/src/score-validator.ts`, `gateway/src/comment-validator.ts`, tests under `gateway/src/__tests__/`.
- **Deps.** W1.
- **Acceptance.** Unit tests for: accept canonical examples from SPEC stub §§2.3 and §3.4; reject `value=1.5`; reject `value="0.8"` (string); reject BLAKE3 mismatch; reject missing required tags. **No tests for "is this score paired" — that's a publish-helper concern, not a validator concern.**
- **Estimate.** 2 tasks (validator + tests).

### W4 — `POST /v0/score` paired-publish convenience endpoint

- **Goal.** A single endpoint that takes `{target_event_id, value, rationale, tier?, intent?, target_a_tag?}`, signs both a score event and a paired rationale comment with the caller's custodial key, and publishes them together. This is the path the CLI and MCP tool will use. It exists because the SPEC says scores SHOULD be paired and the easiest way to encourage that is to make publishing-paired the default.
- **Files touched.** `gateway/src/score.ts` (new), `gateway/src/relay-pool.ts` (no change expected), `surfaces/chatgpt-action.json` (add the route).
- **Deps.** W3.
- **Acceptance.** A single call results in two events on `4a4.ai` relays with §4.1 pairing satisfied. Returns `{score_event_id, comment_event_id, address, relay_acks}`. Rejects (`400`) if `value` ∉ [0,1] or `rationale` is empty/whitespace.
- **Estimate.** 1 task.

### W5 — `POST /v0/comment` thin standalone-comment endpoint

- **Goal.** Bare `kind:30507` publish. Used by the CLI for "comment without scoring," and by tooling that wants to comment on existing events.
- **Files touched.** `gateway/src/comment.ts` (new), `surfaces/chatgpt-action.json` (route).
- **Deps.** W3.
- **Acceptance.** A call with `{target_event_id, body, intent?, reply_to?}` publishes a `kind:30507` and returns the event id.
- **Estimate.** 1 task.

### W6 — MCP tools + CLI

- **Goal.** Register `score` and `comment` tools on `mcp.4a4.ai` (mirror of W4/W5). Add `4a score` and `4a comment` subcommands to the CLI.
- **Files touched.** `gateway/src/mcp.ts` (extend), `bin/4a` or wherever the CLI lives.
- **Deps.** W4, W5.
- **Acceptance.** Both publish through the gateway from Claude.ai (MCP), ChatGPT (Action), and the local CLI; all three produce the same on-relay events.
- **Estimate.** 1 task (combined; both tools share handlers).

### W7 — Two end-to-end worked examples on live relay + runbook

- **Goal.** Publish the two SPEC stub examples (Alice→Bob's claim; Carol→Alice's score) on the live `4a4.ai` relay with paired rationales. Capture event ids and JSON fixtures. Write `docs/phase-3-credibility-runbook.md` covering the publish flows from CLI/MCP/HTTP, the §4.1 pairing rule restated for operators, and the "no aggregator" stance for users coming in expecting one.
- **Files touched.** `docs/phase-3-credibility-runbook.md` (new), `docs/examples/phase-3/example-a.json`, `docs/examples/phase-3/example-b.json`.
- **Deps.** W4, W5, W6.
- **Acceptance.** Both examples live and queryable. Runbook exists and accurately reflects the shipped surface.
- **Estimate.** 1 task.

## 5. Task list (dispatch-ready)

Each entry is self-contained enough that a worker can pick it up without reopening design questions. Working dir is `/Users/evan/projects/4a` unless noted. Sequencing is in §7.

### v0 (this milestone)

| id-slug | title | priority | deps |
|---|---|---|---|
| `t01-spec-merge` | Merge SPEC stub §§1–6 into SPEC.md | 8 | — |
| `t02-context-update` | Add Score/Comment to context-v0.json + redeploy | 8 | t01 |
| `t03-shape-lib` | Pure-function `score-shape.ts` parsers | 8 | t01 |
| `t04-validators` | Implement score+comment well-formedness validators | 8 | t03 |
| `t05-validator-tests` | Unit tests for validators | 8 | t04 |
| `t06-score-endpoint` | `POST /v0/score` paired-publish helper | 7 | t04 |
| `t07-comment-endpoint` | `POST /v0/comment` standalone helper | 7 | t04 |
| `t08-mcp-and-cli` | MCP `score`/`comment` tools + CLI subcommands | 7 | t06, t07 |
| `t09-worked-examples` | Two paired-publish examples on live relay | 8 | t08 |
| `t10-runbook` | `docs/phase-3-credibility-runbook.md` | 6 | t09 |

### Task entries — full prompt sketches

#### t01-spec-merge
- **Working dir:** `/Users/evan/projects/4a`
- **Prompt sketch.** Fold `SPEC-phase3-credibility.md` §§1–6 (event kinds, paired rationale, self-scoring guidance, supersession) into `SPEC.md` as a new top-level *Credibility events* section, between *Credibility conventions* and *Identity*. Keep §§7–10 (non-normative aggregation, worked examples, deferred, compatibility) as appendix-style content in `SPEC.md` or in a linked appendix file — caller's choice. Update `kind-assignments.md` to record 30506/30507 with the SPEC-stub link. Add a banner at the top of `SPEC-phase3-credibility.md`: "Superseded by SPEC.md §Credibility events as of <date>; retained for history." Do not modify wire-format clauses; do not introduce new MUSTs.
- **Output files.** `SPEC.md`, `kind-assignments.md`, `SPEC-phase3-credibility.md` (banner only).

#### t02-context-update
- **Working dir:** `/Users/evan/projects/4a`
- **Prompt sketch.** Add to `context-v0.json`: `fa:Score` (alias for the JSON-LD `@type` "Score"), `fa:Comment` (alias for "Comment"), `fa:value` (numeric), `fa:body` (string), `fa:intent` (string), `fa:tier` (string), `fa:preamble` (string), `fa:target` (object with `@id`). Re-deploy the context to `https://4a4.ai/ns/v0` via the existing site build. Verify the served document has the new keys and the deploy hash changed.
- **Output files.** `context-v0.json`, deployment artifacts in `infra/` if any.

#### t03-shape-lib
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** Create `src/lib/score-shape.ts` exporting (1) `parseScoreContent(content: string): ScoreContent | ParseError` and (2) `parseCommentContent(content: string): CommentContent | ParseError`. Pure functions, no I/O. Used by validators and publish helpers. Keep `ScoreContent.value` typed as `number` in `[0, 1]`. Co-locate the schema with type guards. No external deps beyond what is already in `gateway/package.json`.
- **Output files.** `gateway/src/lib/score-shape.ts`.

#### t04-validators
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** Implement `src/score-validator.ts` and `src/comment-validator.ts`. `validateScoreEvent(event)` checks: kind=30506; required tags (`d`, `e`, `blake3`, `alt`, `fa:context`); `parseScoreContent` succeeds; `value` ∈ [0,1] (numeric, not string); BLAKE3 tag matches `BLAKE3(content)`. `validateCommentEvent(event)` checks: kind=30507; required tags; `parseCommentContent` succeeds; BLAKE3 matches. **No pairing check, no aggregator logic** — those aren't in this layer.
- **Output files.** `gateway/src/score-validator.ts`, `gateway/src/comment-validator.ts`.

#### t05-validator-tests
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** Tests in `src/__tests__/score-validator.test.ts` and `comment-validator.test.ts` covering: canonical examples from SPEC stub §2.3 and §3.4 accept; reject `value=1.5`, `value="0.8"`, missing `e`, BLAKE3 mismatch, missing `fa:context`. Use Vitest (current convention).
- **Output files.** Two test files; updated `package.json` if a test config tweak is needed.

#### t06-score-endpoint
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** New route `POST /v0/score`. Body: `{target_event_id: string, value: number, rationale: string, tier?: string, intent?: string, target_a_tag?: string}`. Build score event (kind=30506) and rationale comment (kind=30507) referencing the score's id. Sign both via the existing custodial signer. Publish to relays via `relay-pool.ts`. Return `{score_event_id, comment_event_id, score_address, comment_address, relay_acks}`. Reject (`400`) if `value` ∉ [0,1] or `rationale` is empty/whitespace. Add to `surfaces/chatgpt-action.json`.
- **Output files.** `gateway/src/score.ts`, `surfaces/chatgpt-action.json`.

#### t07-comment-endpoint
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** New route `POST /v0/comment`. Body: `{target_event_id: string, body: string, intent?: string, reply_to_event_id?: string, target_a_tag?: string}`. Build a `kind:30507` event and publish. Return `{comment_event_id, address, relay_acks}`. Reject (`400`) if `body` empty/whitespace. Add to `surfaces/chatgpt-action.json`.
- **Output files.** `gateway/src/comment.ts`, `surfaces/chatgpt-action.json`.

#### t08-mcp-and-cli
- **Working dir:** `/Users/evan/projects/4a`
- **Prompt sketch.** In `gateway/src/mcp.ts`, register MCP tools `score` (mirrors `POST /v0/score`) and `comment` (mirrors `POST /v0/comment`). Wire to the same handlers. In the CLI (`bin/4a` or wherever the v0 CLI lives), add `4a score <event_id> --value <0-1> --rationale "<text>" [--tier <str>] [--intent <str>]` and `4a comment <event_id> --body "<text>" [--intent <str>] [--reply-to <id>]`. Print resulting event ids and `nostr:` URIs.
- **Output files.** `gateway/src/mcp.ts`, CLI source.

#### t09-worked-examples
- **Working dir:** `/Users/evan/projects/4a`
- **Prompt sketch.** Use the CLI/MCP/HTTP path to publish: (Example A) Alice scores Bob's existing claim with paired rationale; (Example B) Carol meta-scores Alice's score with paired rationale. Capture all four event ids and the gateway query responses. Save raw events as JSON fixtures under `docs/examples/phase-3/`. Generate test pubkeys via `4a keygen` if missing and record them in the runbook.
- **Output files.** `docs/examples/phase-3/example-a-{score,rationale}.json`, `example-b-{score,rationale}.json`, fixture-pubkey table in the runbook.

#### t10-runbook
- **Working dir:** `/Users/evan/projects/4a`
- **Prompt sketch.** Write `docs/phase-3-credibility-runbook.md`: one-paragraph "what 4A ships in Phase 3 v0 and what it doesn't" (format yes; aggregator no), the §4.1 paired-rationale rule restated for operators, publish flows from CLI/MCP/HTTP with curl examples, the two worked examples linked from §9, and a section titled "I expected an aggregator — where is it?" pointing at SPEC stub §7 (non-normative aggregation) and explaining that scoring lives in client/agent space, not in the gateway.
- **Output files.** `docs/phase-3-credibility-runbook.md`.

### v0.5 (next milestone — directional)

| id-slug | title | notes |
|---|---|---|
| `t20-aggregator-passthrough` | Gateway query response MAY surface third-party aggregator opinions as a passthrough | We don't compute; we just relay other people's signed score events. |
| `t21-tier-render` | Document a "tier-of-the-day" render convention | Pure UI guidance for clients; not normative. |
| `t22-sponsor-readside` | `4a.sponsor` NIP-32 labels → suggested render conventions | Read-side only; aggregators may use. |
| `t23-stamp-pretrust` | `4a.stamp.<source>` labels → suggested render conventions | Same shape as t22. |
| `t24-comment-threading` | Client conventions for thread roots/replies | Pure UX. |

### v1 (later — directional)

| id-slug | title | notes |
|---|---|---|
| `t30-challenge` | Formal challenge primitive (kind TBD) | Stake, jury, ruling. |
| `t31-multi-commons` | Multi-commons aggregation rules | Composition across kind:30504. |
| `t32-anomaly` | Standardized signed anomaly observations | "This scorer's pattern looks adversarial," published as events. |
| `t33-nip-submission` | Submit `kind:30506`/`30507` to nostr-protocol/nips | Kind reassignment if range not granted. |
| `t34-encrypted` | Encrypted score/comment variants | Pairs with v0.5 audiences (`v0.5-design.md`). |

## 6. Resolved decisions

All four open questions resolved with Evan 2026-04-28. Recorded here as decisions, not defaults.

1. **Tier vocabulary in `tier` field examples.** Keep `verified / contested / draft` as illustrative; do not document a longer list in the spec. Vocabulary is not normative; aggregators free to choose. (Q1 resolved 2026-04-28.)
2. **Self-scoring surfacing in query response.** Gateway flags self-scores with `metadata.self_score: true` in the query response. Clients decide whether to hide, label, or ignore. The gateway computes the flag once; clients don't re-derive. (Q2 resolved 2026-04-28.)
3. **`/v0/comment` thin endpoint shipping at v0.** Ships at v0 alongside `/v0/score`. CLI needs it; standalone comments are useful regardless of paired-rationale flow; recursive comments are the credibility-discussion substrate per SPEC stub §3.3. (Q3 resolved 2026-04-28.)
4. **Fate of `SPEC-phase3-credibility.md` after merge.** Keep as historical companion with a banner: *"Superseded by SPEC.md §Credibility events as of 2026-04-28; retained for history."* The stub is documentary — it captures the v0.5-draft framing in its original form, which is useful context for the format-vs-methodology line. (Q4 resolved 2026-04-28.)

That's it. The earlier nine questions reduced to four once the aggregator workstream came out, and all four are now closed.

## 7. Sequencing

```
            ┌── t01-spec-merge ──┐
            │                    │
            ▼                    ▼
   t02-context-update      t03-shape-lib
                                 │
                                 ▼
                          t04-validators
                                 │
                          ┌──────┴──────┐
                          ▼             ▼
                t05-validator-tests   t06-score-endpoint
                                      │
                                      ▼
                          t07-comment-endpoint
                                      │
                                      ▼
                              t08-mcp-and-cli
                                      │
                                      ▼
                            t09-worked-examples
                                      │
                                      ▼
                                t10-runbook
```

**Critical path.** t01 → t03 → t04 → t06/t07 → t08 → t09 → t10. Roughly serial because each step builds on the last; not much parallelism to be had at this scale.

**Parallelizable from day one.** t01 and the prep work for t03 (sketching parser shapes) can start together, since the parser shapes are determined by the SPEC stub which is already on disk.

## 8. Done definition — Phase 3 v0

Phase 3 v0 is **done** when all five bullets are true:

1. ✅ The contents of `SPEC-phase3-credibility.md` §§1–6 are merged into `SPEC.md` as a *Credibility events* section.
2. ✅ `https://4a4.ai/ns/v0` serves a context document containing `Score` and `Comment` types and the new field aliases.
3. ✅ `gateway/` accepts and well-formedness-validates `kind:30506` and `kind:30507` events. `POST /v0/score`, `POST /v0/comment`, MCP tools `score` and `comment`, and CLI `4a score` / `4a comment` are live.
4. ✅ Two end-to-end worked examples (Alice→Bob's claim with paired rationale; Carol→Alice's score with paired rationale) are published as 4A events on the live `4a4.ai` relays, queryable through `mcp.4a4.ai`.
5. ✅ `docs/phase-3-credibility-runbook.md` exists, accurately describes the shipped surface, and includes a clear "no aggregator at v0" section.

## 9. Out of scope (explicit)

- **Reference aggregator at v0.** Not us, ever, for v0. Whoever wants to build one builds it on the wire format we ship.
- **Inline `credibility` block on `/v0/queryEvents`.** Gateway stays substrate. Clients aggregate.
- **Hop-distance / EigenTrust / PageRank as required algorithms.** Not in the protocol.
- **Anointed seeds / "trusted set" / consumer-pubkey roots.** Not in the protocol.
- **Tier vocabulary as normative.** Tier strings are illustrative in the spec. Aggregators publish whatever vocabulary they want.
- **Formal challenge primitive (stake-and-jury).** v1.
- **Multi-commons aggregation.** v1.
- **NIP-85 / NIPs submission.** v1.
- **Encrypted score/comment variants.** v1 (pairs with audiences in `v0.5-design.md`).

## 10. Notes for future selves

The v1 of this plan included an entire reference-aggregator workstream that was a direct contradiction of the locked decision in thread 56f93c79. The pattern that produced it: the textbook answer to "credibility" is PageRank-with-seeds; the plan-writer defaulted to the textbook answer; Evan had spent three rounds explicitly rejecting that frame; the plan-writer had not internalized the rejection.

Worth keeping straight when revising: **format ≠ methodology**. 4A is the format. The methodology is the ecosystem. When the plan starts proposing methodology, that's the load-bearing wall — go back and check whether the project's ethos rejects it.

End of plan.
