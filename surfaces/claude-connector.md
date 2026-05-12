# 4A as a Claude.ai Connector

This directory contains [`claude-connector.json`](./claude-connector.json) — a manifest documenting the 4A connector for Claude.ai. Claude.ai's Remote MCP feature lets paid users (Pro, Max, Team, Enterprise; Free is limited to one custom connector) attach any HTTPS MCP server with a single URL paste, no manifest upload required.

## What this connector does

Adds the full 4A tool surface to Claude.ai: public reads, public-mode writes, the Phase 3 credibility primitives, and the v0.5 audience lifecycle (private audiences with NIP-44 group encryption, key-grants, encrypted-variant kinds 30510–30514, and a `4a://invite/...` claim flow). With it installed, Claude can answer "what does 4A know about X?" by retrieving real signed events with provenance, post observations / claims / entities / relations / scores / comments / attestations on the user's behalf, and drive a private 4A audience end-to-end without leaving the chat.

The MCP surface:

**Public reads** (no auth):

- **`query_4a`** — search by subject, kind, topic, or author.
- **`get_4a_object`** — fetch one addressable object by `(kind, pubkey, d)`.
- **`get_credibility`** — look up NIP-85 trusted-assertion scores for a publisher.
- **`list_commons`** — list every Commons declaration the gateway has indexed.

**Session auth helper:**

- **`auth_4a`** — attach a 4A bearer JWT to the session if the client cannot pass an `Authorization` header on the `/sse` handshake.

**Public-mode writes** (require an authenticated session):

- **`publish_observation` / `publish_claim` / `publish_entity` / `publish_relation`** — the four public knowledge-object kinds.
- **`score` / `comment`** — Phase 3 credibility events. `score` signs a `kind:30506` Score and a paired `kind:30507` rationale Comment atomically.
- **`attest`** — NIP-32 labels under the `4a.*` namespace (credibility stamps, sponsor declarations).

**v0.5 audience lifecycle** (require an authenticated session, see below):

- **`audience_create`** — create a private audience; the gateway publishes the kind:30520 declaration and issues a founding kind:30521.
- **`audience_invite`** — mint a one-shot bech32 invite key, republish the declaration with a new `fa:pending` entry, and return the `4a://invite/...` URL plus its `https://claim.4a4.ai/...` twin.
- **`audience_claim`** — sign and publish a kind:30522 claim with an invite priv (used by the claim page after OAuth).
- **`audience_grant`** — direct kind:30521 grant to a known recipient (no claim flow).
- **`audience_rotate`** — bump the epoch, regenerate keys, republish the declaration, fan out new grants.
- **`audience_process_claims`** — scan pending invites for matching kind:30522 events and rotate to admit them.
- **`audience_list_pending_claims`** — preview pending claims without rotating.
- **`audience_list_my`** — list audiences the calling user is a member of.
- **`audience_publish`** — polymorphic across kinds 30510–30514. NIP-44-encrypts a payload to the audience epoch pubkey, builds the encrypted-variant rumor, NIP-17 gift-wraps it once per current member. One tool replaces four near-identical ones.
- **`audience_inbox`** — capability-based decryption pipeline: unwrap cached gift-wraps, look up the matching kind:30521 grant, decrypt the rumor, return parsed JSON-LD.

## Install (Claude.ai, ~30 seconds)

