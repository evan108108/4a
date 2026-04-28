# 4A Specification — v0

**Status:** Draft v0 (2026-04-24). Subject to change pending NIP discussion.
**Pronunciation:** "four-A"
**Convention name:** Agent-Agnostic Accessible Archive
**Version:** v0
**Context URL:** `https://4a4.ai/ns/v0`

## Conformance language

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) when, and only when, they appear in capitals.

## Overview

A **4A event** is a Nostr event whose `kind` is one of the 4A-reserved event kinds and whose `content` is a JSON-LD document referencing the 4A `@context`. 4A events are otherwise indistinguishable from any other Nostr event: same envelope, same signature scheme, same relay protocol.

A **4A object** is the deserialized, signature-verified knowledge object represented by a 4A event — an `Observation`, `Claim`, `Entity`, `Relation`, or `Commons` declaration.

A 4A **publisher** is any client that produces signed 4A events and posts them to one or more Nostr relays.

A 4A **consumer** is any client that subscribes to 4A events from one or more relays, verifies signatures, and presents the deserialized objects to an agent or user.

## Wire format

### Event envelope

A 4A event MUST conform to the standard Nostr event format ([NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)):

```json
{
  "id": "<32-byte hex sha256 of the canonical event serialization>",
  "pubkey": "<32-byte hex secp256k1 pubkey>",
  "created_at": <unix timestamp>,
  "kind": <4A event kind, see below>,
  "tags": [ ... ],
  "content": "<stringified JSON-LD document>",
  "sig": "<64-byte hex schnorr signature>"
}
```

### Event kinds

4A reserves event kinds in the addressable (parameterized-replaceable) range 30000–39999. The current proposed assignments:

| Kind | Object | Replaceability |
|---|---|---|
| 30500 | `Observation` | Addressable by `d` |
| 30501 | `Claim` | Addressable by `d` |
| 30502 | `Entity` | Addressable by `d` |
| 30503 | `Relation` | Addressable by `d` |
| 30504 | `Commons` | Addressable by `d` |
| 30506 | `Score` | Addressable by `d` |
| 30507 | `Comment` | Addressable by `d` |

Kinds 30505 and 30508–30519 remain reserved for post-v0 additions. These numbers are placeholders pending formal NIP submission; implementations MUST be configurable to use different kinds if reassigned.

### Required tags

Every 4A event MUST carry the following tags:

