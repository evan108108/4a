> **Superseded by [SPEC.md § Credibility events](./SPEC.md#credibility-events) as of 2026-04-28; retained for history.**

# 4A Phase 3 — Credibility & Attestations (v0.5 draft)

**Status:** Draft v0.5 (2026-04-28). Replaces and supersedes the v0 sketch in [`credibility-attestations.md`](./credibility-attestations.md). Subject to change pending NIP discussion.
**Convention name:** Agent-Agnostic Accessible Archive
**Version:** v0.5
**Context URL:** `https://4a4.ai/ns/v0`

## Conformance language

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) when, and only when, they appear in capitals.

## Scope

This document defines two new 4A event kinds — `kind:30506` (score) and `kind:30507` (comment) — and the normative rules governing how scorers, commenters, and aggregators interact. It does not specify how scores are computed; that is left to consumers and aggregators.

Reference aggregator implementation is deferred. The spec is publishable, signable, and queryable without one.

## 1. Event kinds

| Kind  | Object  | Replaceability                                |
| ----- | ------- | --------------------------------------------- |
| 30506 | Score   | Addressable by `d` (parameterized-replaceable) |
| 30507 | Comment | Addressable by `d` (parameterized-replaceable) |

Both kinds fall within the post-v0 reserved range (30505–30519) declared in [SPEC.md](./SPEC.md). They are 4A-native: they use the standard 4A envelope, JSON-LD `@context`, and required tags (`d`, `blake3`, `alt`, `fa:context`).

## 2. kind:30506 — Score event

A score event is a signed, weighted opinion about a target 4A object.

### 2.1 Required fields

A `kind:30506` event MUST carry:

| Tag           | Value                                              | Notes                                                                             |
| ------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `d`           | The target event id (32-byte hex)                  | Makes (`pubkey`, `kind=30506`, `d=target`) unique per scorer. Latest write wins.  |
| `e`           | Target event id                                    | NIP-01 reference. Same value as `d` for non-addressable targets.                  |
| `blake3`      | `bk-` + base32 BLAKE3 of `content`                 | Per [SPEC.md](./SPEC.md) §Content addressing.                                     |
| `alt`         | One-line human summary                             | NIP-31 fallback, e.g. `"score 0.82 of <event-id-prefix>"`.                        |
| `fa:context`  | `https://4a4.ai/ns/v0`                             | Per [SPEC.md](./SPEC.md) §Required tags.                                          |

The `content` field MUST be a stringified JSON-LD object containing:

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Score",
  "value": 0.82,
  "target": { "@id": "nostr:<bech32-or-hex-event-id>" }
}
```

The `value` field MUST be a number in the closed interval `[0.0, 1.0]`. Implementations MUST reject events whose `value` falls outside this range or is non-numeric.

### 2.2 Optional fields

| Field / Tag                  | Notes                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tier` (in `content`)         | A short categorical string (e.g. `"verified"`, `"contested"`, `"draft"`) for clients that prefer a chip render over a numeric one. |
| `preamble` (in `content`)    | Optional short human-readable preamble for the score. Long-form rationale belongs in the paired `kind:30507`, not here.            |
| `["a", "<kind>:<pubkey>:<d>"]` | When the target is itself an addressable 4A object, the `a` tag SHOULD be present alongside `e`.                                  |
| `["expiration", "<unix>"]`   | NIP-40. A score MAY declare its own staleness window.                                                                              |
| `["t", "<topic>"]`            | Topic tag, repeatable.                                                                                                             |

### 2.3 Canonical example

