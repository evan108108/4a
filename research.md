# 4A — Protocol Research

**Status:** ✓ Complete (2026-04-24). Four research agents returned.

*Originally written as "Commons Protocol research"; idea was renamed to 4A on 2026-04-24.*

## Purpose

Maximize borrowed work from existing protocols; minimize re-invention. Identify which parts of 4A we can take wholesale from efforts that already have thousands of hours of design behind them.

---

## 1. Identity + signed events ✓

**Headline:** Nostr-style bare secp256k1 pubkey primitive + AT Protocol's rotation-key hierarchy (via a PLC-style signed op log) + NIP-05-style handles as optional human-readable sugar. Skip full DIDs for v1.

**Minimum NIP set:** [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) (events), [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) outbox, [NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md) DNS-based handles, [NIP-51](https://github.com/nostr-protocol/nips/blob/master/51.md) lists, [NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md) follow graph.

**Skip:** [NIP-26](https://github.com/nostr-protocol/nips/blob/master/26.md) delegated signing (deprecated in practice). Full DIDs (overkill — our pubkey is already a valid [`did:key`](https://w3c-ccg.github.io/did-method-key/) so interop is cheap later).

**Borrow from AT Protocol:** [`did:plc`](https://github.com/did-method-plc/did-method-plc) rotation-key hierarchy. PGP's core failure is that losing a key means losing identity — don't repeat that.

**PGP lessons (what to avoid):** Moxie Marlinspike's [GPG And Me](https://moxie.org/2015/02/24/gpg-and-me.html), Matthew Green's [What's the matter with PGP?](https://blog.cryptographyengineering.com/2014/08/13/whats-matter-with-pgp/). Unsalvageable UX, long-lived keys are liabilities, WoT never achieved meaningful coverage.

**Sources:** [Nostr NIPs](https://github.com/nostr-protocol/nips), [W3C DID Core](https://www.w3.org/TR/did-core/), [AT Protocol specs](https://atproto.com/specs/atp), [did:plc](https://github.com/did-method-plc/did-method-plc).

---

## 2. Content-addressing + distributed storage ✓

**Headline:** Three-tier storage. Hot = Nostr-style relays over WebSocket. Warm = BLAKE3 content addressing on payloads. Cold/permanent = Arweave (via Irys) for explicitly-pinned knowledge. **Skip IPFS's DHT entirely.**

**IPFS reality check:** DHT lookups slow (2–60s) and frequently fail ([Trautwein 2022](https://research.protocol.ai/publications/design-and-evaluation-of-ipfs-a-storage-layer-for-the-decentralized-web/trautwein2022.pdf)). IPNS unreliable. Cloudflare + Protocol Labs both shut down public gateways 2024–2025. In practice "IPFS" means "Pinata + gateways."

**Hypercore, SSB, iroh, Ceramic, OrbitDB:** evaluated, all rejected for various reasons (ecosystem size, complexity, wrong shape for public commons).

**Arweave + Irys:** the winner for the cold tier. Pay-once-store-forever. [Irys](https://docs.irys.xyz/) handles small signed items at millisecond latency.

**Net architecture:** Nostr relays (hot) + BLAKE3 CIDs (addressing) + Arweave/Irys (cold tier). Skip global DHT, skip IPFS infra.

---

## 3. Federated social ✓

**Headline:** Pure Nostr is right for publishing but **fails at discovery**. Borrow AT Protocol's **aggregator relay** pattern as an optional layer.

**ActivityPub:** Inbox fan-out O(followers), no global search, defederation wars, weak portability. Skip.

**AT Protocol (Bluesky):** Innovation to borrow — aggregator relays crawl PDSs, expose firehose, enable third-party AppViews. Decouples publishing from discovery. Tradeoff: relays expensive, de facto recentralized around Bluesky PBC's relay.

**Matrix:** Room state DAG is elegant but wrong shape for broadcast knowledge.

**Farcaster:** Full-replication hubs don't scale past low millions.

**Nostr's Achilles heel:** Discovery. NIP-65 pushes bootstrap problem around; every serious user depends on centralized search relays like [nostr.band](https://nostr.band).

**Architecture:** Nostr-style publishing + optional AT-style aggregator relays for discovery.

---

## 4. Semantic + agent-native ✓

**Headline:** JSON-LD with `@context` for payloads (schema.org-style pragmatic vocabulary) + MCP as AI consumption interface + A2A Agent Cards for node discovery. Skip RDF/SPARQL/OWL.

**JSON-LD:** Sweet spot — plain JSON with `@context` gives graph semantics for free, degrades to plain JSON. [JSON-LD 1.1 spec](https://www.w3.org/TR/json-ld11/).

**Schema.org lesson:** One vocabulary blessed by consumers who matter beat bottom-up ontology committees. Curate one blessed vocab; resist ontology debates.

**Solid:** Identity-first design right, but chicken-and-egg adoption and painful auth UX. Borrow idea, not stack.

**MCP:** Non-negotiable. Current extensions: Resources, Prompts, Sampling, Roots, Elicitation. Federation still nascent.

**A2A (Google, Linux Foundation):** [Agent Cards](https://a2aproject.github.io/A2A/) as discovery manifests — "here's what I can do + how to reach me" JSON doc.

**Cautionary tales:** Holochain (steep mental model, no killer app), Urbit (radically unfamiliar stack + founder baggage), Gemini protocol (proves minimalism builds community), Project Xanadu (shipped 54 years late — TBL won by accepting broken links).

**Skip:** RDF/XML, Turtle, SPARQL as required tooling. OWL/reasoners. LDP's full container model.

---

## Synthesis — The architecture after research

| Layer | Choice | Source |
|---|---|---|
| Identity | secp256k1 pubkey + PLC-style rotation log | Nostr + AT Protocol |
| Wire format | Nostr-style signed event with JSON-LD `@context` | Nostr + JSON-LD |
| Content addressing | BLAKE3 CIDs on payloads | multiformats / iroh |
| Hot storage | WebSocket relays (Nostr-compatible) | Nostr |
| Cold storage | Arweave via Irys for pinned content | Arweave |
| Publishing | Client → any relay(s), no inter-relay gossip | Nostr |
| Discovery | Optional aggregator relays (firehose + search) | AT Protocol |
| Agent consumption | MCP server over the event/relay layer | MCP |
| Node discovery | A2A-style Agent Cards | A2A |
| Schema | Schema.org-flavored pragmatic vocab, JSON-LD | Schema.org |
| Write auth | OAuth-ish scoped to pubkey | Solid-inspired |

**Open questions still:**
- **Aggregator relay economics.** Who runs them? How is moderation policy surfaced? What's the business model?
- **Specific JSON-LD vocabulary** for knowledge objects — needs v0.1 schema draft.
- **Spam defense at the aggregator layer.** NIP-13 PoW at publish is partial.
- **Incentive model for relay operators.** Nostr solved this badly (hobbyist-run). Arweave-anchored pins could subsidize.
