# 4A — Credibility & Attestations

**Status:** Research note (2026-04-24)
**Parent:** [4A](../4a.md)
**Question:** Which existing attestation / signed-claim systems compose cleanly with 4A's stack to give us a Suarez-*Freedom™*-style reputation layer — portable across nodes, earned through verified contribution, publicly visible, tiered (not scalar), vouching-with-liability, domain-specialized, no new token economics?

## The bet: reputation is attestations + a render function, not a number

Every reputation system that actually held the line did one of two things: kept a centralized operator scoring behavior (eBay, Stack Overflow, email reputation DBs), or emitted signed, portable, third-party-issued claims that consumers aggregated however they wanted (PGP WoT, academic citations, professional licensure). 4A is federated and operator-less, so option one is out. That leaves **signed attestations** — and the work has been done. Don't invent a score. Borrow an attestation primitive, define domain-specific schemas, and let each aggregator / client render a tier from the graph however it likes.

The Suarez target decomposes into primitives each system addresses unevenly:
- **Portable** — the claim is a signed object, not an entry in a DB row. Every system here does this.
- **Earned via verified contribution** — the claim says *what* was done, not *how much*. Schema-shaped attestation (EAS, VC, NIP-32 labels with namespaces) does this; generic thumbs-up (NIP-7 reactions, SSB follows) does not.
- **Publicly visible** — default-open event stream. Nostr kinds and SSB feeds fit; VCs default to holder-held and require presentation.
- **Tiered** — derived at render time from the graph, not baked in. None of these systems ship tiers; all of them *enable* tiers if you define the render.
- **Vouching-with-liability** — the attester's pubkey is on the claim; false attestations dent the attester's own credibility via downstream attestations against them. EAS, VC, NIP-58, NIP-85, SSB all support this by default (signed = accountable); liability becomes real only if consumers actually downrank bad attesters, which is a policy/client concern.
- **Domain-specialized** — the schema names the domain. EAS schemas, VC types, NIP-32 namespaces do this cleanly; NIP-58 badges kinda-sorta (one badge definition per domain); SSB doesn't.
- **No new token economics** — all of these work without tokens if you strip the substrate. Only EAS has a token-adjacent substrate (Ethereum) that we'd have to actively avoid.

## Systems evaluated

### 1. Ethereum Attestation Service (EAS)

**Spec:** <https://docs.attest.org> · offchain envelope: <https://docs.attest.org/docs/easscan/offchain> · contracts: <https://github.com/ethereum-attestation-service/eas-contracts>

**Summary.** Open attestation layer originally built on Ethereum. Two modes: onchain (a tx registers an attestation against a schema) and **offchain** (an EIP-712-signed JSON envelope — no chain interaction needed). Schemas are ABI-typed structures registered by a UID; attestations reference the schema UID and carry arbitrary encoded data.

**What 4A borrows verbatim:**
- **The attestation envelope shape.** `{uid, schema, attester, recipient, time, expirationTime, revocationTime, revocable, refUID, data, signature}`. This is exactly the fields 4A needs. The `refUID` field gives us chains-of-attestations for free (attestation A references attestation B — e.g. "I attest that X's prior attestation about Y was correct").
- **The schema registry pattern.** Schemas are separate registered objects with their own UIDs; attestations reference a schema UID. 4A's JSON-LD `@context` already plays this role — EAS's separation of *schema-UID-as-first-class-object* is the pattern we should formalize: one 4A event kind for "attestation schema," another for "attestation."
- **Expiration + revocation as first-class fields.** Suarez reputation is earned and can be lost. `expirationTime` + `revocationTime` primitives cover both.
- **`refUID` for composition.** Attestations about attestations = meta-credibility (the "vouching-with-liability" primitive).

**What 4A must bridge:**
- **EIP-712 → Nostr event signature.** EAS signs an EIP-712 typed-data struct with secp256k1. 4A signs a Nostr event (`sha256(serialized) → secp256k1`). Same curve, different canonicalization. Trivial: define the attestation as a new Nostr event kind, put the EAS fields into tags + content, sign the Nostr way.
- **`attester` / `recipient` as Ethereum addresses → 4A pubkeys.** 20-byte addr vs. 32-byte pubkey. Swap the field type; semantics identical.