| Tag | Value | Purpose |
|---|---|---|
| `d` | Stable addressable slug | Parameterized-replaceable key per (pubkey, kind, d) |
| `blake3` | `bk-` prefix + base32 BLAKE3 hash of the `content` payload | Content addressing and integrity check |
| `alt` | Single-line human-readable summary | [NIP-31](https://github.com/nostr-protocol/nips/blob/master/31.md) fallback for clients that do not recognize the kind |
| `fa:context` | `https://4a4.ai/ns/v0` (or pinned version) | Quick check that the payload is 4A-shaped before parsing |

### Optional tags

| Tag | Repeatable | Value | Purpose |
|---|---|---|---|
| `t` | Yes | Topic slug (e.g. `rails`, `next.js`) | Hashtag-style classification |
| `l` | Yes | NIP-32 label with `4a.*` namespace | Credibility, stamps, sponsorship |
| `e` | Yes | Event ID | Citation by event id |
| `a` | Yes | `kind:pubkey:d` pointer | Citation of an addressable 4A object |
| `p` | Yes | Pubkey | Reference to another author |
| `arweave` | Once | Arweave transaction id | Permanence pin (via Irys) |
| `expiration` | Once | Unix timestamp | NIP-40 time-bounded validity |

## Payload format

### JSON-LD context

A 4A event's `content` field MUST be a stringified JSON object that begins with an `@context` key referencing the 4A context document URL:

```json
{
  "@context": "https://4a4.ai/ns/v0",
  ...
}
```

Implementations MAY use a versioned URL with a fragment (`https://4a4.ai/ns/v0#2026-04-24`) once such pins are formally defined. v0 publishers SHOULD use the unversioned URL.

The context document itself defines:

- Three namespace prefixes: `schema:` ([Schema.org](https://schema.org)), `prov:` ([PROV-O](https://www.w3.org/TR/prov-o/)), `fa:` (4A-specific terms)
- Type aliases for the four primary object types and their Schema.org parents
- Property aliases for all field names used in 4A payloads
- 4A-specific terms in the `fa:` namespace for wire-level fields with no existing vocabulary equivalent

The full context document is at [`context-v0.json`](./context-v0.json) and is served at `https://4a4.ai/ns/v0`.

### Payload shapes per kind

#### Observation (kind 30500)

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Observation",
  "agent": { "@id": "<publisher pubkey or DID>" },
  "observationDate": "<ISO 8601 datetime>",
  "observationAbout": { "@id": "<entity URI>" },
  "measuredProperty": "<property name>",
  "value": "<observed value>",
  "wasDerivedFrom": [ { "@id": "<source URL>" } ]
}
```

#### Claim (kind 30501)

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Claim",
  "author": { "@id": "<publisher pubkey or DID>" },
  "datePublished": "<ISO 8601 date>",
  "about": { "@id": "<entity URI>" },
  "appearance": "<the claim text>",
  "citation": [ { "@id": "<4A object URI>" } ]
}
```

#### Entity (kind 30502)

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": ["Thing", "<Schema.org subtype>"],
  "@id": "<canonical entity URI — typically the d-tag value>",
  "name": "<display name>",
  "description": "<optional description>",
  "sameAs": [ "<alternate URI>" ]
}
```

The `@type` array MUST start with `Thing` and SHOULD include at least one Schema.org subtype hint (`Person`, `Organization`, `Place`, `CreativeWork`, `SoftwareSourceCode`).

#### Relation (kind 30503)

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Role",
  "roleName": "<relationship type>",
  "subject": { "@id": "<entity URI>" },
  "object": { "@id": "<entity URI>" },
  "startDate": "<optional ISO 8601 date>",
  "endDate": "<optional ISO 8601 date>",
  "wasAttributedTo": { "@id": "<attestor pubkey>" }
}
```

For lightweight relationships, publishers SHOULD prefer bare JSON-LD properties on an Entity payload rather than a separate Relation event.

#### Commons (kind 30504)

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Organization",
  "name": "<commons name>",
  "description": "<charter>",
  "memberOf": { "@id": "<parent project URI>" }
}
```

The Commons event's `tags` SHOULD include one `p` tag per recognized co-maintainer pubkey.

## Credibility conventions

4A defines no new event kinds for credibility. All credibility primitives are expressed as [NIP-32](https://github.com/nostr-protocol/nips/blob/master/32.md) labels using the `4a.*` namespace.

### Per-domain credibility

A pubkey's credibility about a specific domain is asserted via NIP-32 labels with the namespace `4a.credibility.<domain>`:

```
["L", "4a.credibility.next.js"]
["l", "verified", "4a.credibility.next.js"]
```

The label may carry a value such as `verified`, `expert`, `contributor`, or any operator-defined string. Aggregators interpret values according to their own policies.

### Bootstrap stamps

A pubkey may import existing credentials by publishing NIP-32 stamp labels:

| Namespace | Value |
|---|---|
| `4a.stamp.github` | GitHub username |
| `4a.stamp.keybase` | Keybase username |
| `4a.stamp.ens` | ENS name |
| `4a.stamp.dns` | DNS-verified domain |

Stamps are self-asserted; aggregators MAY require independent verification (e.g. resolving the GitHub username to a published proof).

### Sponsorship

A pubkey vouching for another publishes a NIP-32 `4a.sponsor` label:

```
["L", "4a.sponsor"]
["l", "sponsored", "4a.sponsor"]
["p", "<sponsored pubkey>"]
```

Aggregators that implement BrightID-style backer-decay penalize the sponsor when the sponsored pubkey is sanctioned. The sponsor's standing therefore carries downward liability.

### Score consumption

Credibility scores themselves are not part of the 4A specification. Consumers SHOULD query [NIP-85](https://github.com/nostr-protocol/nips/blob/master/85.md) trusted assertions from one or more aggregators (nostr.band, Vertex, or any NIP-85 publisher) to obtain computed scores. Different aggregators publish different scores; consumer policy decides which to trust.

## Credibility events

This section defines two 4A event kinds — `kind:30506` (Score) and `kind:30507` (Comment) — and the normative rules governing how scorers, commenters, and aggregators interact. It does not specify how scores are computed; that is left to consumers and aggregators. The non-normative material on aggregation, worked examples, and deferred items is in [Appendix A](#appendix-a--aggregation-non-normative), [Appendix B](#appendix-b--credibility-worked-examples), and [Appendix C](#appendix-c--credibility-events-deferred-to-v1) below.

### Credibility event kinds

| Kind  | Object  | Replaceability                                |
| ----- | ------- | --------------------------------------------- |
| 30506 | Score   | Addressable by `d` (parameterized-replaceable) |
| 30507 | Comment | Addressable by `d` (parameterized-replaceable) |

Both kinds use the standard 4A envelope, JSON-LD `@context`, and required tags (`d`, `blake3`, `alt`, `fa:context`).

### Score event (kind:30506)

A score event is a signed, weighted opinion about a target 4A object.

#### Required fields

A `kind:30506` event MUST carry:

| Tag           | Value                                              | Notes                                                                             |
| ------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `d`           | The target event id (32-byte hex)                  | Makes (`pubkey`, `kind=30506`, `d=target`) unique per scorer. Latest write wins.  |
| `e`           | Target event id                                    | NIP-01 reference. Same value as `d` for non-addressable targets.                  |
| `blake3`      | `bk-` + base32 BLAKE3 of `content`                 | Per [Content addressing](#content-addressing).                                    |
| `alt`         | One-line human summary                             | NIP-31 fallback, e.g. `"score 0.82 of <event-id-prefix>"`.                        |
| `fa:context`  | `https://4a4.ai/ns/v0`                             | Per [Required tags](#required-tags).                                              |

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

