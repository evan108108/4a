# Phase 3 — Credibility runbook (v0)

How to publish justified credibility events on 4A: signed scores (`kind:30506`) and signed comments (`kind:30507`), with the paired-rationale rule that aggregators rely on. This document is operational. It does not recommend a scoring methodology — that lives in client and agent space, not in the protocol.

---

## 1. What ships at v0

Phase 3 v0 ships **the wire format**: `kind:30506` (Score) and `kind:30507` (Comment), the paired-rationale MUST, the self-scoring SHOULD-NOT, and standard NIP-33 supersession. The gateway accepts these kinds, validates well-formedness on publish, and offers a paired-publish convenience endpoint so callers can sign and broadcast a score and its rationale together. **No reference aggregator ships at v0** — no `aggregator.4a4.ai`, no inline `credibility` block on query responses, no anointed seeds. Methodology — how to turn a graph of these events into a credibility figure — is left to clients and agents, where competing implementations can coexist.

---

## 2. The paired-rationale rule (§4.1, restated for operators)

> Every `kind:30506` score event MUST be paired with a `kind:30507` comment event authored by the same pubkey that justifies the score. Aggregators MUST treat unjustified score events as weight-zero.

In operational terms: a comment `C` is the rationale for a score `S` **if and only if** —

1. `C.pubkey == S.pubkey` (same author).
2. `C` carries an `e` tag whose value equals `S.id`.
3. `C.created_at` falls within the 24-hour window centered on `S.created_at` (`[S.created_at − 86400, S.created_at + 86400]`).
4. `C` parses as a valid `kind:30507` comment.

If you publish a score without a paired comment, relays accept it and the gateway returns `200`, but **every aggregator built on this format is required to weight that score at zero**. The recommended path is to use `POST /v0/score` (or the matching CLI/MCP tool), which signs and broadcasts both events atomically so you cannot drift out of compliance by accident.