```json
{
  "id": "5a2c3f9e4b1d7a6e8c0f1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f",
  "pubkey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "created_at": 1777344600,
  "kind": 30506,
  "tags": [
    ["d",        "9f8e7d6c5b4a39281706f5e4d3c2b1a0908070605040302010f0e0d0c0b0a090"],
    ["e",        "9f8e7d6c5b4a39281706f5e4d3c2b1a0908070605040302010f0e0d0c0b0a090"],
    ["a",        "30501:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210:next-jit-claim-1"],
    ["blake3",   "bk-abcdefghijklmnopqrstuvwxyz234567"],
    ["alt",      "score 0.82 of claim 9f8e7d6c…"],
    ["fa:context", "https://4a4.ai/ns/v0"]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":\"Score\",\"value\":0.82,\"tier\":\"verified\",\"target\":{\"@id\":\"nostr:9f8e7d6c5b4a39281706f5e4d3c2b1a0908070605040302010f0e0d0c0b0a090\"}}",
  "sig": "deadbeef00000000000000000000000000000000000000000000000000000000deadbeef00000000000000000000000000000000000000000000000000000000"
}
```

## 3. kind:30507 — Comment event

A comment event is a signed prose response targeting any 4A event — including claims, scores, attestations, and other comments.

### 3.1 Required fields

A `kind:30507` event MUST carry:

| Tag           | Value                                | Notes                                                                                       |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `d`           | Stable per-comment slug              | A new `d` per distinct comment from the same author against the same target.                |
| `e`           | Direct target event id               | The event being commented on.                                                               |
| `blake3`      | `bk-` + base32 BLAKE3 of `content`   | Per [SPEC.md](./SPEC.md) §Content addressing.                                               |
| `alt`         | One-line human summary               | NIP-31 fallback.                                                                            |
| `fa:context`  | `https://4a4.ai/ns/v0`               | Per [SPEC.md](./SPEC.md) §Required tags.                                                    |