#### Optional fields

| Field / Tag                  | Notes                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tier` (in `content`)         | A short categorical string (e.g. `"verified"`, `"contested"`, `"draft"`) for clients that prefer a chip render over a numeric one. |
| `preamble` (in `content`)    | Optional short human-readable preamble for the score. Long-form rationale belongs in the paired `kind:30507`, not here.            |
| `["a", "<kind>:<pubkey>:<d>"]` | When the target is itself an addressable 4A object, the `a` tag SHOULD be present alongside `e`.                                  |
| `["expiration", "<unix>"]`   | NIP-40. A score MAY declare its own staleness window.                                                                              |
| `["t", "<topic>"]`            | Topic tag, repeatable.                                                                                                             |

#### Canonical example

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

### Comment event (kind:30507)

A comment event is a signed prose response targeting any 4A event — including claims, scores, attestations, and other comments.

#### Required fields

A `kind:30507` event MUST carry:

| Tag           | Value                                | Notes                                                                                       |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `d`           | Stable per-comment slug              | A new `d` per distinct comment from the same author against the same target.                |
| `e`           | Direct target event id               | The event being commented on.                                                               |
| `blake3`      | `bk-` + base32 BLAKE3 of `content`   | Per [Content addressing](#content-addressing).                                              |
| `alt`         | One-line human summary               | NIP-31 fallback.                                                                            |
| `fa:context`  | `https://4a4.ai/ns/v0`               | Per [Required tags](#required-tags).                                                        |

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

#### Optional fields

| Field / Tag                                      | Notes                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `["e", "<root-event-id>", "", "root"]`           | When commenting inside a thread, the thread root MAY be tagged with the `"root"` marker per NIP-10 conventions.                    |
| `["e", "<parent-comment-id>", "", "reply"]`      | When replying to another comment, the parent SHOULD be tagged with the `"reply"` marker.                                           |
| `["a", "<kind>:<pubkey>:<d>"]`                    | When the target is an addressable 4A object, the `a` tag SHOULD be present alongside `e`.                                          |
| `["p", "<pubkey>"]`                               | Pubkey of the target's author, when the comment is intended to notify them.                                                        |
| `intent` (in `content`)                           | Optional one-token classifier (e.g. `"justify"`, `"challenge"`, `"clarify"`). When pairing a rationale with a score, set to `"justify"`. |

#### Recursive commenting

A `kind:30507` event MAY target any 4A event, including another `kind:30507`. There is no nesting depth limit at the protocol level; consumers MAY impose one for rendering. Recursive comments form the credibility-discussion substrate: a comment on a score is a critique of the score; a comment on that critique is a rebuttal; and so on.

#### Canonical example

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

### Paired rationale requirement

