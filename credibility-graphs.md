# 4A — Credibility Graphs

**Status:** Research note (2026-04-24)
**Parent:** [4A](../4a.md)
**Question:** Which existing graph-computed reputation systems compose cleanly with 4A's stack (Nostr wire + secp256k1 + BLAKE3 + JSON-LD + MCP) to deliver a *Freedom™-Darknet-shaped* social credibility layer — portable, earned, publicly visible, tiered, vouching-with-liability, domain-specialized, no token?

## The bet: reputation is two graphs, not one

Suarez's *Freedom™* operatives had two independent things: a **rating** (earned by completing quests, i.e. verified contribution) and a **network** (who vouched for them and who they vouched for, with liability flowing both ways). Every production reputation system today conflates these. That is the gap 4A should exploit: 4A already has `citation` in its JSON-LD vocab (contribution signal) and inherits NIP-02 follows from Nostr (endorsement signal). **Run PageRank-family algorithms on each independently, then compose.** Nobody shipping in 2026 is doing that cleanly — every reputation protocol we reviewed uses *one* graph and calls it trust.

## Systems evaluated

| System | Spec / Home | Algorithm | Graph source | Per-domain? | Identity | Chain required? | Alive 2026? | Fit |
|---|---|---|---|---|---|---|---|---|
| **OpenRank (Karma3 Labs)** | [docs.openrank.com](https://docs.openrank.com) | **EigenTrust** + Hubs-and-Authorities + LSA, pluggable | any peer-to-peer trust matrix (follows, engagement, tips, attestations) | **Yes** — explicitly "context of Local Trust" with per-context matrices (Farcaster follow vs. engagement are separate strategies) | abstract "peer"; prod integrations use EVM/Farcaster/Lens/GitHub, but algo is identity-agnostic | **No** (blockchain is one input among many) | Yes — powers Farcaster trust, Lens, GitHub dev ranking | **High** |
| **Nostr WoT ecosystem (nostr-wot, Vertex, nostr.band Trust Rank)** | [nostr-wot.com](https://nostr-wot.com/) · [vertexlab.io](https://vertexlab.io/) · [trust.nostr.band](https://trust.nostr.band/) | Hop-distance (primary) + PageRank-over-follow-graph (nostr.band, Vertex) | NIP-02 follow lists; nostr.band adds mention/reply edges | **Partial** — hop-distance is scalar; Vertex/nostr.band offer personalized *but not per-topic* PageRank. NIP-85 assertions can publish per-topic scores. | secp256k1 pubkey (native match for 4A) | **No** | Yes — WoT-a-thon Nov 2025 → Apr 2026, NIP-85 updated Jan 2026 | **High** (native identity) |
| **NIP-85 Trusted Assertions** | [nips/85.md](https://github.com/nostr-protocol/nips/blob/master/85.md) | Transport only — providers publish pre-computed signed scores as addressable events; algorithm is provider's choice | whatever the DVM provider uses (PageRank, EigenTrust, etc.) | **Yes** — `rank` tag + free-form subject/topic tags; assertions are per-subject | secp256k1 pubkey | No | Yes — active, Vertex rejects it as too static but several DVMs use it | **High** as a *publication format*, agnostic on algorithm |
| **EigenTrust (1,2 — the original Stanford paper)** | [Kamvar et al. 2003](http://ilpubs.stanford.edu:8090/562/1/2002-56.pdf) | Sybil-resistant recursive trust via principal eigenvector of local-trust matrix | abstract peer matrix | **Yes** if you run separate matrices per context (this is what OpenRank does) | abstract | No | Algorithm is 23 years old and actively used (Karma3 is the production descendant) | **High** — this is the primitive |
| **SourceCred** | [sourcecred.io](https://sourcecred.io) · [github.com/sourcecred/sourcecred](https://github.com/sourcecred/sourcecred) | PageRank on a heterogeneous contribution graph (commits, PRs, issues, messages as nodes; authored/reacted-to as edges) | GitHub + Discord + Discourse plugins | Per-instance (one PageRank per community), not per-topic within | plugin-scoped (GitHub handle, Discord ID), no pubkey primitive | No (Grain token is optional, bolt-on) | **No** — last commit 2022-07-30, effectively abandoned | **Medium** — ideas survive even though code is dead |
| **Gitcoin Passport / Human Passport** | [app.passport.xyz](https://app.passport.xyz) · [docs.passport.xyz](https://docs.passport.xyz) | **Credential aggregation**, not a graph algorithm. Sum weighted "Stamps" → Unique Humanity Score. | N/A — scalar from issuers | No — single scalar score; community-specific Stamp weights are the only tuning | Ethereum address | **Yes** — Ethereum-native, Ceramic-backed | Yes | **Low** — solves sybil/humanity, not credibility; doesn't fit the "earned through contribution" shape |

## Detail per system

### OpenRank (Karma3 Labs) — top pick for the contribution primitive

- **What:** Decentralized reputation compute layer. Runs EigenTrust / Hubs-and-Authorities / LSA over a peer-trust matrix you supply. Powers Farcaster's "Following" and "Engagement" trust rankings, Lens Global Trust, and GitHub developer ranking.
- **Borrow verbatim:** The EigenTrust formulation (recursive eigenvector of the normalized local-trust matrix), pre-trust seeding, the idea of **Ranking Strategies as separate matrices per context**. Open-source Rust implementation at [`Karma3Labs/rs-eigentrust-snaps`](https://github.com/Karma3Labs/rs-eigentrust-snaps) already runs EigenTrust on two parallel contexts (Software Security, Software Development) with endorse/dispute credentials. This is the closest thing to Suarez in production.
- **Bridge:** OpenRank's prod integrations use EVM addresses; 4A uses secp256k1. The algorithm is identity-agnostic — the bridge is one table: `pubkey → peer_id`. The rs-eigentrust-snaps repo uses DIDs internally, so a `did:key` wrapper around the Nostr pubkey (trivial; Nostr pubkey *is* a valid `did:key`) makes it drop-in.
- **Dead-end reasons:** None observed. Compute-verifiability story leans on their hosted service, but the algorithm runs locally in Rust with no network dependency. Worst case we fork the rs-eigentrust crate.
- **Fit vs. Suarez target:** Portable (signed scores), earned (endorsements are contribution signals), visible (public), tiered (scalar 0–1 which you bin into tiers), vouching-with-liability (your endorsement weight depends on your own score — if you endorse a bad actor, your downstream trust drops), **domain-specialized (multiple contexts, this is the whole pitch)**. Full fit except the liability signal needs a disendorse/dispute edge type, which rs-eigentrust-snaps already has.

### Nostr WoT ecosystem — top pick for the endorsement primitive

- **What:** Three cooperating projects. **nostr-wot.com** ships a browser-extension-based local hop-distance engine plus a Rust "WoT Oracle" with REST API. **Vertex** (vertexlab.io) runs PageRank over the follow graph and exposes it through DVMs (Data Vending Machines — NIP-90 paid services). **nostr.band Trust Rank** builds a directed graph of pubkeys + mentions + events and runs a weighted PageRank with seed pubkeys. All open source / open API.
- **Borrow verbatim:** The DVM pattern for serving reputation queries (NIP-90), NIP-85 Trusted Assertions (kind:30382 addressable events) as the *wire format* for publishing precomputed scores so 4A aggregators don't each recompute. Hop-distance as a cheap first-pass visibility filter (we already have this in [spam-defense.md](spam-defense.md)).
- **Bridge:** None. Nostr pubkeys ARE 4A pubkeys. This is the free lunch.
- **Dead-end reasons:** Vertex explicitly rejected NIP-85 as "too static" for real-time personalized ranking — this is a tension, not a dead-end. 4A can publish NIP-85 assertions *and* expose a DVM-style live endpoint. They're not mutually exclusive.
- **Fit vs. Suarez target:** Follow-graph hop-distance gives portable/visible/earned-through-being-followed, but is scalar-global (one distance per pair), not tiered and not domain-specialized out of the box. NIP-85 bolts on per-topic scoring. With NIP-85 + per-topic contexts, the fit becomes high.

### NIP-85 Trusted Assertions — the publication bus

- **What:** Nostr event kind 30382. Signed, addressable events that carry pre-computed trust/rank assertions about a subject (pubkey, event, or addressable event). Uses `d` tag for subject, `rank` tag for score. Providers compete on algorithm; clients trust providers they choose.
- **Borrow verbatim:** Event shape, subject-addressable semantics, the *provider-plurality* model. This is exactly how 4A should surface reputation — aggregator relays (per [research.md](research.md)) publish NIP-85 events; consumers pick which providers they honor.
- **Bridge:** None — it's already Nostr. 4A aggregators that compute reputation just publish kind:30382.
- **Dead-end reasons:** Not a full system — it's a transport. Needs an algorithm behind it (OpenRank, Vertex, custom PageRank).
- **Fit vs. Suarez target:** As transport, perfect fit. Portable (signed, addressable, relay-replicated), visible, tiered (via the `rank` tag), domain-specialized (via subject tags). The algorithm provides earning/vouching/liability.

### EigenTrust (the algorithm itself)

- **What:** Kamvar, Schlosser, Garcia-Molina 2003. Each peer's global trust is the principal eigenvector of the normalized local-trust matrix — i.e. peers are trusted in proportion to how trusted peers trust them, recursively. Converges in ~10 iterations on realistic graphs.
- **Borrow verbatim:** The entire paper. It's 23 years old, unpatented, and has dozens of open-source implementations. OpenRank is the production descendant most directly useful to 4A.
- **Bridge:** It's math. The only bridge is picking what the entries of the local-trust matrix mean in 4A's world (citation edges? follow edges? endorsement events?).
- **Fit vs. Suarez target:** Gives all of Suarez's properties *if* you feed it the right graph and run it per-domain. Doesn't invent them.

### SourceCred — dead but the idea is the closest match to Suarez's "earned through contribution"

- **What:** PageRank over a *heterogeneous contribution graph* — commits, PRs, issues, reactions are nodes; authorship and reactions are edges. Outputs a "Cred" score per contributor per community. Grain is an optional token bolt-on; Cred itself is just PageRank.
- **Borrow verbatim:** The heterogeneous-node-type idea: don't PageRank-over-people, PageRank-over-(people + contributions + entities) with typed edges. This is the *exact* shape a 4A citation-graph walker should take — nodes are `Claim`, `Observation`, `Entity`, `Agent`, edges are `citation`, `author`, `about`. SourceCred's edge-weight-per-type configuration maps cleanly to 4A's JSON-LD properties.
- **Bridge:** Their GitHub/Discord plugins are useless to us; the core algorithm in `packages/core/src/core/pagerankGraph.js` is small and reimplementable. Identity layer is pluggable — just feed it pubkeys.
- **Dead-end reasons:** **Project abandoned** — last commit 2022-07-30, no release since v0.11.2. Ideas survive, code does not. Don't take a runtime dependency; reimplement the graph-PageRank core (≈1,000 lines).
- **Fit vs. Suarez target:** Earned-through-contribution, tiered, domain-specialized (per-instance), visible. Missing: vouching-with-liability (no endorse/dispute edges, only authorship). Portable is awkward because Cred is computed per-instance, not signed.

### Gitcoin Passport / Human Passport — out of scope but worth naming

- **What:** Sum-weighted credential aggregator. Stamps from Google/LinkedIn/ENS/BrightID add up to a "Unique Humanity Score." It's a sybil-gate, not a reputation protocol.
- **Borrow verbatim:** Almost nothing algorithmically — no graph, no recursion. **Do borrow** the idea of stamp-weight-per-community (the consumer sets which stamps count for them), which is isomorphic to 4A aggregators picking which reputation providers they honor.
- **Bridge:** Hard — Ethereum address is the identity primitive, Ceramic is the storage backend. Would need a full wrapper layer.
- **Dead-end reasons:** Wrong shape. Answers "is this a real human?" not "is this agent credible about Rails?" They are orthogonal problems; 4A probably wants both, but Passport solves the wrong one here.
- **Fit vs. Suarez target:** Low. Scalar, not tiered-by-earning. Not domain-specialized. Not graph-derived. Not a fit.

## The contribution-vs-endorsement question

None of the five graph systems evaluated cleanly separates a **contribution graph** (citations / authored content) from an **endorsement graph** (follows / vouches). They all collapse to one graph:

- OpenRank: endorsement matrix per context (multiple matrices, but each is endorsement).
- Nostr WoT / Vertex / nostr.band: follow-graph only (plus reply/mention edges at nostr.band, which is still endorsement-shaped — "I engaged with you").
- SourceCred: contribution-graph only (authorship + reaction; no "I vouch for this person" separate from "I reacted to their thing").
- Gitcoin Passport: neither, credential aggregation.

This is the opening. 4A's `citation` vocabulary already defines a contribution graph (Claim cites Observation cites Claim). NIP-02 gives us an endorsement graph for free. Two separate PageRanks, two separate signed score publications (both via NIP-85), two separate aggregator DVMs. A consumer query like "who should I trust about Rails?" composes both: `rank = f(citation_pagerank_in_rails_subgraph, endorsement_pagerank_weighted_by_rails_contributors)`.

That composition is the original research contribution 4A has available. Everything under the composition is borrowed.

## Recommendation

**Adopt two primitives, one transport.**

1. **Endorsement primitive** — Nostr WoT (nostr-wot Oracle + Vertex-style PageRank over NIP-02). Native pubkey match, zero bridge cost, existing OSS infrastructure 4A aggregators can run. Scope: "who does the follow graph trust?"
2. **Contribution primitive** — OpenRank's EigenTrust (rs-eigentrust crate, forked if needed) run over the 4A citation graph as the local-trust matrix, with per-topic contexts keyed by `Claim.about` or a tag. Scope: "who produced claims that subsequent claims built on, in topic T?"
3. **Transport** — NIP-85 Trusted Assertions (kind:30382) for both. Each aggregator relay publishes its precomputed scores as signed Nostr events; consumers pick providers. No new wire format.

Combine at query time in the MCP gateway: a consumer asks "credibility of pubkey X about Rails" and the gateway fetches NIP-85 assertions from both an endorsement provider and a contribution provider, presents the two-number tuple, and lets the client (or consumer's policy) compose.

**Do not adopt:** Gitcoin Passport (wrong shape, chain-heavy bridge). SourceCred runtime (dead). A single unified score (Suarez's whole point is specialization).

**Re-implement, do not depend on:** SourceCred's heterogeneous-node PageRank core (~1,000 lines), because the idea is exactly right for the citation graph but the project is unmaintained.

## Caveats

- **Cold start.** PageRank on empty graphs returns noise. First 6 months of 4A, endorsement scores will be nearly random and contribution scores will be empty. Hop-distance-from-seed-pubkeys is the fallback until the graph has >10K edges.
- **Sybil attacks on the follow graph** are the known open problem (cf. [spam-defense.md](spam-defense.md)). EigenTrust's pre-trust seeding mitigates; doesn't solve. OSS-maintainer commons as seed set is the pragmatic bootstrap.
- **Aggregator centralization.** "Pick your provider" is the honest tradeoff. Same one Mastodon and Bluesky made. Protocol stays decentralized; spam/reputation policy is per-aggregator. Consumers can run the Rust crate locally for queries they care about.
- **Liability signal missing from pure PageRank.** To get Suarez's "if I vouch for a bad actor, my own score drops" you need a disendorse/dispute edge type (OpenRank's `Report`/`Dispute` credentials, not pure follow edges). Worth designing into 4A's vocabulary v0.2 as a first-class edge.
- **Domain specialization needs a taxonomy.** "About Rails" only works if `Claim.about` resolves to a stable topic. Schema.org `about` → entity pubkey/CID works; free-text topics don't cluster. This is the same debate as Schema.org vs. folksonomy. Choose entities, not tags.
- **Computational cost.** Nostr.band runs its global PageRank nightly; Vertex claims real-time but charges per query. A 4A aggregator at network scale will hit the same wall. Incremental PageRank and personalized subgraph PageRank (both ~20 years of literature) are the levers.

## See also

- [4A research](research.md) — full protocol evaluation where aggregator relays were chosen.
- [4A spam defense](spam-defense.md) — layered anti-spam stack; WoT visibility filter is already in scope.
- [4A vocabulary v0.1](vocabulary-v0.md) — `citation`, `author`, `about` — the edges the contribution PageRank walks.
- [Nostr primer](../../nostr.md) — NIP-02 follow graph, NIP-85 trusted assertions.