For the normative wording, see [SPEC.md § Credibility events](../SPEC.md#credibility-events) and the historical companion [`SPEC-phase3-credibility.md` §4](../SPEC-phase3-credibility.md).

---

## 3. Publish flows

All three surfaces below hit the same handlers and produce the same on-relay events. Pick whichever fits your client.

### 3a. CLI

The `4a` CLI publishes through the gateway with your custodial key.

```bash
# Score an event with a paired rationale (publishes both atomically)
4a score 8bb425867e51424c02bc7cc76aae6df4f138b3448fb847daeec0ad5f80b16448 \
  --value 0.82 \
  --rationale "Reproduced the benchmark on commit 7f3c with identical wall-clock numbers (±2%). Marking 0.82 because I did not reproduce the cold-start path." \
  --tier verified \
  --intent justify

# Comment without scoring
4a comment 4eabeb6bdb490435b511f47450efa821892e7c7112906c672001f971a2e89fe7 \
  --body "Worth noting the benchmark omits the constant-pool path." \
  --intent clarify
```

Output is the resulting event ids and `nostr:` URIs. On success the score subcommand returns both `score_event_id` and `comment_event_id`.

### 3b. HTTP

`POST /v0/score` signs and publishes a score and its paired rationale in one round trip. `POST /v0/comment` is a thin standalone-comment endpoint. Both require a Bearer JWT issued by the gateway's OAuth flow.

```bash
# Paired score + rationale
curl -sS https://api.4a4.ai/v0/score \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "target_event_id": "8bb425867e51424c02bc7cc76aae6df4f138b3448fb847daeec0ad5f80b16448",
    "target_a_tag": "30501:afbb4f21dbeef3d791f05b6c26e9b7447833390a71f4a22b0f88f08799ccff64:next-jit-claim-1",
    "value": 0.82,
    "tier": "verified",
    "intent": "justify",
    "rationale": "Reproduced the benchmark on commit 7f3c with identical wall-clock numbers (±2%). Marking 0.82 because I did not reproduce the cold-start path."
  }'
```

Response:

```json
{
  "score_event_id": "4eabeb6bdb490435b511f47450efa821892e7c7112906c672001f971a2e89fe7",
  "comment_event_id": "eedf907432dfe7d52d7733a8d02c7baa549d436118e4bfe9dd23e041f49e685d",
  "score_address":   "30506:4f234ca09ed68824be7b50dfbba5e3b14e0006ae2749207b23de5a0b8c77782c:8bb425867e51424c02bc7cc76aae6df4f138b3448fb847daeec0ad5f80b16448",
  "comment_address": "30507:4f234ca09ed68824be7b50dfbba5e3b14e0006ae2749207b23de5a0b8c77782c:justify-4eabeb6b",
  "relay_acks": [ ... ]
}
```

Standalone comment:

```bash
curl -sS https://api.4a4.ai/v0/comment \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "target_event_id": "4eabeb6bdb490435b511f47450efa821892e7c7112906c672001f971a2e89fe7",
    "body": "The constant-pool path is the cold-start regression worth checking next.",
    "intent": "clarify"
  }'
```

The gateway rejects (`400`) `value ∉ [0, 1]`, non-numeric `value`, or empty/whitespace `rationale`/`body`. Out-of-range BLAKE3 or missing required tags are not reachable from these endpoints — the gateway constructs the events itself.

### 3c. MCP

Claude.ai and ChatGPT clients connected to `mcp.4a4.ai` see two tools:

- `score(target_event_id, value, rationale, tier?, intent?, target_a_tag?)`
- `comment(target_event_id, body, intent?, reply_to_event_id?, target_a_tag?)`

Both tools delegate to the same handlers as `POST /v0/score` and `POST /v0/comment`. Connector setup and OAuth flow are documented in [`/docs/connectors`](../connectors.md).

---

## 4. Worked examples

Two end-to-end paired-publish examples were published on the live `4a4.ai` relay set. Each fixture below is the raw signed event as received back from the gateway. The accompanying `curl` shows the gateway query that resolves the addressable triple.

### Example A — Alice scores Bob's claim

**Setup.** Bob publishes a `kind:30501` claim that `next/jit` reduces TTI by 30% on a benchmark workload. Claim id `8bb425867e51424c02bc7cc76aae6df4f138b3448fb847daeec0ad5f80b16448`.

**Score event** — [`docs/examples/phase-3/example-a-score.json`](./examples/phase-3/example-a-score.json). Alice scores the claim 0.82, tier `verified`.

```bash
curl -sS "https://api.4a4.ai/v0/object/30506:4f234ca09ed68824be7b50dfbba5e3b14e0006ae2749207b23de5a0b8c77782c:8bb425867e51424c02bc7cc76aae6df4f138b3448fb847daeec0ad5f80b16448"
```

**Paired rationale** — [`docs/examples/phase-3/example-a-rationale.json`](./examples/phase-3/example-a-rationale.json). Alice's `kind:30507` `intent:"justify"` referencing the score event id.

```bash
curl -sS "https://api.4a4.ai/v0/object/30507:4f234ca09ed68824be7b50dfbba5e3b14e0006ae2749207b23de5a0b8c77782c:justify-4eabeb6b"
```

*What this demonstrates:* the canonical paired-publish flow against a concrete claim. Same author across both events; the comment's `e` tag points at the score; both `created_at` are inside the 24-hour pairing window — so any §4.1-compliant aggregator will weight the score normally and surface the rationale text alongside it.

### Example B — Carol scores Alice's score (recursive credibility)

**Score event** — [`docs/examples/phase-3/example-b-score.json`](./examples/phase-3/example-b-score.json). Carol publishes a meta-score (`value: 0.55`) targeting Alice's score event `4eabeb6bdb490435b511f47450efa821892e7c7112906c672001f971a2e89fe7`.

```bash
curl -sS "https://api.4a4.ai/v0/object/30506:f5d87b6e7d06a5adb27c51ad8421503ab629c45aa851d50b0b85f6c7aaa5306d:4eabeb6bdb490435b511f47450efa821892e7c7112906c672001f971a2e89fe7"
```

**Paired rationale** — [`docs/examples/phase-3/example-b-rationale.json`](./examples/phase-3/example-b-rationale.json). Carol's `kind:30507` `intent:"challenge"` referencing the meta-score id.

```bash
curl -sS "https://api.4a4.ai/v0/object/30507:f5d87b6e7d06a5adb27c51ad8421503ab629c45aa851d50b0b85f6c7aaa5306d:justify-8c2cdeed"
```

*What this demonstrates:* the recursive credibility substrate. A `kind:30506` score may target another `kind:30506` score; the paired-rationale rule applies identically at every level. An aggregator that walks this graph can weight a scorer's standing partly by the scores their own scores receive, without any of that policy being baked into the wire format.

---

## 5. Test pubkeys

The four worked-example fixtures were signed by three deterministic test pubkeys derived as `SHA-256(<seed>)`:

| name  | seed (UTF-8)                  | pubkey (hex)                                                       |
| ----- | ----------------------------- | ------------------------------------------------------------------ |
| alice | `4a/phase-3/example/alice/v1` | `4f234ca09ed68824be7b50dfbba5e3b14e0006ae2749207b23de5a0b8c77782c` |
| bob   | `4a/phase-3/example/bob/v1`   | `afbb4f21dbeef3d791f05b6c26e9b7447833390a71f4a22b0f88f08799ccff64` |
| carol | `4a/phase-3/example/carol/v1` | `f5d87b6e7d06a5adb27c51ad8421503ab629c45aa851d50b0b85f6c7aaa5306d` |

Full table including `npub` form and the addressable triples published is at [`docs/examples/phase-3/pubkeys.md`](./examples/phase-3/pubkeys.md).

**Reproducing.** The fixtures regenerate idempotently — relays deduplicate by event id and the addressable triples are NIP-33 replaceable:

```bash
node scripts/phase-3-examples.mjs
```

The deterministic-seed approach is a v0 stopgap until `4a keygen` lands. Production users get fresh keys via the gateway's custodial OAuth flow or sign locally with their own `nsec`.

---

## 6. "I expected an aggregator — where is it?"

Short answer: it's not here, and that's the point.

4A v0 specifies the **wire format** for justified credibility — the shape of a score event, the shape of a comment event, the rule that pairs them. It does not specify how to turn a graph of those events into a presentable credibility figure. Scoring algorithms — hop-distance weighting, EigenTrust, PageRank-shaped variants, Bayesian posterior estimation, anything else — live in client and agent space, where multiple competing aggregators can coexist on the same substrate and discipline each other through their published opinions. This mirrors the Microformats-on-HTML pattern: HTML defines the elements, Microformats define attribute conventions, but consuming aggregators decide what those conventions *mean* downstream.

The spec's posture is non-normative on this:

> *"Reference implementations MAY publish their algorithms. Nothing in this specification prevents multiple competing aggregators with different opinions from coexisting on the same event substrate. Consumers SHOULD treat aggregator output as one signed opinion among many."* — [SPEC-phase3-credibility.md §7](../SPEC-phase3-credibility.md#7-aggregation-non-normative)

If you want a credibility figure, build the aggregator you trust, or subscribe to one someone else publishes. The 4A gateway will not hand you its opinion at v0.

---

## 7. What's deferred

Out of scope for v0 (per [PLAN-phase3-credibility.md §9](../PLAN-phase3-credibility.md#9-out-of-scope-explicit) and [SPEC-phase3-credibility.md §9](../SPEC-phase3-credibility.md#9-open-items-deferred-to-v1)):

- Reference aggregator and any inline `credibility` block on `/v0/queryEvents`.
- Hop-distance, EigenTrust, PageRank, or any other algorithm as a required protocol primitive.
- Anointed seeds, "trusted set," consumer-pubkey roots.
- Tier vocabulary as normative — `verified`/`contested`/`draft` are illustrative only.
- Multi-aggregator passthrough on query responses (v0.5 candidate).
- Tier render conventions and sponsor/stamp pre-trust read-side guidance (v0.5).
- Comment threading conventions for clients (v0.5).
- Formal challenge primitive with stake-and-jury semantics (v1).
- Multi-commons aggregation rules across `kind:30504` (v1).
- Standardized signed anomaly observations (v1).
- NIP-85 / NIPs submission (v1).
- Encrypted score and comment variants, pairs with v0.5 audiences (v1).
