# 4A — Spam Defense

**Status:** Research note (2026-04-24)
**Parent:** [4A](../4a.md)
**Question:** Simplest proven spam-defense mechanism for a public signed-event network, specifically at the **aggregator-relay layer** where publish-side PoW is insufficient.

## The bet: spam defense is a stack, not a silver bullet

Every public messaging system that survived did it with layered, independently-weak filters. No single primitive — not PoW, not reputation, not captcha — held the line alone. 4A should copy the *shape* of that stack, not any one layer.

## Proven patterns worth borrowing

- **Publish-side cost (Hashcash / NIP-13 PoW).** A small proof-of-work stamp on each event. Doesn't stop spam; raises the floor so flooding costs *something*. Cheap to verify, partial defense.
- **Per-sender reputation (Email, Reddit karma, Stack Overflow rep).** Aggregators track pubkey-level behavior — accepted rate, flag rate, age. New pubkeys are throttled; established pubkeys flow. This is what email reputation databases actually do under SPF/DKIM.
- **Web-of-trust filtering (Nostr NIP-02, Gmail contacts).** Show the consumer only events from pubkeys within N hops of pubkeys they already follow. Not moderation — *personalized visibility*. Scales because each consumer defines their own trust frontier.
- **Instance-level blocklists / defederation (Mastodon, IFTAS).** Aggregator operators publish and subscribe to shared lists of abusive pubkeys and abusive peer relays. Coordination without central authority.
- **Community flagging + automod (Reddit, Stack Overflow, HackerNews).** A small trusted set of consumers flags bad events; aggregators down-rank or hide. Cheap, human-in-the-loop, works surprisingly well.

## Recommendation: the layered stack 4A borrows

At **publish time** (relay):
1. NIP-13 PoW stamp on every event (cheap floor).
2. Per-pubkey rate limits on the relay (stops single-key floods).

At **aggregator time** (discovery layer — where real spam lives):
3. Pubkey reputation score kept by each aggregator — age, accept rate, flag rate. New keys throttled.
4. Web-of-trust visibility filter: default queries return results within N hops of the caller's follow set. Opt into the raw firehose.
5. Shared blocklists between aggregators (IFTAS/Mastodon pattern) — subscribe to the operators you trust, defederate the ones you don't.
6. Community flagging surfaced through MCP — consumers' agents can flag, aggregators decide whether to honor.

**Why this is the simplest thing that could possibly work:** every layer already exists in production somewhere. No new economics, no token, no captcha for agents (which is nonsense anyway). Each layer is weak alone and strong together, and every layer is *optional* — aggregators compete on policy.

## Caveats / what we give up

- **No global "truth."** Different aggregators show different slices. A query to aggregator A ≠ aggregator B. This is a feature, but it complicates "how do I find X."
- **Web-of-trust cold-start.** New pubkeys are invisible until someone follows them. Bootstrap requires seed follow-graphs (OSS maintainer commons is a natural seed).
- **Reputation is centralized *per aggregator*.** The protocol stays decentralized; the spam policy doesn't. That's the honest tradeoff Mastodon made and it held.
- **Adversarial pressure moves to Sybil attacks** on the follow graph and to gaming reputation. Known problem, no clean fix — mitigated by the stack, not solved by it.
