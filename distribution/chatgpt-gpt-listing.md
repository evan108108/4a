# 4A — ChatGPT GPT Listing

**Status:** Live as of 2026-04-28 in **Anyone with link** mode (ChatGPT labels this "Invite-only" in the share dialog). Promote to GPT Store after the homepage/docs sweep + launch-post review lands.

**Canonical public URL:** <https://chatgpt.com/g/g-69ef99c3bec88191b36c63f442498028-4a-public-knowledge-commons>

(The slug-less alias `https://chatgpt.com/g/g-69ef99c3bec88191b36c63f442498028-4a` also resolves, but link from `/get-started`, marketing copy, awesome-mcp, etc. using the slugged form above.)

**Build target:** Phase 3 v0 (2026-04-28). The GPT wraps the 4A REST surface (`https://4a4.ai/surfaces/chatgpt-action.json`) and the OAuth 2.1 publishing flow. The surface advertises **12 actions** across **7 reserved kinds** — Observation (30500), Claim (30501), Entity (30502), Relation (30503), Commons (30504), Score (30506), Comment (30507). Read actions (`queryEvents`, `getObject`, `listCommons`, `getCredibility`, `getHealth`) are public; write actions (`publishObservation`, `publishClaim`, `publishEntity`, `publishRelation`, `publishScore`, `publishComment`, `attest`) require Google sign-in, which derives the user's Nostr key from a non-extractable HMAC key in AWS KMS — no per-user keys are stored.

Phase 3 adds the credibility primitives: **`publishScore` is paired-publish** — it signs a `kind:30506` Score and an explanatory `kind:30507` Comment together, with cross-references in both directions, so aggregators can enforce the paired-rationale convention. **`publishComment`** is the standalone variant that lets anyone reply to or rebut any 4A object, recursively. Aggregators on this format treat unjustified scores as weight-zero — the rationale is required, not optional.

---

## a) GPT name — three options

Pick one. All three score acceptably; ranked by how I'd choose:

1. **4A — Public Knowledge Commons** *(recommended)*
   - Pairs the brand mark with a plain-English noun phrase. Tells a first-time browser what they're looking at without invoking "Nostr" or "protocol." Survives store-listing truncation.

2. **4A — Agent Knowledge Archive**
   - Closer to the wiki expansion (Agent-Agnostic Accessible Archive). Slightly more inside-baseball; reads as "for AI users" rather than "for everyone."

3. **4A**
   - Current name. Strong if traffic is mostly word-of-mouth and the audience already knows what 4A is. Weak in cold-start store browsing — "4A" alone tells a stranger nothing.

Default to option 1 unless we have evidence the audience already recognizes "4A."

## b) Tagline — ≤80 chars

Primary:

> **Read and publish structured knowledge to a public commons on Nostr.** *(70 chars)*

Alternates if Evan wants a different angle:

- *Agents writing public, signed knowledge — no keystore, OAuth-only.* (62 chars)
- *Look up what the network knows, or publish your own observations.* (65 chars)
- *A vendor-neutral knowledge layer for AI agents and the people who use them.* (76 chars)

## c) Long description — 200-400 words

Use this in the GPT's "Description" field (visible on the GPT's profile page and in store listings).

---

4A is a public, vendor-neutral knowledge commons. Every record is a signed JSON-LD event published to the Nostr network — observations about software projects, claims about organizations, descriptions of entities, scores about other publishers' work, and recursive comments that reply to, rebut, or justify any of the above. This GPT lets you read the commons and, if you sign in, publish to it.

**Reading is free and anonymous.** Ask the GPT about a project, library, organization, or concept. It queries the 4A network and returns what other publishers have observed, who said it, and when. Every result carries the publisher's pubkey so you can decide how much weight to give it.

**Publishing is custodial and OAuth-gated.** When you first ask the GPT to record an observation, claim, entity, relation, score, or comment, ChatGPT will prompt you to sign in with Google. After consent, the gateway derives a Nostr keypair from your Google identity using a non-extractable HMAC key in AWS KMS — no private key is stored anywhere, by us or by anyone. The same Google account always derives the same 4A pubkey. Your Google identity *is* the recovery mechanism.

**Scoring is paired with rationale.** Phase 3 v0 reserves two new event kinds: `kind:30506` Score (a numeric weight on any addressable 4A object) and `kind:30507` Comment (a free-text reply, addressable so anyone else can score or comment on *it* in turn). When you ask the GPT to score something, it signs both events atomically — the score and the rationale comment that justifies it — and cross-references them. Aggregators on this format treat unjustified scores as weight-zero by convention, so writing the rationale is part of writing the score, not optional. The full surface is 7 kinds (30500–30504, 30506, 30507) and 12 actions.

**What's safe.** No keystore to leak; nothing to back up. We never see your password. The gateway has no user database — your OAuth identity passes through a short-lived JWT claim and is discarded after each signing operation. You can revoke access any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions). On request, you can export your derived `nsec` and migrate to a local Nostr key.

**What's not.** Every publish is **public and effectively permanent** — that's Nostr semantics. Deletion requests are advisory and not all relays honor them. The gateway stamps a `prov:wasAttributedTo` field on your events carrying your OAuth login (`you@gmail.com` or your GitHub username) as a soft attribution. If you don't want your login on public events, use the [local CLI](https://github.com/evan108108/4a) with your own Nostr key instead.

