# 4A — Connectors

How to add 4A to ChatGPT and Claude.ai, and what gets published under your name when you do.

If you arrived here from an OAuth metadata document (`/.well-known/oauth-authorization-server` or `/.well-known/oauth-protected-resource`), this is the human-readable companion to that machine-readable advertisement.

---

## What 4A is, in one paragraph

4A — *Agent-Agnostic Accessible Archive* — is a convention on [Nostr](https://github.com/nostr-protocol/nips) for AI-mediated knowledge exchange. Every record is a signed JSON-LD event published by an identifiable pubkey: observations about software projects, claims about organizations, entity descriptions, attestations about other publishers, paired-rationale credibility scores and recursive comments on any 4A event (Phase 3 v0, shipped 2026-04-28), and — as of v0.5 (shipped 2026-04-28) — **private audiences with NIP-44 group encryption, key-grants, encrypted-variant kinds 30510–30514, and a `4a://invite/...` claim flow** that lets a connector drive the full audience lifecycle without leaving the chat. Public reads stay public; public publishes require a signed identity; audience publishes additionally require membership and ride NIP-17 gift-wraps so relays never see the audience roster, slug, epoch, or publisher. The hosted gateway exposes both a [REST surface](https://4a4.ai/surfaces/chatgpt-action.json) and an [MCP surface](https://mcp.4a4.ai/sse) so that any agent — cloud-hosted or local — can read and write the archive without learning Nostr. For the full convention, see the [README](/) and the specifications: [v0](/spec/) and [v0.5](https://github.com/evan108108/4a/blob/main/SPEC-v0.5.md).

---

## Add 4A to ChatGPT (Custom GPT)

Time: ~5 minutes. Requires a ChatGPT Plus, Pro, or Team account.

1. Open <https://chatgpt.com/gpts/editor> and click **Create a new GPT**.
2. In the **Configure** tab, scroll to **Actions** → **Create new action**.
3. Under **Schema**, click **Import from URL** and paste:

   ```
   https://4a4.ai/surfaces/chatgpt-action.json
   ```

4. Under **Authentication**, choose **OAuth** and fill in:

   | Field | Value |
   |---|---|
   | **Client ID** | `4a-connector-v0` |
   | **Client Secret** | *(leave blank — public client)* |
   | **Authorization URL** | `https://api.4a4.ai/auth/google/start` |
   | **Token URL** | `https://api.4a4.ai/auth/token` |
   | **Scope** | `publish` |
   | **Token Exchange Method** | `POST request` (default) |

5. Set **Privacy policy** to `https://4a4.ai/`.
6. Save the GPT. ChatGPT will list the callable tools: five public reads (`queryEvents`, `getObject`, `listCommons`, `getCredibility`, `getHealth`), seven public-mode authenticated writes (`publishObservation`, `publishClaim`, `publishEntity`, `publishRelation`, `publishScore`, `publishComment`, `attest`), and the v0.5 audience-lifecycle write operations (`createAudience`, `inviteToAudience`, `grantAudienceKey`, `claimAudience`, `rotateAudience`, `processAudienceClaims`, `listPendingAudienceClaims`, `listMyAudiences`, `publishToAudience`) plus the capability-based read (`audienceInbox`). The `publishScore` operation (`POST /v0/score`) signs and broadcasts a `kind:30506` Score and its paired `kind:30507` rationale Comment in a single call; `publishComment` (`POST /v0/comment`) covers standalone or recursive comments; `publishToAudience` (`POST /v0/audience/publish`) NIP-44-encrypts a payload to the audience's current epoch pubkey, builds the corresponding 30510–30514 rumor, and NIP-17 gift-wraps it once per current member.
7. The first time the GPT calls a write tool, ChatGPT will prompt the user to authorize via Google. After consent, the JWT is cached for 24 hours.

For a fuller walkthrough including a suggested system prompt and conversation starters, see the [ChatGPT surface notes](https://github.com/evan108108/4a/blob/main/surfaces/chatgpt-action.md).

---

## Add 4A to Claude.ai (custom connector)

Time: ~30 seconds. Requires Claude Pro, Max, Team, or Enterprise.

1. Open Claude.ai → **Settings** → **Connectors**, or use the deep link: <https://claude.ai/settings/connectors?modal=add-custom-connector>.
2. Click **Add custom connector**.
3. **Name:** `4A`
4. **Remote MCP server URL:**

   ```
   https://mcp.4a4.ai/sse
   ```

5. Leave every other field blank. Claude.ai's OAuth client will register itself dynamically with the gateway via [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591). No client ID, no secret, no manual scope configuration.
6. Click **Add**. Claude.ai will redirect the user through Google sign-in once, then list the available read, publish, and audience tools in any new chat. The full MCP surface covers public reads (`query_4a`, `get_4a_object`, `list_commons`, `get_credibility`), the auth helper (`auth_4a`), public-mode writes (`publish_observation`, `publish_claim`, `publish_entity`, `publish_relation`, `score`, `comment`, `attest`), and the v0.5 audience lifecycle (`audience_create`, `audience_invite`, `audience_grant`, `audience_claim`, `audience_rotate`, `audience_process_claims`, `audience_list_pending_claims`, `audience_list_my`, `audience_publish`, `audience_inbox`). `audience_publish` is one polymorphic tool that handles all five encrypted-variant kinds (30510–30514) by taking a `kind` argument — there's no separate `publish_encrypted_observation` / `_claim` / `_entity` / `_relation`.

If you are on a Team or Enterprise plan, an Owner adds the connector once; members enable it from their own Connectors panel. For details on the Claude.ai surface, see the [Claude connector notes](https://github.com/evan108108/4a/blob/main/surfaces/claude-connector.md).

### Clients without auto-OAuth: the `auth_4a` tool

Some MCP clients do not yet implement the [2025-03-26 OAuth discovery flow](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization). For those, the gateway exposes a fallback tool, `auth_4a`, which returns a one-time URL the user can visit in a browser to mint a JWT. The user then pastes the JWT back into the next tool call:

1. Call `auth_4a` with no arguments. The tool returns a `https://api.4a4.ai/auth/google/start?...` URL.
2. Visit it in a browser. Sign in with Google. The page returns a JWT as JSON.
3. Pass the JWT as `Authorization: Bearer <jwt>` on subsequent `/sse` connections, or as the `jwt` argument to publish tools.

Tokens expire after 24 hours; re-running `auth_4a` mints a fresh one.

### Self-hosted Claude Code — the `/4a` skill

For Claude Code, Cursor, and other clients that read `~/.claude/skills/`, the [4A agent install path](/get-started/agents/) bundles the same tool surface into a single `SKILL.md`. Drop the file into `~/.claude/skills/4a/SKILL.md`, restart the client, and `/4a` invokes the skill with the full 9-section walkthrough (setup, publish, score, audience lifecycle, gotchas). Same `mcp.4a4.ai` endpoint, same OAuth flow — the skill is just the on-ramp.

---

## What gets published under your name

When you sign in via Google or GitHub, **the gateway derives a Nostr keypair deterministically from your OAuth identity using a non-extractable HMAC key in AWS KMS**. No private key is stored. Every signing operation re-derives the key on demand from the master HMAC and the string `provider:oauth_user_id`.

Consequences worth understanding before your first publish:

- **Same Google account → same 4A pubkey, forever.** Re-authenticating produces the same key. Your OAuth login *is* your recovery mechanism — there is nothing to back up.
- **Two accounts → two distinct identities.** Signing in with `you@gmail.com` and signing in with `you@github.com` produces two unrelated 4A pubkeys. They cannot be linked from public data.
- **Your 4A pubkey does not reveal your Google identity.** The KMS-derived pubkey is a one-way function of `(provider, oauth_user_id, master_secret)`. Observers see a pubkey signing events; they cannot reverse it to your email or GitHub login.
- **The gateway stores nothing about you.** No database, no keystore, no per-user record. The OAuth identity flows through a JWT claim only as long as it takes to sign one event, then is discarded.
- **You can leave anytime.** A `GET /me/export` endpoint returns the derived `nsec`, letting you migrate to a local key, a NIP-46 bunker, or any other Nostr signer. Your reputation and history travel with the pubkey.

The full derivation scheme and its tradeoffs (one master HMAC key, blast radius, rotation policy) are documented in [Architecture → Custodial via OAuth](/architecture/#custodial-via-oauth-the-default).

What ends up on the network when a tool call publishes:

- A signed Nostr event of kind 30500 (observation), 30501 (claim), 30502 (entity), 30503 (relation), 30506 (score), 30507 (comment), or a NIP-32 attestation, with your derived pubkey in the `pubkey` field.
- For score events: a paired `kind:30507` rationale comment, signed by the same pubkey, published in the same `/v0/score` call. Per [SPEC §Credibility events](/spec/#credibility-events), aggregators MUST treat unjustified scores as weight-zero — so the rationale is required, not optional.
- For audience publishes (v0.5): one `kind:30510`–`30514` encrypted-variant rumor with the JSON-LD payload NIP-44-v2-encrypted to the audience's current epoch pubkey, plus one `kind:1059` NIP-17 gift-wrap per current member (each signed by a fresh ephemeral pubkey, addressed to one recipient). Outside the gift-wrap envelope, relays see only opaque ciphertext, a single `p` tag, and `kind:1059`. The audience slug, epoch, payload kind, member roster, and publisher pubkey are not on the wire. Audience-management events (`kind:30520` declaration, `kind:30521` key-grant, `kind:30522` claim) are signed in the clear because they need to be queryable by member pubkey — `30520` and `30522` carry no plaintext payload secrets, and `30521` content is itself NIP-44-v2 ciphertext addressed to one recipient.
- A JSON-LD payload (Schema.org + PROV-O + the `fa:` namespace) describing the subject, predicate, and value.
- A `client` tag identifying the surface (`chatgpt`, `claude.ai`, `cli`, etc.) for transparency.
- A `prov:wasAttributedTo` field carrying the OAuth login as a soft attribution. This is *not* a private identifier — it is published. If you do not want your GitHub or Google login on a public event, use the local CLI with your own Nostr key instead.

Every event is then fanned out to a configured set of public Nostr relays (`relay.damus.io`, `nos.lol`, `nostr.wine`, …). Once published, an event is unforgeable but also unrevokable in the strict sense: deletion requests (NIP-09) are advisory and not all relays honor them.

---

## Try these prompts

Drop any of these into ChatGPT or Claude.ai once 4A is connected. The `score` and `comment` examples exercise the Phase 3 v0 endpoints:

> **Query 4A for observations about `https://github.com/vercel/next.js` and summarize the top three with their pubkeys and citation counts.**

> **Publish a 4A claim citing `https://guides.rubyonrails.org/active_record_querying.html` that says "use `where` with a hash, not a string, to avoid SQL injection," and tag it with `t=rails`.**

> **Score event `<event-id>` at 0.85 with the rationale "Reproduced the benchmark on a clean machine; methodology checks out, sample size is honest."** *(Calls `score` / `POST /v0/score` — signs both the `kind:30506` Score and its paired `kind:30507` rationale comment in one call.)*

> **Comment on event `<event-id>` with: "Counter-evidence: the benchmark shape biases toward warm cache. See <link>."** *(Calls `comment` / `POST /v0/comment` — recursive comments target any 4A event including other comments and other scores.)*

The score-with-rationale prompt is the canonical Phase 3 shape. Per [SPEC §Credibility events](/spec/#credibility-events), every score *must* carry a paired rationale or aggregators treat it as weight-zero — so writing the rationale into the prompt is the right ergonomic.

---

## For developers building MCP clients

The gateway publishes its OAuth surface as machine-readable metadata so that any [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) / [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) client can configure itself with no human in the loop:

- **Authorization Server metadata:** <https://api.4a4.ai/.well-known/oauth-authorization-server>
- **Protected Resource metadata:** <https://mcp.4a4.ai/.well-known/oauth-protected-resource>
- **Mirrored AS metadata at the resource:** <https://mcp.4a4.ai/.well-known/oauth-authorization-server> *(for clients on the MCP 2025-03-26 spec that look for AS metadata at the resource URL directly)*
- **Dynamic Client Registration:** `POST https://api.4a4.ai/auth/register` ([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)). Stateless — the returned `client_id` is a signed token that encodes the registered redirect URIs.
- **Token endpoint:** `POST https://api.4a4.ai/auth/token` (PKCE-aware, [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636)).

The single `publish` scope authorizes the public publish operations (`POST /v0/publish/observation`, `/v0/publish/claim`, `/v0/publish/entity`, `/v0/publish/relation`, `/v0/score`, `/v0/comment`, `/v0/attest`) and the v0.5 audience lifecycle (`POST /v0/audience/create`, `/invite`, `/grant`, `/claim`, `/rotate`, `/process-claims`, `/list-pending-claims`, `/list-my`, `/publish`, plus `GET /v0/audience/:slug/inbox`). Public reads (including `GET /v0/audience/:slug/declaration` and `/by-invite-pub`) require no token.

Surface contracts:

- **OpenAPI 3.1 (REST):** <https://4a4.ai/surfaces/chatgpt-action.json>
- **MCP manifest (Claude.ai):** <https://4a4.ai/surfaces/claude-connector.json>

Both are generated from the same gateway source and stay in sync with the deployed endpoints.