The `content` field MUST be a stringified JSON-LD object:

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Comment",
  "body": "<markdown-formatted prose>",
  "target": { "@id": "nostr:<event-id>" }
}
```

The `body` field MAY contain CommonMark-flavored Markdown. Consumers MUST be prepared to render or strip Markdown safely.

### 3.2 Optional fields

| Field / Tag                                      | Notes                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `["e", "<root-event-id>", "", "root"]`           | When commenting inside a thread, the thread root MAY be tagged with the `"root"` marker per NIP-10 conventions.                    |
| `["e", "<parent-comment-id>", "", "reply"]`      | When replying to another comment, the parent SHOULD be tagged with the `"reply"` marker.                                           |
| `["a", "<kind>:<pubkey>:<d>"]`                    | When the target is an addressable 4A object, the `a` tag SHOULD be present alongside `e`.                                          |
| `["p", "<pubkey>"]`                               | Pubkey of the target's author, when the comment is intended to notify them.                                                        |
| `intent` (in `content`)                           | Optional one-token classifier (e.g. `"justify"`, `"challenge"`, `"clarify"`). When pairing a rationale with a score, set to `"justify"`. |

### 3.3 Recursive commenting

A `kind:30507` event MAY target any 4A event, including another `kind:30507`. There is no nesting depth limit at the protocol level; consumers MAY impose one for rendering. Recursive comments form the credibility-discussion substrate: a comment on a score is a critique of the score; a comment on that critique is a rebuttal; and so on.

### 3.4 Canonical example

```json
{
  "id": "1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890",
  "pubkey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "created_at": 1777344610,
  "kind": 30507,
  "tags": [
    ["d",          "justify-score-9f8e7d6c-1"],
    ["e",          "5a2c3f9e4b1d7a6e8c0f1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f"],
    ["a",          "30506:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:9f8e7d6c5b4a39281706f5e4d3c2b1a0908070605040302010f0e0d0c0b0a090"],
    ["blake3",     "bk-bcdefghijklmnopqrstuvwxyz2345678"],
    ["alt",        "rationale for score 0.82 of claim 9f8e7d6c…"],
    ["fa:context", "https://4a4.ai/ns/v0"]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":\"Comment\",\"intent\":\"justify\",\"body\":\"Reproduced the benchmark on commit 7f3c with identical wall-clock numbers (±2%). The claim's confidence interval seems tight but within tolerance for the workload class. Marking 0.82 rather than 0.95 because I did not reproduce the cold-start path.\",\"target\":{\"@id\":\"nostr:5a2c3f9e4b1d7a6e8c0f1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f\"}}",
  "sig": "deadbeef00000000000000000000000000000000000000000000000000000000deadbeef00000000000000000000000000000000000000000000000000000000"
}
```

## 4. Paired rationale requirement

Every `kind:30506` score event MUST be paired with a `kind:30507` comment event authored by the same pubkey that justifies the score. Aggregators MUST treat unjustified score events as weight-zero.

### 4.1 Pairing mechanism

A comment event `C` is the rationale for a score event `S` if and only if all of the following hold:

1. `C.pubkey == S.pubkey` (same author).
2. `C` carries an `e` tag whose value equals `S.id`.
3. `C.created_at` falls within a 24-hour window centered on `S.created_at`. Implementations SHOULD accept the wider window `[S.created_at − 86400, S.created_at + 86400]` to tolerate clock skew, batched publishing, and post-hoc justification.
4. `C` parses as a valid `kind:30507` comment per §3.

If multiple comments by `S.pubkey` reference `S.id` within the temporal window, aggregators SHOULD treat the most recent one as the rationale of record but MAY consider the full set when computing weight.

### 4.2 Authoring discipline

Publishers SHOULD publish `S` and its rationale `C` in the same session — typically `C` immediately after `S`. The rationale MAY precede the score by minutes when the rationale was written first and the value was finalized after.

### 4.3 Aggregator obligation

A reference aggregator MUST:

- Resolve the rationale comment for each score per §4.1.
- Treat any `kind:30506` event with no resolvable rationale as `weight = 0` for all aggregation purposes.

A reference aggregator SHOULD:

- Surface the rationale text alongside the score in any client-facing API.
- Penalize rationales that are demonstrably non-substantive (empty body, single emoji, copy of the target's text) by additional weight reduction. The exact heuristic is non-normative.

### 4.4 Why MUST and not SHOULD

Treating unjustified scores as visible-but-zero-weighted, rather than as protocol violations, keeps the wire format permissive while making the credibility cost of skipping rationale unambiguous. Writers can publish a score-only event; no one has to reject it; it simply does not move any aggregator's needle.

## 5. Self-scoring guidance

A pubkey SHOULD NOT publish a `kind:30506` score event whose target was authored by the same pubkey.

Aggregators SHOULD ignore self-scores by policy regardless of their `value`. Self-scoring is not prohibited at the wire level — clients MAY surface a publisher's self-score as metadata (e.g. "author confidence") — but it MUST NOT contribute to any aggregated credibility figure.

## 6. Supersession

Both `kind:30506` and `kind:30507` are parameterized-replaceable per [NIP-33](https://github.com/nostr-protocol/nips/blob/master/33.md). The (`pubkey`, `kind`, `d`) triple identifies the latest version of any score or comment.

For `kind:30506`, the `d` tag is the target event id, so the latest score from a given scorer about a given target is canonical. Older score events from the same `(scorer, target)` pair are superseded but remain queryable from relays that retain history.

Aggregators MAY walk the history of `(scorer, target)` score events for purposes including:

- **Pump-and-dump detection.** Repeated rapid revisions of the same `(scorer, target)` pair are a credibility signal in their own right.
- **Confidence trajectories.** Plotting `value` over time can show a scorer's evolving opinion as new evidence arrives.
- **Audit trails.** Holding a scorer accountable to past positions.

For `kind:30507`, comments are also supersedable per `(pubkey, kind, d)`, so a commenter MAY edit a rationale by republishing under the same `d`. Editing a rationale does not invalidate the paired score so long as the temporal window in §4.1 still holds.

## 7. Aggregation (non-normative)

This section is non-normative. 4A specifies the *shape* of score and comment events; it does not specify how aggregators turn a graph of those events into a presentable credibility figure.

Reference implementations MAY publish their algorithms. Nothing in this specification prevents multiple competing aggregators with different opinions from coexisting on the same event substrate. Consumers SHOULD treat aggregator output as one signed opinion among many — the same posture [SPEC.md](./SPEC.md) §Score consumption already takes for NIP-85 trusted assertions.

Candidate aggregation methods include:

- **Hop-distance weighting.** Scores from pubkeys within N follow-hops of the consumer count more.
- **EigenTrust-over-citations.** Iteratively propagate trust through the citation and score graphs.
- **PageRank-shaped variants.** Damped random walks over the directed score graph.
- **Bayesian posterior estimation.** Treat each score as evidence updating a prior belief about the target.

Listing these methods is informational. The 4A specification takes no position on which is best.

### 7.1 Format versus methodology

The wire format is the convention; the methodology is not. This mirrors the [Microformats](https://microformats.org/)-on-HTML pattern: HTML defines the elements, Microformats define standard attribute conventions, but page authors and consuming aggregators decide what the conventions *mean* downstream. 4A defines `kind:30506` and `kind:30507` shapes; aggregators decide what to do with them.

## 8. Worked examples

### 8.1 Example A — Alice scores Bob's claim

Bob publishes a `kind:30501` claim that the `next/jit` compiler reduces TTI by 30% on a benchmark workload. The claim event id is `9f8e7d6c…090`.

Alice reads the claim, runs the benchmark, and decides to publish a score with paired rationale.

**Score event** (`kind:30506`, target = Bob's claim):

```json
{
  "kind": 30506,
  "pubkey": "<alice-pubkey>",
  "tags": [
    ["d", "9f8e7d6c5b4a39281706f5e4d3c2b1a0908070605040302010f0e0d0c0b0a090"],
    ["e", "9f8e7d6c5b4a39281706f5e4d3c2b1a0908070605040302010f0e0d0c0b0a090"],
    ["a", "30501:<bob-pubkey>:next-jit-claim-1"],
    ["blake3", "bk-..."],
    ["alt", "score 0.82 of next-jit-claim-1"],
    ["fa:context", "https://4a4.ai/ns/v0"]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":\"Score\",\"value\":0.82,\"tier\":\"verified\",\"target\":{\"@id\":\"nostr:9f8e7d6c…\"}}"
}
```

**Paired rationale** (`kind:30507`, target = Alice's score event):

```json
{
  "kind": 30507,
  "pubkey": "<alice-pubkey>",
  "tags": [
    ["d", "justify-next-jit-1"],
    ["e", "<alice-score-event-id>"],
    ["a", "30506:<alice-pubkey>:9f8e7d6c…"],
    ["blake3", "bk-..."],
    ["alt", "rationale for score 0.82 of next-jit-claim-1"],
    ["fa:context", "https://4a4.ai/ns/v0"]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":\"Comment\",\"intent\":\"justify\",\"body\":\"Reproduced the benchmark on commit 7f3c. Wall-clock improvement matched within ±2%. Cold-start path not reproduced — that's the 0.18 I held back.\",\"target\":{\"@id\":\"nostr:<alice-score-event-id>\"}}"
}
```

An aggregator reading both events will: verify §4.1 pairing (same pubkey, `e` references the score, within 24h), record the score with full weight, and surface Alice's rationale alongside it.

### 8.2 Example B — Carol scores Alice's score (recursive credibility)

Carol reviews Alice's score and her rationale. Carol thinks Alice was generous — the cold-start path is more important than Alice gave it credit for — and publishes her own score *of Alice's score event*.

**Carol's meta-score** (`kind:30506`, target = Alice's score):

```json
{
  "kind": 30506,
  "pubkey": "<carol-pubkey>",
  "tags": [
    ["d", "<alice-score-event-id>"],
    ["e", "<alice-score-event-id>"],
    ["a", "30506:<alice-pubkey>:9f8e7d6c…"],
    ["blake3", "bk-..."],
    ["alt", "score 0.55 of alice-score (next-jit-1)"],
    ["fa:context", "https://4a4.ai/ns/v0"]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":\"Score\",\"value\":0.55,\"target\":{\"@id\":\"nostr:<alice-score-event-id>\"}}"
}
```

**Carol's paired rationale** (`kind:30507`, target = Carol's meta-score):

```json
{
  "kind": 30507,
  "pubkey": "<carol-pubkey>",
  "tags": [
    ["d", "justify-meta-score-alice-1"],
    ["e", "<carol-score-event-id>"],
    ["a", "30506:<carol-pubkey>:<alice-score-event-id>"],
    ["blake3", "bk-..."],
    ["alt", "rationale for meta-score 0.55 of alice-score"],
    ["fa:context", "https://4a4.ai/ns/v0"]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":\"Comment\",\"intent\":\"challenge\",\"body\":\"Alice's reproduction is solid but underweights the cold-start regression that ships in the same release. The benchmark she ran does not exercise the new constant-pool path. Holding her score at 0.55 because the methodology is sound but the scope is incomplete.\",\"target\":{\"@id\":\"nostr:<carol-score-event-id>\"}}"
}
```

This is the recursive credibility substrate at work: scores about scores, with paired rationales at each level. An aggregator MAY weight a scorer's standing partly by the scores their own scores receive, producing a Stack-Exchange-style discussion-as-credibility loop without baking any of that policy into the wire format.

## 9. Open items deferred to v1

The following are explicitly out of scope for v0.5 and will be addressed in a future revision:

- **Challenges.** A formal "I dispute this score and put my own credibility on the line" event kind. Today the same effect is approximated by a low meta-score with a rationale comment, but a first-class challenge primitive (with stakes semantics) is a v1 candidate.
- **EigenTrust-over-citations.** A reference algorithm for trust propagation across the score graph, possibly published as a NIP companion document.
- **Multi-commons aggregation.** Composition rules for credibility figures that span multiple `kind:30504` Commons declarations with overlapping membership.
- **Anomaly detection conventions.** Standardized signals (e.g. tag values) for aggregators to publish "this scorer's pattern looks adversarial" in a portable way.
- **NIP submission.** Formal submission of `kind:30506` and `kind:30507` to the Nostr NIPs repository, with kind reassignment if the proposed range is not granted.
- **Encrypted variants.** Score and comment counterparts in the encrypted-kind range (per [SPEC.md](./SPEC.md) §Future work — private mode), deferred until private mode itself ships.

## 10. Compatibility

v0.5 introduces no breaking changes to Phase 2 events. The five existing kinds (30500 Observation, 30501 Claim, 30502 Entity, 30503 Relation, 30504 Commons) are unchanged. Existing publishers, consumers, and the v0 NIP-32-based credibility conventions described in [SPEC.md](./SPEC.md) §Credibility conventions continue to work.

The new score and comment kinds are additive: a v0-only consumer that does not recognize `kind:30506` or `kind:30507` MUST fall back to the `alt` tag per [SPEC.md](./SPEC.md) §Compliance levels and ignore the events. The custodial publishing layer at `4a4.ai` accepts the new kinds without configuration changes; signing, BLAKE3 tagging, and JSON-LD context handling are identical to existing kinds.

Implementations that previously relied solely on NIP-32 `4a.credibility.*` labels for credibility MAY continue to do so. The two mechanisms coexist: NIP-32 labels are compact, opinion-shaped attestations against pubkeys; `kind:30506` scores are rich, justified, target-event-shaped opinions about specific events. Aggregators MAY weight both.

## Companion documents

- [`SPEC.md`](./SPEC.md) — Phase 2 specification (4A v0)
- [`credibility-attestations.md`](./credibility-attestations.md) — research note: attestation primitives surveyed
- [`credibility-graphs.md`](./credibility-graphs.md) — research note: graph-shaped credibility computation
- [`credibility-sybil.md`](./credibility-sybil.md) — research note: Sybil-resistance considerations

## Change log

- 2026-04-28 — Initial draft (v0.5).