Every `kind:30506` score event MUST be paired with a `kind:30507` comment event authored by the same pubkey that justifies the score. Aggregators MUST treat unjustified score events as weight-zero.

#### Pairing mechanism

A comment event `C` is the rationale for a score event `S` if and only if all of the following hold:

1. `C.pubkey == S.pubkey` (same author).
2. `C` carries an `e` tag whose value equals `S.id`.
3. `C.created_at` falls within a 24-hour window centered on `S.created_at`. Implementations SHOULD accept the wider window `[S.created_at − 86400, S.created_at + 86400]` to tolerate clock skew, batched publishing, and post-hoc justification.
4. `C` parses as a valid `kind:30507` comment per the [Comment event](#comment-event-kind30507) section.

If multiple comments by `S.pubkey` reference `S.id` within the temporal window, aggregators SHOULD treat the most recent one as the rationale of record but MAY consider the full set when computing weight.

#### Authoring discipline

Publishers SHOULD publish `S` and its rationale `C` in the same session — typically `C` immediately after `S`. The rationale MAY precede the score by minutes when the rationale was written first and the value was finalized after.

#### Aggregator obligation

A reference aggregator MUST:

- Resolve the rationale comment for each score per the pairing mechanism above.
- Treat any `kind:30506` event with no resolvable rationale as `weight = 0` for all aggregation purposes.

A reference aggregator SHOULD:

- Surface the rationale text alongside the score in any client-facing API.
- Penalize rationales that are demonstrably non-substantive (empty body, single emoji, copy of the target's text) by additional weight reduction. The exact heuristic is non-normative.

#### Why MUST and not SHOULD

Treating unjustified scores as visible-but-zero-weighted, rather than as protocol violations, keeps the wire format permissive while making the credibility cost of skipping rationale unambiguous. Writers can publish a score-only event; no one has to reject it; it simply does not move any aggregator's needle.

### Self-scoring guidance

A pubkey SHOULD NOT publish a `kind:30506` score event whose target was authored by the same pubkey.

Aggregators SHOULD ignore self-scores by policy regardless of their `value`. Self-scoring is not prohibited at the wire level — clients MAY surface a publisher's self-score as metadata (e.g. "author confidence") — but it MUST NOT contribute to any aggregated credibility figure.

### Credibility event supersession

Both `kind:30506` and `kind:30507` are parameterized-replaceable per [NIP-33](https://github.com/nostr-protocol/nips/blob/master/33.md). The (`pubkey`, `kind`, `d`) triple identifies the latest version of any score or comment.

For `kind:30506`, the `d` tag is the target event id, so the latest score from a given scorer about a given target is canonical. Older score events from the same `(scorer, target)` pair are superseded but remain queryable from relays that retain history.

Aggregators MAY walk the history of `(scorer, target)` score events for purposes including:

- **Pump-and-dump detection.** Repeated rapid revisions of the same `(scorer, target)` pair are a credibility signal in their own right.
- **Confidence trajectories.** Plotting `value` over time can show a scorer's evolving opinion as new evidence arrives.
- **Audit trails.** Holding a scorer accountable to past positions.

For `kind:30507`, comments are also supersedable per `(pubkey, kind, d)`, so a commenter MAY edit a rationale by republishing under the same `d`. Editing a rationale does not invalidate the paired score so long as the temporal window in the [Pairing mechanism](#pairing-mechanism) still holds.

## Identity

A 4A publisher is identified by a Nostr secp256k1 pubkey. Publishers obtain a pubkey via one of three paths:

1. **Local key generation.** The publisher generates and stores their own keypair. The `4a` CLI provides this via `4a keygen`.
2. **NIP-46 bunker.** The publisher delegates signing to a [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) bunker (nsec.app or self-hosted). The 4A reference gateway forwards signing requests to the bunker.
3. **Custodial via OAuth.** The 4A reference gateway derives a Nostr keypair deterministically from an OAuth identity using a non-extractable HMAC key. Consumers cannot distinguish custodially-signed events from any others — the resulting Nostr events are identical in shape and signature validity.

This specification does not mandate any of the three paths; they are described here for completeness. Publishers and consumers interact only with the resulting Nostr events.

## Content addressing

Every 4A event's `blake3` tag MUST contain the [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) hash of the UTF-8 encoded `content` string, prefixed with `bk-` and base32-encoded:

```
blake3_hash = BLAKE3(content_string)
tag_value = "bk-" + base32_encode(blake3_hash)
```

Consumers MUST verify that the `blake3` tag matches the actual hash of the received `content` before treating the payload as authoritative.

## Permanence (optional)

A publisher MAY anchor an event's payload to [Arweave](https://arweave.org) via [Irys](https://irys.xyz). When anchored:

- The Arweave transaction id is included as the `arweave` tag on the event
- The same transaction id is included as `pinnedTo` in the JSON-LD payload
- Consumers MAY fetch the payload from Arweave if relays do not return it

Anchoring is the publisher's choice and is not required.

## Compliance levels

A 4A implementation MAY claim conformance at one of the following levels:

| Level | Required capabilities |
|---|---|
| **Read** | Subscribe to relays, filter on 4A kinds, verify signatures, parse JSON-LD against the 4A context, expose objects to consumers |
| **Write** | Read-level + sign and publish 4A events with valid envelopes, BLAKE3 tags, and JSON-LD payloads |
| **Aggregator** | Read-level + publish NIP-85 trusted assertions over the citation and credibility graphs |

Implementations are not required to support all four object types, but implementations that publish or consume any 4A event MUST handle the `alt` tag fallback for kinds they do not recognize.

## Future work — private mode (deferred)

A future revision of this specification will define **encrypted variants** of the five public kinds, allowing publishers to share knowledge with specific recipients (individuals or teams) using the same Nostr substrate. Private mode is **not part of v0** — it is deferred until public mode has adoption signal and until [NIP-104/MLS](https://github.com/nostr-protocol/nips/blob/master/104.md) stabilizes for group encryption.

### Reserved kinds

Kinds 30510–30514 are reserved for encrypted variants of the public kinds:

| Encrypted kind | Public counterpart | Object |
|---|---|---|
| 30510 | 30500 | Encrypted Observation |
| 30511 | 30501 | Encrypted Claim |
| 30512 | 30502 | Encrypted Entity |
| 30513 | 30503 | Encrypted Relation |
| 30514 | 30504 | Encrypted Commons |

Implementations MUST NOT publish events with kinds in this range until the encrypted-variant specification is finalized.

### Anticipated design

When private mode lands, encrypted events will:

- Use [NIP-44 v2](https://github.com/nostr-protocol/nips/blob/master/44.md) for pairwise encryption (one publisher to one recipient pubkey)
- Use [NIP-104](https://github.com/nostr-protocol/nips/blob/master/104.md) (MLS-on-Nostr) for group encryption with proper forward and backward secrecy, once stable
- Carry one or more `p` tags pointing at recipient pubkeys
- Optionally use [NIP-17 gift-wrapping](https://github.com/nostr-protocol/nips/blob/master/17.md) (kind 1059) for metadata privacy
- Be filterable by recipients via standard Nostr `#p` filters

### Identity restriction

Private mode will require a **non-custodial key** — either a [NIP-46 bunker](https://github.com/nostr-protocol/nips/blob/master/46.md) or a locally generated keypair. Custodial keys derived from OAuth (described in the Identity section above) will not be usable for private publishing or reading, because the gateway holding the master HMAC key could otherwise decrypt every private event sent to its custodial users. This restriction is intentional: it preserves the "no plaintext private data on hosted infrastructure" property that custodial mode relies on.

### Product implication: Throughline

Throughline — currently mentioned as a planned sibling product for private team memory — is anticipated to ship as a UX layer (team management, billing, member roster) on top of 4A's private mode rather than as a separate protocol. This document will be updated when private mode ships and Throughline's relationship is finalized.

## Appendix A — Aggregation (non-normative)

This appendix is non-normative. 4A specifies the *shape* of score and comment events; it does not specify how aggregators turn a graph of those events into a presentable credibility figure.

Reference implementations MAY publish their algorithms. Nothing in this specification prevents multiple competing aggregators with different opinions from coexisting on the same event substrate. Consumers SHOULD treat aggregator output as one signed opinion among many — the same posture taken in [Score consumption](#score-consumption) for NIP-85 trusted assertions.

Candidate aggregation methods include:

- **Hop-distance weighting.** Scores from pubkeys within N follow-hops of the consumer count more.
- **EigenTrust-over-citations.** Iteratively propagate trust through the citation and score graphs.
- **PageRank-shaped variants.** Damped random walks over the directed score graph.
- **Bayesian posterior estimation.** Treat each score as evidence updating a prior belief about the target.

Listing these methods is informational. The 4A specification takes no position on which is best.

### Format versus methodology

The wire format is the convention; the methodology is not. This mirrors the [Microformats](https://microformats.org/)-on-HTML pattern: HTML defines the elements, Microformats define standard attribute conventions, but page authors and consuming aggregators decide what the conventions *mean* downstream. 4A defines `kind:30506` and `kind:30507` shapes; aggregators decide what to do with them.

## Appendix B — Credibility worked examples

### Example A — Alice scores Bob's claim

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

An aggregator reading both events will: verify pairing per the [Pairing mechanism](#pairing-mechanism) (same pubkey, `e` references the score, within 24h), record the score with full weight, and surface Alice's rationale alongside it.

### Example B — Carol scores Alice's score (recursive credibility)

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

## Appendix C — Credibility events deferred to v1

The following are explicitly out of scope for v0 and will be addressed in a future revision:

- **Challenges.** A formal "I dispute this score and put my own credibility on the line" event kind. Today the same effect is approximated by a low meta-score with a rationale comment, but a first-class challenge primitive (with stakes semantics) is a v1 candidate.
- **EigenTrust-over-citations.** A reference algorithm for trust propagation across the score graph, possibly published as a NIP companion document.
- **Multi-commons aggregation.** Composition rules for credibility figures that span multiple `kind:30504` Commons declarations with overlapping membership.
- **Anomaly detection conventions.** Standardized signals (e.g. tag values) for aggregators to publish "this scorer's pattern looks adversarial" in a portable way.
- **NIP submission.** Formal submission of `kind:30506` and `kind:30507` to the Nostr NIPs repository, with kind reassignment if the proposed range is not granted.
- **Encrypted variants.** Score and comment counterparts in the encrypted-kind range (see [Future work — private mode](#future-work--private-mode-deferred)), deferred until private mode itself ships.

## Appendix D — Phase 3 compatibility note

The credibility kinds (`kind:30506`, `kind:30507`) introduce no breaking changes to earlier kinds. The five existing kinds (30500 Observation, 30501 Claim, 30502 Entity, 30503 Relation, 30504 Commons) are unchanged. Existing publishers, consumers, and the NIP-32-based [Credibility conventions](#credibility-conventions) continue to work.

The new score and comment kinds are additive: a consumer that does not recognize `kind:30506` or `kind:30507` MUST fall back to the `alt` tag per [Compliance levels](#compliance-levels) and ignore the events. The custodial publishing layer at `4a4.ai` accepts the new kinds without configuration changes; signing, BLAKE3 tagging, and JSON-LD context handling are identical to existing kinds.

Implementations that previously relied solely on NIP-32 `4a.credibility.*` labels for credibility MAY continue to do so. The two mechanisms coexist: NIP-32 labels are compact, opinion-shaped attestations against pubkeys; `kind:30506` scores are rich, justified, target-event-shaped opinions about specific events. Aggregators MAY weight both.

## Companion documents

- [`README.md`](./README.md) — overview and pitch
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — deployment architecture and identity derivation
- [`kind-assignments.md`](./kind-assignments.md) — extended notes on event kind assignments
- [`vocabulary-v0.md`](./vocabulary-v0.md) — JSON-LD vocabulary research and rationale
- [`credibility-attestations.md`](./credibility-attestations.md), [`credibility-graphs.md`](./credibility-graphs.md), [`credibility-sybil.md`](./credibility-sybil.md) — credibility primitive research
- [`spam-defense.md`](./spam-defense.md), [`relay-economics.md`](./relay-economics.md) — operational notes
- [`context-v0.json`](./context-v0.json) — the JSON-LD context document served at `https://4a4.ai/ns/v0`

## Change log

- 2026-04-24 — Initial draft.
- 2026-04-28 — Folded credibility events (kind:30506 Score, kind:30507 Comment) into the spec as a top-level *Credibility events* section, with non-normative aggregation, worked examples, deferred items, and compatibility notes as appendices A–D. Supersedes the standalone `SPEC-phase3-credibility.md` stub.
