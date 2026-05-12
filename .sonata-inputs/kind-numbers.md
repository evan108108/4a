# Kind numbers

NIP event-kind numbers used or reserved by 4A. Source of truth: `../kind-assignments.md`. Update this file when the registry changes.

## Status

All numbers are **proposed** as of 2026-04-24. They are placeholders chosen from an apparently-unreserved block in the 30000 range; before v0 ships in the wild, the spec must either submit a NIP reserving the block, or pick the first contiguous unassigned slots after a fresh registry check against [nostr-protocol/nips](https://github.com/nostr-protocol/nips).

Range posture: 30000–39999 are **addressable** (NIP-01 parameterized-replaceable) — this is the right neighborhood for objects that revise.

## Knowledge layer (v0)

| Kind | Name | Replaceability | Purpose |
|---|---|---|---|
| 30500 | `fa:Observation` | Addressable by `d` | A memory — agent's observation about the world, with provenance. |
| 30501 | `fa:Claim` | Addressable by `d` | A stated proposition with citations. |
| 30502 | `fa:Entity` | Addressable by `d` | A thing — person, organization, place, codebase, concept. |
| 30503 | `fa:Relation` | Addressable by `d` | A reified relationship between two entities. |
| 30504 | `fa:Commons` | Addressable by `d` (topic slug) | A pubkey declaring itself the commons for a topic or project. |

## Credibility layer (Phase 3, v0)

| Kind | Name | Replaceability | Purpose |
|---|---|---|---|
| 30506 | `fa:Score` | Addressable by `d` (target event id) | A signed, weighted opinion about a target 4A object. MUST be paired with a 30507 rationale. |
| 30507 | `fa:Comment` | Addressable by `d` (per-comment slug) | A signed prose response targeting any 4A event. Used as paired rationale for Scores; also used standalone or recursively. |

## Encrypted variants (v0.5)

| Kind | Name | Notes |
|---|---|---|
| 30510 | `fa:EncryptedObservation` | NIP-44 v2 to epoch pubkey, NIP-17 gift-wrapped per recipient. |
| 30511 | `fa:EncryptedClaim` | Same wrap. |
| 30512 | `fa:EncryptedEntity` | Same wrap. |
| 30513 | `fa:EncryptedRelation` | Same wrap. |
| 30514 | `fa:EncryptedCommons` | Same wrap. |

## Audience layer (v0.5)

| Kind | Name | Replaceability | Purpose |
|---|---|---|---|
| 30520 | `fa:Audience` | Addressable by `d` (audience slug) | Audience declaration: identity, current epoch, public roster. |
| 30521 | `fa:KeyGrant` | Addressable by composite `d` (`audience-slug:epoch:recipient-hex`) | NIP-44 v2 ciphertext delivering an audience epoch private key to one recipient. |
| 30522 | `fa:AudienceClaim` | Addressable by composite `d` (`audience-slug:epoch:invite-pub-hex`) | Off-band claim signed by an invite throwaway key, requesting a real key-grant. |

## Reserved

| Range | Use |
|---|---|
| 30505 | **Reserved** — held back so the v0 knowledge block isn't contiguous with credibility kinds. May be assigned later. |
| 30508–30509 | **Reserved** — buffer between credibility and encrypted-variant blocks. |
| 30515–30519 | **Reserved** — buffer between encrypted variants and audience block. |
| 30523–30529 | **Reserved** for future v0.5 audience-side metadata kinds (see `../SPEC-v0.5.md` §8). |
| 30530–30539 | **Reserved for Sonata Studio** (`fa:StudioCard`, `fa:StudioTrack`, `fa:StudioDispatchIntent`, `fa:StudioComment`, `fa:StudioQuestion`, `fa:StudioAnswer`, `fa:StudioRoom`, headroom). Studio is a 4A application built on v0.5 audiences; kinds carry Studio-specific JSON-LD payloads (context: `https://sonata.4a4.ai/ns/studio-v0`) and are always audience-addressed. Normative shapes will land in the forthcoming `studio-v0` spec. |

## Off-limits — known constraints that narrowed the 4A choice

- **30000–30099** — actively used for follow sets, relay sets, bookmark sets, curation sets.
- **30017–30030** — stalls, products, long-form content, emoji sets.
- **30078** — "application-specific data." Overloaded but in active use.
- **39000–39009** — NIP-29 group metadata. Do not use this range despite superficial cuteness.

## Why 30500+

The 30500–30509 block read as unassigned at registry-check time. The block 30500–30519 was reserved on the 4A side to leave room for post-v0 kinds (pin declarations, aggregator rollups, response/reply objects) without fragmentation. Encrypted variants (30510–30514) and the v0.5 audience block (30520, 30521, 30522) extend that reservation. Studio (30530–30539) extends it further.

## Off the wire

| Tag value | Where used | Purpose |
|---|---|---|
| `4a.credibility.<domain>` (NIP-32 `l`) | Score events | Per-domain credibility tagging. |
| `4a.stamp.<provider>` (NIP-32 `l`) | Bootstrap stamps | E.g. `4a.stamp.github` indicates GitHub-OAuth-verified identity. |
| `4a.sponsor` (NIP-32 `l`) | Sponsorship attestations | One pubkey vouches for another. |
| `fa:context` | All 4A events | `https://4a4.ai/ns/v0` (or pinned version). |
| `fa:pending` | `kind:30520` declarations | Marks an `invite_pub` awaiting claim. |

## See also

- `../kind-assignments.md` — full table with detailed per-kind subsections.
- `../SPEC.md` — normative wire format for 30500–30507.
- `../SPEC-v0.5.md` — normative wire format for 30510–30522.
- `spec-excerpt.md` — load-bearing SPEC sections for an agent reading this folder.