**Dead-end reasons:** None for the *primitive*. Onchain EAS is obviously a dead end (requires Ethereum). Offchain EAS is a dead end as a service (uses EAS's indexer/registry), but as a **format specification** it's exactly what we want.

**Fit score:** 7/7 primitives. Portable ✓ (signed envelope), earned-via-contribution ✓ (schema-shaped data), publicly-visible ✓ (if we publish to relays), tiered ✓ (client renders from graph), vouching-with-liability ✓ (`attester` field + `refUID`), domain-specialized ✓ (schema UID per domain), token-free ✓ (offchain mode has zero chain dependency).

### 2. W3C Verifiable Credentials 2.0

**Spec:** <https://www.w3.org/TR/vc-data-model-2.0/>

**Summary.** W3C standard for cryptographically-signed JSON-LD credentials. Issuer makes claims about a subject; holder presents to verifiers. Multiple proof formats (Data Integrity, JWT, COSE, SD-JWT). Heavy spec — privacy, selective disclosure, presentation, revocation registries, status lists, refresh services.

**What 4A borrows verbatim:**
- **JSON-LD `@context` + `type` + `issuer` + `credentialSubject` + `proof` field layout.** Aligns with 4A's existing JSON-LD payload approach (see [vocabulary-v0.md](vocabulary-v0.md)). Our `Claim`-like envelope is already half a VC.
- **The `credentialSchema` field pattern** for versioning schemas — we can re-use this directly.
- **Data Integrity Proofs** (`proof` sub-object with `type`, `created`, `verificationMethod`, `proofValue`) as an *optional* alternative to Nostr-native sig for VC interop.

**What 4A must bridge:**
- **Spec weight.** VC 2.0 is ~100 pages. Our attestation only needs ~10% of it. The discipline: take the core shape, ignore presentations / refresh / status lists / ZK SD-JWT until we need them.
- **Issuer is typically a DID.** 4A uses bare pubkeys. Our pubkey is a valid `did:key` so interop is free — we can emit `"issuer": "did:key:z6Mk..."` and be spec-compliant without adopting a DID registry. Research doc already settled this choice ([research.md](research.md)).
- **Holder model assumes private presentation.** 4A is public-by-design — we just publish the VC as a relay event, skip the presentation flow.

**Dead-end reasons:** None, if we take the shape and skip the optional apparatus. Risk is over-engineering by adopting too much of the spec.

**Fit score:** 6/7 primitives. Missing: tiered is client-side as always. Good on everything else. Slight friction: holder-presentation bias is the wrong mental model for a public archive.

### 3. Nostr attestation NIPs (58 + 32 + 85 + 39 + 56)

**Specs:** [NIP-58 badges](https://github.com/nostr-protocol/nips/blob/master/58.md) · [NIP-32 labeling](https://github.com/nostr-protocol/nips/blob/master/32.md) · [NIP-85 trusted assertions](https://github.com/nostr-protocol/nips/blob/master/85.md) · [NIP-39 external identities](https://github.com/nostr-protocol/nips/blob/master/39.md) · [NIP-56 reporting](https://github.com/nostr-protocol/nips/blob/master/56.md)

**Summary.** Nostr has *five* complementary primitives that cover the credibility space, no single one of them complete.

- **NIP-58 Badges** — kind 30009 (badge definition), kind 8 (badge award), kind 10008 (profile badges). Issuer publishes a definition; awards tag recipient pubkeys. Badges are immutable and non-transferable. Straightforward model.
- **NIP-32 Labeling** — kind 1985 (or self-labeling in any event). `L` tag = namespace (reverse-DNS or ISO), `l` tag = value. Targets via `p` (pubkey), `e` (event), `a` (addressable), `r` (relay), `t` (topic). This is the underrated gem — **general-purpose signed-labels-about-anything with a namespace system.**
- **NIP-85 Trusted Assertions** — kinds 30382–30385 (addressable assertions about pubkeys / events / addressable events / NIP-73 identifiers). Explicitly designed for WoT score computation by "trusted service providers" — i.e. aggregator-computed reputation scores published as signed events.
- **NIP-39 External Identities** — kind 0 profile links to external accounts (GitHub, Twitter, Mastodon) as cross-platform verification.
- **NIP-56 Reporting** — kind 1984, negative attestations ("this pubkey / event is spam / nudity / impersonation").

**What 4A borrows verbatim:**
- **NIP-32's label structure, wholesale.** `L` (namespace) + `l` (value) + target tag is the minimum viable attestation primitive. Use `L = "4a.credibility.contribution"`, `l = "maintainer-level"`, with a `p` tag for the subject pubkey. That's a valid attestation *today* — zero schema work, already implementable in any Nostr client.
- **NIP-58's issuer-publishes-definition-then-awards pattern** for tier-style badges where we want the definition to be a discoverable, referenceable object.
- **NIP-85's aggregator-published-score pattern** for the *derived* layer — aggregators compute tiers from raw attestations and publish them as assertions. This cleanly separates raw evidence (NIP-32 labels) from computed credibility (NIP-85 assertions), which is exactly what a "tier is a render function" architecture needs.
- **NIP-56's reporting kind** as our negative-attestation primitive.

**What 4A must bridge:**
- **Nothing at the wire level.** These *are* Nostr. 4A already speaks Nostr. We define our namespaces (`4a.credibility.*`) and ship.
- **Semantics need design.** The primitive is neutral; the namespace vocabulary (domains, tier names, contribution types) is the 4A work.

**Dead-end reasons:** None. Only friction is that NIP-58 badges are *immutable/non-transferable* (good for permanence, bad for revocation — we'd use NIP-32 labels or issue a newer badge-award that supersedes). NIP-85 is draft-status, so we ship alongside it rather than on top of it.

**Fit score:** 7/7. Portable ✓, earned-via-contribution ✓ (NIP-32 namespaces carry domain), publicly-visible ✓ (relays), tiered ✓ (NIP-85 assertions render from NIP-32 raw), vouching-with-liability ✓ (attester pubkey on every event), domain-specialized ✓ (NIP-32 namespace system), token-free ✓. **This is the native fit.**

### 4. Secure Scuttlebutt (SSB)

**Spec:** <https://ssbc.github.io/scuttlebutt-protocol-guide/>

**Summary.** Append-only Ed25519-signed feeds; follow/block messages form a trust graph; replication happens peer-to-peer within N hops of your follow frontier. Trust is *implicit in the follow graph topology*, not explicit via attestation primitives. Active but fragmented community in 2025–2026 — multiple implementations (go-ssb, TinySSB) but no unified direction since the metafeeds proposal didn't land.

**What 4A borrows verbatim:**
- **The N-hop visibility model.** Already in [spam-defense.md](spam-defense.md) as web-of-trust filtering. Rendering credibility *only within the caller's trust neighborhood* is the right default, not a global score.
- **The conceptual point that append-only + signed = sufficient for accountability.** No revocation needed if the graph can route around bad actors.

**What 4A must bridge:**
- **Feed model vs. event model.** SSB feeds chain sequentially per identity (each message signs the prior). 4A/Nostr events are independent. We don't borrow the feed chain — we already rejected it in the core architecture. No change.
- **SSB has no explicit attestation kind.** Trust is *entirely* emergent from follows. That's insufficient for Suarez-style domain-specialized tiers.

**Dead-end reasons:** Not a dead end as a *primitive source* but SSB offers 4A less than the other systems here because it deliberately has no attestation layer beyond follow. Borrow the trust-topology idea (already done in spam-defense), skip the rest.

**Fit score:** 3/7. Portable ✓, publicly-visible ✓, token-free ✓. Missing: earned-via-contribution (follow is not contribution), tiered (flat graph), domain-specialized (no schema), vouching-with-liability (implicit only).

### 5. Keyoxide / Ariadne Identity (discovered)

**Spec:** <https://spec.keyoxide.org/spec/1/> · <https://docs.keyoxide.org/wiki/ariadne-identity/>

**Summary.** Open decentralized-identity spec used by Keyoxide. Identity claims are bidirectional links between a keypair and a third-party account — the key signs a statement saying "I own X" and the third-party account posts a proof referencing the key. Verification fetches both sides and compares. Signature profiles (ASPs) decouple from OpenPGP so any keypair works.

**What 4A borrows:**
- **The bidirectional-proof pattern** for `NIP-39`-style external-identity claims. Key signs "I am @evan on GitHub"; GitHub gist posts the signed proof. This is a concrete primitive for the "earned via verified contribution" half of Suarez — e.g. "attested to own pull request #N to repo R" with a bidirectional proof linking the 4A pubkey to the merged PR author.

**What 4A must bridge:** Minor. Ariadne assumes OpenPGP or ASP; swap in secp256k1 and we're done.

**Dead-end reasons:** Narrower scope than the others — it's about *linking identity to external accounts*, not domain-specialized credibility in general. Use it as a component, not a foundation.

**Fit score:** 4/7 as a standalone. Not a competitor; a complement to #1 or #3.

## Side-by-side

| System | Envelope shape | Schema system | Revocation | Composable (refs) | Aggregator-native | Token-free | Fit |
|---|---|---|---|---|---|---|---|
| EAS (offchain) | ✓ (EIP-712 typed) | ✓ (UID registry) | ✓ (first-class field) | ✓ (`refUID`) | indirect | ✓ (offchain mode) | 7/7 |
| W3C VC 2.0 | ✓ (JSON-LD + proof) | ✓ (`credentialSchema`) | ✓ (status list) | partial | no | ✓ | 6/7 |
| Nostr NIPs (58/32/85) | ✓ (Nostr event) | ✓ (NIP-32 namespace + NIP-58 defs) | partial (supersede) | ✓ (`e`/`a` tags) | ✓ (NIP-85) | ✓ | 7/7 |
| SSB | ✓ (signed feed msg) | ✗ | ✗ | implicit | ✗ | ✓ | 3/7 |
| Ariadne / Keyoxide | ✓ (signed claim) | partial | partial | ✗ | ✗ | ✓ | 4/7 (complement) |

## Recommendation

**Borrow from two systems. Compose.**

### Primary: Nostr NIP-32 + NIP-58 + NIP-85 (native fit)

Because 4A is already a Nostr-superset wire format, these primitives are *already live* on our substrate. Zero bridging required.

- **NIP-32 labels** = raw signed attestations. Define `4a.credibility.*` namespace. `["L", "4a.credibility.contribution"]`, `["l", "merged-pr", "4a.credibility.contribution"]`, `["p", "<subject>"]`, `["r", "<evidence-url>"]`. This is the *earned-through-verified-contribution* primitive.
- **NIP-58 badges** = tier declarations. A badge definition (kind 30009) under 4A's "commons" pubkey names a tier: `npm-maintainer`, `oss-contributor-tier-3`, etc. Badge awards (kind 8) require `refUID`-style evidence via `e`-tags pointing to the underlying NIP-32 attestations that earned the tier.
- **NIP-85 assertions** = the *render layer*. Aggregators compute tiers from the raw NIP-32/NIP-58 graph and publish kind 30382 assertions with `["4a.tier", "<domain>", "<level>"]` tags. Clients query these.

### Secondary: EAS offchain envelope (shape discipline)

The EAS offchain attestation struct is the cleanest field set in this space. Even though we implement over Nostr, **model our attestation event after the EAS struct** for field discipline:

| EAS field | 4A Nostr tag |
|---|---|
| `uid` | event `id` (native Nostr) |
| `schema` | `["L", "<namespace>"]` (NIP-32) or `["a", "30009:<issuer>:<d>"]` (NIP-58) |
| `attester` | event `pubkey` (native Nostr) |
| `recipient` | `["p", "<subject>"]` |
| `time` | event `created_at` (native Nostr) |
| `expirationTime` | `["expiration", "<unix>"]` (NIP-40 already exists!) |
| `revocationTime` | supersede via new event with `["e", "<prior>", "", "revoke"]` |
| `revocable` | `["revocable", "true"]` |
| `refUID` | `["e", "<ref-event-id>"]` or `["a", "<addressable-ref>"]` |
| `data` | `content` (JSON-LD payload using 4a vocab v0) |
| `signature` | event `sig` (native Nostr) |

**Result:** A 4A attestation is simultaneously a valid Nostr event (portable via existing relays) and structurally isomorphic to an EAS offchain attestation (interoperable if anyone wants to bridge). The `content` field uses our JSON-LD vocab ([vocabulary-v0.md](vocabulary-v0.md)), giving us a `Claim`-typed payload inside an attestation envelope.

### Tier-as-render-function

Critical: do not bake tiers into the protocol. The primitive is the attestation. The tier (`maintainer`, `tier-3-contributor`, `bronze/silver/gold`) is what each aggregator or client *computes* from the graph. Different aggregators will disagree on tiers — that's fine. Publish the disagreement as NIP-85 assertions from distinct aggregator pubkeys; consumers pick which aggregator they trust. Same architecture we already landed for moderation in [spam-defense.md](spam-defense.md).

### What this gives us against the Suarez target

- **Portable** — signed Nostr events replicate to any relay.
- **Earned via verified contribution** — NIP-32 namespace + evidence URL + attester pubkey; the attestation names *what was done*, not "trust +1."
- **Publicly visible** — default-open relay firehose.
- **Tiered** — NIP-85-computed, per-aggregator, not baked into raw attestations.
- **Vouching-with-liability** — every attestation carries attester pubkey; attestations-about-attesters (via `refUID`-equivalent `e`-tag) make bad attesters downrankable.
- **Domain-specialized** — NIP-32 namespace system (`4a.credibility.rust`, `4a.credibility.medical-research`, etc.) is exactly designed for this.
- **Token-free** — no chain, no coin, no fee.

## Caveats / what we give up

- **Tier disagreement is permanent.** Two aggregators will compute different tiers from the same raw attestation graph. No global truth. This is the same tradeoff we already accepted for moderation ([spam-defense.md](spam-defense.md)) — acknowledging it again here.
- **Schema design is the real work.** The primitives are ready; defining the `4a.credibility.*` namespace (which domains, which contribution types, which evidence-URL conventions) is v0.1 work and the place we'll get it wrong first. Start narrow: OSS-commons domain only, match the killer-use-case in [4a.md](../4a.md).
- **NIP-58 immutability complicates revocation.** Badges can't be un-awarded. Use NIP-32 labels for things that need revocation (most credibility claims), reserve NIP-58 for genuinely permanent achievements ("published RFC-7231"). NIP-40 (expiration tag) handles time-bounded credibility.
- **Sybil attacks on the attester graph.** Same problem as spam-defense. Unsolved by this layer; mitigated by the overall stack (PoW floor, WoT filtering, aggregator reputation). Reputation *of attesters* is recursive — an attacker who mints 1,000 pubkeys to self-attest gets filtered by any aggregator worth trusting because none of those pubkeys have inbound attestations from established keys.
- **EAS compatibility is aesthetic, not functional.** We steal the field set; we don't actually interop with EAS consumers. If someone later wants a bridge, the shape-matching makes it trivial — but it's not free interop.
- **W3C VC interop is claimed but not proven.** `did:key` from our pubkey is spec-compliant; no one has tested a 4A attestation being consumed by a VC verifier. File this under "nice to have," not "architectural commitment."
- **NIP-85 is draft.** The aggregator-published-tier pattern works today regardless (it's just addressable events), but the NIP itself may evolve. Build with current semantics; accept a future migration.

## Open questions for v0.1

- Exact namespace vocabulary: `4a.credibility.<domain>.<level>` vs `4a.credibility.<domain>` with level as `l` value? (Lean toward the latter — matches NIP-32 idiom.)
- Which aggregator publishes tier assertions for the initial OSS-commons use case? Evan's pubkey? A commons-specific service key? (Decision: start with a single service key per commons — maintainers run it.)
- Evidence-URL schema: require canonical forms (GitHub PR URL) or accept any URL with a BLAKE3 CID snapshot as fallback?
- Do we ship a minimal reference attester/verifier alongside the reference relay in Month 2, or defer to Month 3?