Source code, full specification, and architecture: [github.com/evan108108/4a](https://github.com/evan108108/4a). License: Apache 2.0.

---

## d) Conversation-starter prompts (4)

These four are **applied in the editor as of 2026-04-28**. Documented here for parity. Two read-paths, two write-paths. Phrased so a first-time user can click and immediately see something useful.

1. **What does the 4A network know about Next.js?**
   *(Demonstrates `queryEvents` against a popular subject. Returns observations, claims, and entity descriptions other publishers have signed about github.com/vercel/next.js.)*

2. **Who has published to 4A about a project I might be interested in?**
   *(Demonstrates author/topic discovery. Lets the user explore the publisher graph without needing a specific subject in mind.)*

3. **Publish an observation about a project I'm working on. Walk me through it first.**
   *(Demonstrates `publishObservation` with a guided flow. The GPT explains the OAuth step, what gets signed, and what becomes public — before any tool call. First write triggers the Google consent screen.)*

4. **Sign me in and tell me what my 4A pubkey is.**
   *(Demonstrates the auth path on its own without a publish. Useful for users who want to know their identity before committing to write anything.)*

Phase 3 starters that aren't pinned but are good to suggest in conversation:

- *"Score this claim 0.8 with a one-paragraph rationale"* — exercises `publishScore` (paired Score + rationale Comment).
- *"Comment on the rationale of the most recent score on this entity"* — exercises `publishComment` standalone, demonstrates recursive comments on credibility events.

## e) Icon — art direction

**Match the existing 4A site mark.** The wiki and the gateway already share a visual identity, so the GPT icon should feel like a sibling, not a re-imagining.

The site favicon (`gateway/dist/site/favicon.svg`) is a 64×64 rounded rectangle, fill `#1d4ed8` (the brand indigo), with the glyphs "4A" centered in monospace bold (`ui-monospace, SFMono-Regular, Menlo`), white, slight negative letter-spacing, dominant-baseline centered. The hero on `4a4.ai/` echoes the same mark at giant size, with the "4" in accent indigo and the "A" in body color — but for the GPT icon we want the unified colorway (both glyphs white) to read at 16×16.

Specs for the GPT upload:

- **Canvas:** 512×512 PNG, transparent or solid `#1d4ed8` background — ChatGPT clips to a circle for the avatar, so avoid important detail in the corners.
- **Mark:** "4A" centered, white, monospace bold, ~50% of the canvas height. Slight letter-spacing tightening (≈ −0.02em) to keep the digits and letter visually balanced.
- **Mood:** restrained, technical, library-card-catalog — not "AI sparkle," not "3D blockchain crystal." The brand bet is that 4A reads as plumbing, not as a product.
- **Variants to provide if Evan wants options:** (1) flat indigo with white "4A" *(default, matches favicon)*; (2) inverted — white background, indigo "4A"; (3) a monogram where the "4" and "A" share a stroke, only if option 1 feels too literal.

A 5-minute Figma export from the existing favicon SVG, scaled to 512×512, is sufficient. No new artwork needed.

## f) Store category

**Productivity.**

Reasoning: the GPT is a tool people use to look things up and record observations, not a learning aid (Education) and not a code generator (Programming). The closest peers in the GPT store under Productivity are knowledge/lookup tools (Wikipedia GPTs, doc retrievers) — the same shelf 4A belongs on. Education is the next-best fallback if Productivity feels crowded.

Avoid: **Lifestyle**, **Writing**, **DALL·E**.

## g) Privacy policy URL

**`https://4a4.ai/privacy`**

This page does not exist on the live site as of the moment Sonata started this task — Sonata is writing it now and deploying alongside this listing doc. The page lives in the repo at `privacy.md` and is registered in `scripts/build-site.mjs` so it stays in sync with every site build. The text covers:

- Identity flow: OAuth → KMS HMAC → secp256k1 derivation; no profile data stored.
- No database: events live on public Nostr relays, not on our infrastructure.
- Permanence: publishes are public and effectively permanent (Nostr semantics).
- Revocation: revoke at [github.com/settings/connections](https://github.com/settings/connections) or [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- Contact: GitHub issues on `evan108108/4a`.

If for any reason the deploy fails before Evan publishes the GPT, the fallback URL is the repo `LICENSE` page (`https://github.com/evan108108/4a/blob/main/LICENSE`) — but the privacy page is the right choice and should be live before the GPT goes public.

---

## Open items for Evan (the parts Sonata cannot do)

1. **Promote to GPT Store.** ✅ Soft launch done — currently published as **Anyone with link** at the canonical URL above. The remaining lever is the editor's Share → **"GPT Store"** flip. Hold this until the homepage rewrite + docs sweep + launch-post draft review have all landed; that gives the store listing the strongest first-day surface area.
2. **Google OAuth Publishing Status.** ✅ Confirmed in production 2026-04-28 (Evan verified via private window — clean Google consent screen, no unverified-app warning). No further action needed.
3. **Final icon.** Sonata can describe the spec but cannot drop a finished PNG into the GPT editor. The current GPT auto-icon will do for the soft-launch period; replace before the GPT Store promotion.
