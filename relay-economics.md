# 4A — Relay Economics

**Status:** Research note (2026-04-24)
**Parent:** [4A](../4a.md)
**Question:** Who runs relays — especially aggregator relays — and why? Simplest proven operator/incentive model we can borrow.

## The bet: no new economics

Every federated protocol that survived did it on **mundane, non-crypto** incentives: hobbyists, institutions with preexisting reason to host, and one or two paid tiers for power users. Every protocol that tried to invent a token, rent, or mining model to fund operators either centralized (Farcaster) or stalled (Ceramic). Pick the boring model.

## Proven patterns worth borrowing

- **Hobbyist + donation (Nostr, Mastodon, IRC).** Individuals run free public relays because it's cheap, fun, and ideological. Donations (Patreon, OpenCollective, Lightning zaps) offset the VPS bill. Most of Nostr runs on this.
- **Paid relay as premium tier (nostr.wine, relay.damus.io paid).** A small fee ($5–20/yr or one-time) buys write access, higher rate limits, durable retention. Operator covers costs + modest margin; spam defense is effectively the product.
- **Institution-hosts-its-own (SMTP, Matrix home-servers, Mastodon big instances, XMPP).** A company, university, or community already has ops, legal, and identity — running a node for its constituents is a rounding error. This is the *dominant* pattern by volume for email and Matrix.
- **Foundation-backed reference node (Matrix.org Foundation, Bluesky PBC, Signal Foundation).** One well-funded entity runs the "default" node to bootstrap the network, explicitly accepting temporary centralization. The spec stays open; the foundation is just the landlord of convenience.
- **Domain ownership = responsibility (SMTP).** No token, no rent — *running a mail server* is the identity. You pay for the domain, you pay for the VPS, you get to send. Spam filtering is where the money and attention go.

## Recommendation: the stack 4A borrows

Copy **Nostr's three-tier reality**, sequenced:

1. **Foundation-run reference aggregator** (Matrix.org / Bluesky PBC pattern) during bootstrap — 4A org funds one well-operated aggregator so the network has a default. Explicitly temporary.
2. **Institution-hosts-its-own** is the real target — OSS projects (Next.js, LangChain, Sonata) run their own `commons` relay and aggregator because they already want that audience. The OSS-commons wedge from the main 4A doc *is* the incentive model.
3. **Hobbyist relays + paid-tier relays** fill the long tail. Free relays accept NIP-13-stamped writes with rate limits; paid relays ($10/yr-ish) offer durable retention and higher throughput. Both are Nostr-compatible.

**Why this is the simplest thing that could possibly work:** every tier already runs in production on Nostr, Mastodon, and SMTP. No token economics, no staking, no mining endowment. The aggregator is funded the same way Mastodon's big instances are — a mix of institutional hosting and a paid power-user tier — and OSS-project commons turn relay-running into marketing, not charity.

## Caveats / what we give up

- **No mining-style "build it and they come" incentive.** Growth depends on real-world organizations (OSS projects, companies) wanting to host. Slower than a token launch; durable if it works.
- **Temporary centralization on the reference aggregator.** Bluesky acknowledged this honestly; 4A must too. Mitigated by keeping the spec fully open so anyone can stand one up.
- **Aggregators are expensive.** Indexing the firehose is real infra ($100s–$1000s/mo at scale). The paid tier and institutional hosts have to cover it; pure hobbyists won't run aggregators, only relays.
- **No guarantee of permanence.** Free relays churn (Nostr has seen this). Arweave-via-Irys is the answer for content that must survive; operators aren't.