1. Open Claude.ai → **Settings** → **Connectors** (or use the prefilled deep link: <https://claude.ai/settings/connectors?modal=add-custom-connector>).
2. Click **Add custom connector**.
3. **Name:** `4A`
4. **Remote MCP server URL:**

   ```
   https://mcp.4a4.ai/sse
   ```

5. Leave **Advanced settings** alone. Claude.ai's connector framework auto-DCRs against the gateway via [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591); reads work immediately and writes / audience tools prompt for Google sign-in on first use.
6. Click **Add**. Claude will connect to the gateway, list the full MCP tool surface (public reads + writes + Phase 3 score/comment + the v0.5 audience lifecycle), and surface them in any new chat under the connector menu.

If you are on a Team or Enterprise plan, an Owner adds the connector once; members then enable it from their own Connectors panel.

## Try it

Once installed, start a new chat and ask:

- "What does 4A know about the Nostr protocol?"
- "List the Commons declarations on 4A so I can see what topical archives exist."
- "Look up credibility scores for `npub1…` and tell me whether to trust their claims."
- "Fetch the 4A entity at `30502:<pubkey>:4a-protocol`."
- *(write)* "Publish a 4A observation about https://github.com/vercel/next.js: property `commonPitfall`, value `…`." — exercises `publish_observation`, prompts for Google sign-in on first use.
- *(score+rationale)* "Score 4A event `<id>` at 0.85 with the rationale `…`." — exercises `score`, signs both the Score and its paired rationale Comment atomically.
- *(v0.5 audience)* "Create a 4A audience `team-design`, then mint an invite URL for Allison." — exercises `audience_create` + `audience_invite`.
- *(v0.5 audience)* "Show me which 4A audiences I'm in, then read my inbox for `team-design`." — exercises `audience_list_my` + `audience_inbox`.
- *(v0.5 audience)* "Publish an encrypted observation about `<subject>` into `team-design`." — exercises `audience_publish` with `kind=30510`.

Claude will pick the right tool, call the gateway, and cite the publisher pubkey for every fact it surfaces.

## Privacy

- **Reads are anonymous.** The 4A public read API requires no auth. Anyone — Claude included — can query it anonymously.
- **Writes are OAuth-gated.** Publish tools and the v0.5 audience lifecycle require a JWT issued after Google or GitHub sign-in. The gateway derives the user's Nostr keypair deterministically from the OAuth identity using a non-extractable HMAC key in AWS KMS — **no private key is stored**, and every signing operation re-derives the key in a per-request window. See [Architecture → Custodial via OAuth](../ARCHITECTURE.md#custodial-via-oauth-the-default).
- **Audience publishes ride NIP-17 gift-wraps.** Encrypted-variant rumors (kinds 30510–30514) are NIP-44-v2-encrypted to the audience epoch pubkey, then NIP-17 gift-wrapped once per current member. Relays see opaque ciphertext, a single `p` tag, and `kind:1059` — not the audience slug, epoch, roster, or publisher pubkey. The audience identity priv and current epoch priv are returned to the caller on `audience_create` and are NOT persisted by the gateway.
- **No personal data leaves your account.** Claude sends only the query parameters you implicitly authorize when you accept a tool call (e.g. the audience slug or invite URL). The connector receives no chat history, no user identity beyond the JWT claim flow, no cookies.
- **What the gateway sees.** Standard request metadata: source IP (Anthropic's egress range), the request parameters, a timestamp, and (for publish tools) the OAuth-derived pubkey carrying the JWT. The gateway does not log content beyond standard Cloudflare access logs (retained per Cloudflare's defaults).
- **What Anthropic sees.** The connector's name and URL. Custom connectors are not verified by Anthropic; you are trusting the source you pasted.
- **Permanence.** Every publish — public or audience-encrypted — is effectively permanent on Nostr. Deletion requests (NIP-09) are advisory and not all relays honor them. Audience encrypted-variants remain decryptable to any past or future holder of the matching epoch private key; rotation does not retroactively re-encrypt history.

## Notes for editors

- Keep `mcpServerUrl` in sync with the deployed `mcp.` route in `gateway/wrangler.toml`.
- Keep the tool list in `claude-connector.json` aligned with `TOOLS` in `gateway/src/mcp.ts`. If you add a tool there, mirror it here so the directory listing stays accurate. As of v0.5 (2026-04-28) the source-of-truth includes the ten `audience_*` tools.
- Claude.ai has not yet published a public manifest schema; the field names in `claude-connector.json` track what Anthropic has been collecting from third-party connectors as of April 2026. Revisit when the directory submission flow is documented.
