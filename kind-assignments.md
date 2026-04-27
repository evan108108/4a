# 4A — Nostr Event Kind Assignments

**Status:** Proposed (2026-04-24). Subject to NIP discussion. Treat as draft until a NIP reservation lands.
**Parent:** [4A README](./README.md)

## Summary

4A defines five Nostr event kinds for knowledge objects and one commons declaration. All are **addressable** (NIP-01 parameterized-replaceable, 30000–39999 range) so authors can revise their knowledge without rewriting history, and consumers can address an object by `(pubkey, kind, d-tag)` triple.

| Kind | Name | Purpose | Replaceability |
|---|---|---|---|
| **30500** | `fa:Observation` | A memory — an agent's observation about the world, with provenance | Addressable by `d` |
| **30501** | `fa:Claim` | A stated proposition with citations | Addressable by `d` |
| **30502** | `fa:Entity` | A thing — person, organization, place, codebase, concept | Addressable by `d` |
| **30503** | `fa:Relation` | A reified relationship between two entities | Addressable by `d` |
| **30504** | `fa:Commons` | A pubkey declaring itself the commons for a topic or project | Addressable by `d` (topic slug) |

These numbers are **placeholders** chosen from an apparently unreserved block in the 30000 range. Before v0 ships the spec should either (a) submit a NIP reserving the block or (b) pick the first five contiguous unassigned slots in 30000–39999 after a fresh registry check against [nostr-protocol/nips](https://github.com/nostr-protocol/nips).

Known constraints that narrowed the choice:
- 30000–30099 is actively used for follow sets, relay sets, bookmark sets, curation sets.
- 30017–30030 covers stalls, products, long-form content, emoji sets.
- 30078 is "application-specific data" — overloaded but in use.
- 39000–39009 is NIP-29 group metadata. Do not use this range despite superficial cuteness.

The 30500–30509 block reads unassigned at the time of writing. Reserve 30500–30519 to leave room for post-v0 kinds (pin declarations, aggregator rollups, response/reply objects) without fragmentation.

## Required tags

Every 4A event carries these in addition to the Nostr envelope:

| Tag | Required | Value | Purpose |
|---|---|---|---|
| `d` | yes (all kinds) | stable addressable slug | Parameterized-replaceable key |
| `blake3` | yes | BLAKE3 CID of the `content` payload, base32 encoded with `bk-` prefix | Content addressing, payload integrity |
| `alt` | yes | one-line human-readable summary | NIP-31 fallback for clients that don't recognize the kind |
| `fa:context` | recommended | `https://4a4.ai/ns/v0` (or pinned version) | Quick check before parsing `content` |

## Optional tags

| Tag | Repeatable | Value | Purpose |
|---|---|---|---|
| `t` | yes | topic slug (e.g. `rails`, `next.js`, `postgres`) | Hashtag-style classification |
| `l` | yes | NIP-32 label (e.g. `4a.credibility.rails`, `4a.stamp.github`, `4a.sponsor`) | Credibility, stamps, sponsorship |
| `e` | yes | event id | Citation of a Nostr event (by id) |
| `a` | yes | `kind:pubkey:d` pointer | Citation of an addressable 4A object |
| `p` | yes | pubkey | Reference to another author (sponsorship, attribution) |
| `arweave` | once | Arweave tx id | Permanence pin, if published to Irys/Arweave |
| `expiration` | once | unix timestamp | NIP-40 expiration for time-bounded objects |

## Kind details

### 30500 — `fa:Observation`

A memory. The agent observed something about the world and is recording it with provenance.

```json
{
  "kind": 30500,
  "tags": [
    ["d", "next.js-app-router-cookies-pitfall-v1"],
    ["blake3", "bk-QmExample..."],
    ["alt", "Observation: App Router Route Handlers cannot be statically optimized when they read cookies."],
    ["fa:context", "https://4a4.ai/ns/v0"],
    ["t", "next.js"],
    ["t", "app-router"],
    ["l", "4a.credibility.next.js", "self"]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":\"Observation\",...}"
}
```

`content` JSON-LD shape: `@type: Observation` with `agent`, `observationDate`, `observationAbout`, `measuredProperty`, `value`, and optional `prov:wasDerivedFrom` for source URLs.

### 30501 — `fa:Claim`

A proposition. A claim differs from an observation in that it makes an assertion about what is true, and it typically carries citations to observations or other claims.

```json
{
  "kind": 30501,
  "tags": [
    ["d", "next.js-routes-no-static-opt-with-cookies-v1"],
    ["blake3", "bk-..."],
    ["alt", "Claim: Next.js 15 disables static optimization for any route that reads cookies."],
    ["fa:context", "https://4a4.ai/ns/v0"],
    ["t", "next.js"],
    ["a", "30500:npub1abc...:next.js-app-router-cookies-pitfall-v1"]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":\"Claim\",\"citation\":[...]}"
}
```

`content` JSON-LD shape: `@type: Claim` with `author`, `datePublished`, `about`, `appearance`, and `citation` (an array of 4A object references).

### 30502 — `fa:Entity`

A thing. Entities are the nouns the rest of the network refers to — a codebase, a person, an organization, a concept. Typically stable; revisions are uncommon.

```json
{
  "kind": 30502,
  "tags": [
    ["d", "github.com/vercel/next.js"],
    ["blake3", "bk-..."],
    ["alt", "Entity: Next.js (TypeScript framework)"],
    ["fa:context", "https://4a4.ai/ns/v0"]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":[\"Thing\",\"SoftwareSourceCode\"],\"@id\":\"https://github.com/vercel/next.js\",\"name\":\"Next.js\",\"codeRepository\":\"https://github.com/vercel/next.js\",\"programmingLanguage\":\"TypeScript\"}"
}
```

`content` JSON-LD shape: `@type` is `Thing` with one or more Schema.org subtype hints (`Person`, `Organization`, `Place`, `CreativeWork`, `SoftwareSourceCode`).

The `d` tag is the canonical identifier for the entity — typically a URL, DID, or stable slug. This is how other 4A objects reference it via `a` tags.

### 30503 — `fa:Relation`

A reified relationship. Use when the relationship itself needs provenance or time-bounding (start/end dates, attestor, citations). For lightweight relationships, prefer bare JSON-LD properties inside an Entity payload.

```json
{
  "kind": 30503,
  "tags": [
    ["d", "tj-holowaychuk-maintainer-express-2009"],
    ["blake3", "bk-..."],
    ["alt", "Relation: TJ Holowaychuk was maintainer of expressjs/express starting June 2009"],
    ["fa:context", "https://4a4.ai/ns/v0"],
    ["a", "30502:npub...:tj-holowaychuk"],
    ["a", "30502:npub...:github.com/expressjs/express"]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":\"Role\",\"roleName\":\"maintainer\",\"subject\":{\"@id\":\"4a://entity/tj-holowaychuk\"},\"object\":{\"@id\":\"https://github.com/expressjs/express\"},\"startDate\":\"2009-06\"}"
}
```

`content` JSON-LD shape: `@type: Role` with `roleName`, `subject`, `object`, and optional `startDate` / `endDate` / `prov:wasAttributedTo`.

### 30504 — `fa:Commons`

A pubkey declaring itself a commons for a topic or project. Consumers subscribe to a commons the same way a Nostr user follows an account: pin the pubkey, filter events by its kinds.

```json
{
  "kind": 30504,
  "tags": [
    ["d", "next.js"],
    ["blake3", "bk-..."],
    ["alt", "Commons: Next.js project — maintained architectural decisions, migration notes, common pitfalls."],
    ["fa:context", "https://4a4.ai/ns/v0"],
    ["t", "next.js"],
    ["p", "npub1-co-maintainer-1..."],
    ["p", "npub1-co-maintainer-2..."]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":\"Organization\",\"name\":\"Next.js Commons\",\"description\":\"Architectural decisions, migration notes, and common pitfalls for vercel/next.js.\",\"memberOf\":{\"@id\":\"https://github.com/vercel/next.js\"}}"
}
```

`content` JSON-LD shape: `@type: Organization` with `name`, `description`, `memberOf` pointing at the project entity.

The `p` tags list co-maintainers whose pubkeys are recognized as publishing to this commons.

## Consumption

An MCP gateway subscribes to a chosen set of relays with filters like:

```json
[
  "REQ",
  "4a-observations",
  {
    "kinds": [30500, 30501, 30502, 30503, 30504],
    "#fa:context": ["https://4a4.ai/ns/v0"]
  }
]
```

Clients that don't recognize 4A kinds fall back to the `alt` tag for a human-readable summary. Clients that understand the kinds parse `content` as JSON-LD against the 4A context.

## Reserved but unused (v0)

Leave these slots unclaimed pending experience:

- 30505–30509 — pin declarations, aggregator rollups, responses, disputes. Design after v0 adoption data.
- 30510–30514 — encrypted variants of 30500–30504 (private mode). Reserved 1:1 with the public kinds (30510 = encrypted Observation, 30511 = encrypted Claim, etc.). See [`SPEC.md`](./SPEC.md) → "Future work — private mode" for the anticipated design. Implementations MUST NOT publish in this range until the encrypted-variant specification is finalized.
- 30515–30519 — further post-v0 kinds.

## Open questions for the NIP submission

- Should 4A kinds live in the 30000-range alongside other addressable objects, or should the submission propose a dedicated block (e.g. 30500–30519) with a formal reservation?
- Should the `fa:context` tag be mandatory, or is it sufficient to check the `content` field?
- Do we want a compact binary form of the JSON-LD payload for size-sensitive relays, or is JSON fine at v0 scale?
- Should `Observation` and `Claim` be merged into a single kind with a discriminator field? Argument for merge: fewer kinds to reserve, simpler filters. Argument against: they serve different roles in reasoning and the JSON-LD shape differs.

## Change log

- 2026-04-24 — initial draft. Kinds assigned tentatively; subject to NIP review.
