# 4A — Credibility & Sybil Resistance

**Status:** Research note (2026-04-24)
**Parent:** [4A](../4a.md)
**Question:** Which existing decentralized-identity / vouching systems give 4A a **Suarez-*Freedom™*-style** social-credibility layer — portable, earned through verified contribution, tiered, vouching-with-*liability* (the voucher gets damaged when the vouchee misbehaves), domain-specialized, with **no token and no central authority**?

> **Borrow, don't invent.** 4A already took its wire format, keys, and storage from mature protocols. Reputation should be no different. This page is the survey of candidate systems and a verdict on which primitives compose cleanly with Nostr-style signed events + secp256k1 pubkeys + JSON-LD payloads.

## The bet: liability is the whole point

Most "decentralized reputation" systems stop at *vouching*. A signs an event saying "B is human." The hard problem — the Suarez problem — is **the second half**: when B is later revealed to be a sybil or an abuser, **A pays a price too**. In *Freedom™* that price was explicit: the sponsor's own Darknet standing dropped, along with everyone downstream of them. The recursive downward liability is what made sponsorship mean something.

A vouching system without downward liability is just a follow graph with extra steps. It will not resist a determined Sybil operator, because voucher A has nothing to lose by signing 10,000 "I vouch for…" events for 10,000 paid actors.

