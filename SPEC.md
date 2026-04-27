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

Kinds 30505–30519 are reserved for post-v0 additions. These numbers are placeholders pending formal NIP submission; implementations MUST be configurable to use different kinds if reassigned.

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