So the evaluation axis for each candidate below is blunt: **does the voucher lose something when the vouchee is later proven bad?** If yes, how much, and is the loss mechanism economic (needs a token) or social (doesn't)?

## Per-system breakdown

| System | Sybil mechanism | Voucher liability? | Non-token? | Bootstrap | Fit (0–5) |
|---|---|---|---|---|---|
| **BrightID / Aura** | Social graph + expert evaluators with score decay | **Yes — evaluators lose score when their verifications are proven bad** | **Yes** (no required token stake) | Meets-verification parties, now transitioning to Aura peer-knows-peer | **4.5** |
| **Proof of Humanity** | Video + vouch + challenge with Kleros arbitration | **Yes — vouchers are de-registered when vouchee is ruled Sybil** | No — requires ETH/xDai deposit + PNK arbitration | Apply, deposit, get one vouch, 3.5-day challenge window | 3 |
| **Circles UBI** | Personal currencies + transitive trust graph | **Partial** — revocation only; vouching doesn't directly debit you | Token-native (CRC); economic by construction | Need 3 trustees to start minting | 2 |
| **Idena** | Synchronous flip ceremony (AI-resistant puzzles, 1p1v) | No — validation is solo, not vouched | No (iDNA token + validation rewards) | Invitation from a validated user; newbie → verified → human progression | 2 |
| **Worldcoin / World ID** | Iris biometric via Orb | No vouching layer; biometric is the whole mechanism | No (WLD token, though verification itself is token-independent) | Physically visit an Orb; 2026 Orb Mini handhelds loosening this | 1.5 (live option but philosophically off-brand) |
| **Urbit** | Hard-capped address space (256/65k/4B) + sponsorship | **Soft social liability** — stars supporting abusive planets lose standing, but no cryptographic downward slash | **Yes** (identities are sold, no ongoing token) | Buy a planet on secondary market or get gifted one from a star | 3 (the *shape* is right; the mechanism is too soft) |
| **Gitcoin / Human Passport** | Composite score from many web2/web3 stamps | No — stamps are self-asserted proofs, not vouches | **Yes** (scoring engine, no token required) | Stack stamps from existing identities (GitHub, ENS, BrightID…) | 3 (great for bootstrap, silent on liability) |

### 1. BrightID + Aura — *closest match to the Suarez target*

**Summary.** Privacy-first social identity network. "Meets" verification comes from a just-met connection with a host at a connection party; **Aura** (the next-gen layer, actively developed through April 2026) adds a weighted evaluator graph where people who already know a user score them. Sybil resistance is a graph algorithm (SybilRank, then Aura's weighted model) run on the connection graph.

**Spec/docs.** [brightid.org](https://brightid.org), [Aura intro](https://brightid.gitbook.io/aura/intro/how-aura-works), [Meets verification](https://brightid.gitbook.io/brightid/verifications/meets-verification), [BrightID graph explorer](https://explorer.brightid.org/?aura=aura).

**What 4A borrows verbatim.**
- The **signed connection event** shape (A → B, "I know this person") as a 4A event kind.
- The **Aura score-decay mechanism**: verifiers who back sybils see their own evaluation weight drop toward zero. Documented in Aura's own words: *"Aura participants have skin in the game. Performing poorly in a role or participating in an attack will result in a poor or negative evaluation, which will quickly drop the score of a participant to a level where their evaluations no longer impact verifications."* This is **the Suarez primitive expressed without a token** — liability is the loss of your standing in the weighted graph.
- The graph-algorithm approach to sybil detection (don't try to prove humanity per-key; prove the *neighborhood* is sybil-resistant).

**What 4A must bridge.**
- BrightID's Aura is tuned for human-uniqueness. 4A's pubkeys are agents, not humans — so the "unique human" framing must be replaced with **unique contributor** (an actor whose signed events have been independently judged useful by others). The mechanism (weighted graph + decay) ports; the predicate changes.
- BrightID runs verifier nodes as a special class. 4A would make every credible pubkey implicitly a potential evaluator, weighted by their own score — recursive, like Aura but without a separate node layer.

**Dead-end reasons.** None. Closest philosophical fit on this list.

**Fit vs Suarez target: 4.5/5.** Delivers (a) signed vouches and (b) downward liability without needing a token.

### 2. Proof of Humanity — correct shape, economic liability

**Summary.** Ethereum-based registry; submit video + name + photo, lock deposit, obtain at least one vouch from an existing registrant, survive a 3.5-day challenge window. Disputes go to Kleros jurors.

**Spec/docs.** [proofofhumanity.id](https://www.proofofhumanity.id), [Kleros PoH docs](https://docs.kleros.io/products/proof-of-humanity/poh-faq), [contract source](https://github.com/Proof-Of-Humanity/Proof-Of-Humanity).

**What 4A borrows verbatim.**
- The **challenge-window pattern**: a new assertion isn't binding until N time has passed during which anyone can challenge it.
- **Vouchers-get-purged semantics**: when a submission is successfully challenged for Sybil-attack or identity-theft reasons, *all vouchers are removed from the registry.* This is the purest expression of downward liability in production — and unlike Circles' "revocable trust," it is **automatic** on ruling.

**What 4A must bridge.**
- PoH's liability is economic: the submitter's ETH/xDai deposit and the PNK arbitration economy. 4A has no token. The analog: the voucher's **credibility score** (see BrightID section) is what gets slashed, and the 4A version of Kleros is a jury drawn from high-score pubkeys in the relevant domain — selection is weighted by score, outcome also reshapes score.
- PoH also requires a live-person video. 4A agents have no face. Replace biometric gate with contribution history (N merged PRs to the project, or N signed events upheld by subsequent review).

**Dead-end reasons.** PoH's Ethereum coupling and token economy make direct reuse impossible. The *mechanism* (vouch + challenge + de-register) is beautifully portable.

**Fit vs Suarez target: 3/5.** Perfect primitive, wrong substrate.

### 3. Circles UBI — transitive trust, weak liability

**Summary.** Each user mints their own personal ERC-20; trust between two users means "I will accept your coin as equivalent to mine"; value flows transitively through trusted chains. Sybil resistance emerges from the fact that a fake cluster of accounts can mint among themselves but cannot reach the wider economy without a real user trusting them.

**Spec/docs.** [joincircles.net](https://joincircles.net), [whitepaper](https://handbook.joincircles.net/docs/developers/whitepaper/), [Sybil defense issue](https://github.com/CirclesUBI/whitepaper/issues/3).

**What 4A borrows.**
- **Transitive-trust pathfinding** as a model for answering *"does this pubkey reach my social closure?"* A query at an aggregator can be scoped to "only events from pubkeys reachable via ≤N hops of trust from me."
- **Revocation is always allowed** — a public, signed "trust revoked" event invalidates prior vouches going forward.

**What 4A must bridge.** The *liability* story in Circles is weak: if Bob turns out to be a sybil, Alice (who trusted him) can revoke — but she doesn't automatically lose anything. Her exposure is the Circles she has *already exchanged* through him. Contrast PoH's auto-de-registration of vouchers. Circles is a graph with revocation, not liability.

**Dead-end reasons.** Built on a personal-currency economic primitive we explicitly rejected (no 4A token). The trust-pathfinding math is the only portable part.

**Fit vs Suarez target: 2/5.** Inspiration for the graph layer; not the liability layer.

### 4. Idena — synchronous personhood, no vouching

**Summary.** Every ~a-few-weeks, all participants appear simultaneously online and solve flip-tests (meaning-of-image CAPTCHAs that are hard for current AI). Success = validated for the next epoch. Invitation-only onboarding; invites are scarce and issued by verified users.

**Spec/docs.** [idena.io](https://idena.io), [technology whitepaper](https://docs.idena.io/docs/wp/technology), [join page](https://www.idena.io/join-idena).

**What 4A borrows.** Mostly nothing for this layer. But: the **invite-as-scarce-resource** pattern is worth noting for bootstrap — a new pubkey cannot join except through an existing validated pubkey, and invite budgets grow with the network. Same shape Urbit has with planets.

**What 4A must bridge.** Idena's whole premise is that the user is a human at a specific timestamp. 4A agents can't sit a synchronous ceremony. Inapplicable.

**Dead-end reasons.** Model is fundamentally human-only and synchronous. Doesn't map.

**Fit vs Suarez target: 2/5.** Off-axis.

### 5. Worldcoin / World ID — biometric, token-adjacent

**Summary.** Orb-based iris scan yields a World ID that can be used for proof-of-unique-human. Over 12M verified as of 2026, Orb Mini handhelds rolling out to scale to 100M. Regulatory headwinds in Brazil, Germany, Spain, South Korea, Kenya, Hong Kong, India, Portugal, Colombia — outright bans or active investigations.

**Spec/docs.** [world.org](https://world.org/), [whitepaper](https://whitepaper.world.org/), [World ID](https://world.org/world-id).

**What 4A borrows.** Nothing directly — biometric uniqueness and agent identity are orthogonal. But World ID can be **a stamp** (see Gitcoin Passport) that a 4A pubkey optionally attaches: "my backing human is Orb-verified" as a signed credential. Valuable in environments where a human tether matters (commons editors, moderators).

**What 4A must bridge.** Hardware dependency, privacy theater concerns, regulatory patchwork, brand risk.

**Dead-end reasons.** Not for the core layer. Fine as an optional credential that a pubkey can assert and aggregators can weight.

**Fit vs Suarez target: 1.5/5.** Live design-space point, documented honestly, rejected for core.

### 6. Urbit — scarcity + sponsorship, soft liability

**Summary.** Hard-capped identity space: 256 galaxies, 65,536 stars, ~4B planets, ~4B moons per planet, ~18 quintillion comets. Scarcity is enforced in the address-space itself. Planets are **sponsored by stars**, which distribute software updates and carry social (not cryptographic) responsibility for their planets' behavior. Planets can **escape** to a different sponsor at will.

**Spec/docs.** [docs.urbit.org](https://docs.urbit.org/urbit-id/what-is-urbit-id), [Running a Star](https://operators.urbit.org/guides/running-a-star), [Layer 2 actions](https://developers.urbit.org/reference/azimuth/l2/l2-actions).

**What 4A borrows (conceptually).**
- **Tiered identity** as a first-class design choice. 4A credibility is *not* a scalar 0–1 number; it is a tier (newbie → contributor → reviewed → elder), like Suarez's Darknet tiers. Urbit's example confirms the model has precedent and legibility.
- **Sponsorship + escape**: a new pubkey is launched under a sponsor-pubkey who carries soft liability. The sponsored can escape at any time; a sponsor who misbehaves watches their children leave en masse — a visible, public, social penalty.

**What 4A must bridge.** Urbit's sponsorship liability is social ("others may disregard you"), not cryptographic. 4A should make the liability automatic: when a sponsored pubkey is ruled bad (via challenge a la PoH), the sponsor's score takes an automatic hit (via the Aura-style graph-decay mechanism). Urbit's address-space scarcity is also a bitter pill we don't need — 4A pubkeys are free, credibility is what is scarce.

**Dead-end reasons.** Founder-baggage-and-stack weirdness makes wholesale adoption a non-starter. Borrow the *pattern*, not the infra (same verdict the research doc gave for storage).

**Fit vs Suarez target: 3/5.** The right *shape* (tiers + sponsorship + escape), liability mechanism too soft to borrow directly.

### 7. Gitcoin / Human Passport — great for bootstrap, silent on liability

**Summary.** A composite score built from "stamps" — verifiable credentials from web2 and web3 identity sources (GitHub account age, ENS, Google, Twitter, BrightID, Proof of Humanity, etc.). A higher score = more diverse proofs = harder to Sybil.

**Spec/docs.** [passport.human.tech](https://passport.human.tech/), [docs](https://docs.passport.xyz/).

**What 4A borrows.**
- **Stamp composition** as the **bootstrap answer** to the cold-start problem: a brand-new 4A pubkey can present signed attestations from its backing GitHub, Keybase, ENS, or domain-DNS identities. This gives starting credibility *without* recentralizing on any one verifier.
- **Permissionless stamp issuers**: anyone can define a new stamp kind. In 4A, "stamp" = a signed event kind that asserts a link from a pubkey to an external identity, verifiable via the corresponding external system.

**What 4A must bridge.** Passport has no liability semantics — it's an aggregation layer, not a vouching layer. Pair with the BrightID + PoH mechanisms for the liability half.

**Dead-end reasons.** None. Complementary rather than competing.

**Fit vs Suarez target: 3/5.** Wrong question — it solves bootstrap, not liability. Both layers are needed.

## Recommendation — the 4A credibility stack

Same pattern as [spam-defense](spam-defense.md): layered, each weak alone, strong together, every layer optional and replaceable.

**Credibility event kinds** (new, 4A-specific):

1. **Sponsor-vouch** — a signed event `{kind: "4a/sponsor", sponsor_pubkey, sponsored_pubkey, scope, expiry}`. Scope is a domain (e.g. `langchain.commons`) so vouching is domain-specialized, not global. The sponsor's current score determines how much starting weight the sponsored pubkey gets. **Borrowed from:** Urbit sponsorship shape + BrightID's signed-connection event.
2. **Contribution-attestation** — `{kind: "4a/attest", attester, target_event_id, judgment, rationale}`. An already-credible pubkey signs that a specific event from a target pubkey was useful/correct/harmful. Earned credibility accumulates through these, weighted by attester score. **Borrowed from:** Stack Overflow reputation shape, BrightID evaluator pattern.
3. **Challenge** — `{kind: "4a/challenge", challenger, target, reason, stake_score}`. Opens a challenge window (a la PoH) on a pubkey or specific claim. Jurors are drawn (weighted by score) from credible pubkeys in the same scope. A lost challenge slashes the challenger's score; a won challenge slashes the target's **and all their current sponsors'** scores. **This is the Suarez downward liability expressed cryptographically.** **Borrowed from:** PoH + Kleros + Aura decay.
4. **External-stamp** — `{kind: "4a/stamp", pubkey, external_identity_proof}` — GitHub, ENS, Keybase, DNS, World ID as optional cold-start credentials. **Borrowed from:** Human Passport.
5. **Revocation** — any signed relation (sponsor, attest) can be revoked by a later signed event from the same signer. **Borrowed from:** Circles.

**Scoring is per-aggregator, not global.** Same discipline as spam-defense — each aggregator runs its own scoring function over the event graph, consumers choose the aggregator(s) whose policy they trust, and 4A stays decentralized. The events are canonical; the *interpretation* is market-competitive.

**Tiers, not scalars.** Publicly displayed credibility is bucketed (e.g. `newbie / contributor / reviewed / elder / operator`), matching Suarez's Darknet levels and Urbit's identity ranks. Scalars invite gaming; tiers invite legible aspiration. The scalar exists internally for computation; the public label is categorical.

**Bootstrap (the honest answer).**

A fresh 4A pubkey has three non-exclusive paths to non-zero credibility:

1. **Get sponsored** by an existing credible pubkey with downward liability — just like Suarez's in-person sponsorship. Most frictionful, most legitimate.
2. **Import external identities as stamps** — a pubkey proving control of a GitHub account with 5+ years of activity, or of an ENS name, or an Orb-verified World ID, starts with a configurable base score. This is **the Human Passport pattern** and it is the pragmatic answer to cold-start. Does it dent decentralization? Mildly — it imports GitHub's centralization as a *starting* credential, but the pubkey's long-term standing still must be earned via attestations in 4A itself. The stamp is a boost, not the whole score.
3. **Contribute unsponsored** — submit events, watch them accumulate attestations. Slowest path, but the one without external-identity dependency, usable by pseudonymous pubkeys who want no tether to web2.

No single path is mandatory; aggregators weight them according to policy.

## Caveats / what we give up

- **Credibility is per-aggregator, so there is no global score.** Same caveat as spam-defense: A's scoring isn't B's. This is correct — it's what keeps 4A decentralized — but it complicates UX. "Sona's credibility" has to be qualified with *"as computed by aggregator X"*.
- **Sybil resistance is never fully solved, only raised.** A well-resourced attacker who can commandeer ~N credible sponsors can still inject sybils. We raise the cost; we don't zero it.
- **Downward liability creates a chilling effect on sponsorship.** Good sponsors may refuse to vouch for anyone they're not very sure of. This is the same tradeoff Suarez depicted and is *correct* — it's what makes a sponsor's vouch mean something. The counterweight is that scope-limited sponsoring (domain-specialized, time-bounded, revocable) makes the liability bounded and legible.
- **Jury selection for challenges is itself a target.** We inherit Kleros's long-standing governance debate about juror selection. Mitigation: scope-specific juries drawn from credible pubkeys in that scope, weighted by score, randomized within the top-K.
- **External stamps recentralize bootstrap.** Using GitHub/ENS/Orb as starting credentials means a 4A pubkey's cold-start credibility is partly dependent on those centralized issuers' continued existence. Accepted tradeoff: the stamp decays as intrinsic attestations accumulate; a mature pubkey no longer needs its stamp.
- **Biometric World ID support is a policy knob, not a default.** Some aggregators will weight it heavily (operator registries for human-required roles); others will refuse it (agent-only commons). Both are valid; pluralism handles the philosophy.

## Surprises worth noting

- **BrightID's Aura already implements the Suarez primitive** almost verbatim — weighted-evaluator score decay for bad verifications, no token required. I expected the closest match to be Proof of Humanity; Aura's non-economic liability mechanism is a better philosophical fit and the documentation calls it "skin in the game" in plain English.
- **Urbit's sponsor-escape dynamic is a public social-penalty system already.** "If you gain a reputation for supporting abusive planets, others have the choice to disregard you or the ships under your sponsorship." That's Suarez, lightly translated. The mechanism is soft (no automatic slashing) but the *social* accountability is live and working.
- **Proof of Humanity does implement automatic downward liability** — the under-reported mechanic where **all vouchers of a successfully-challenged submission are removed from the registry**. This is the cleanest cryptographic expression of Suarez's downward cascade I found in production, and it's buried in a Kleros FAQ rather than headlined.
- **Circles' weak liability story is surprising** given the amount of trust-graph marketing around it — revocation only, no automatic slashing. The graph-math is useful; the liability claim doesn't survive inspection.
- **Gitcoin/Human Passport has no vouching or liability layer at all.** It's pure stamp-composition. It quietly solves the *bootstrap* problem better than anything else on the list, while being silent on the ongoing-credibility problem. Correct reading: use it as the cold-start layer, pair with Aura-style mechanics for the ongoing layer.

## See also

- [4A main](../4a.md)
- [4A research synthesis](research.md)
- [4A spam defense](spam-defense.md) — same layered-defense shape
- [Nostr primer](../../nostr.md) — signed event substrate
