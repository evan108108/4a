# 4A as a Claude.ai Connector

This directory contains [`claude-connector.json`](./claude-connector.json) — a manifest documenting the 4A connector for Claude.ai. Claude.ai's Remote MCP feature lets paid users (Pro, Max, Team, Enterprise; Free is limited to one custom connector) attach any HTTPS MCP server with a single URL paste, no manifest upload required.

## What this connector does

Adds four read-only tools to Claude.ai that query the 4A network — a public archive of Nostr-signed JSON-LD knowledge objects. With it installed, Claude can answer "what does 4A know about X?" by retrieving real signed events with provenance, instead of guessing.

The four tools:

- **`query_4a`** — search by subject, kind (`observation` / `claim` / `entity` / `relation` / `commons`), topic, or author.
- **`get_4a_object`** — fetch one addressable object by `(kind, pubkey, d)`.
- **`get_credibility`** — look up NIP-85 trusted-assertion scores for a publisher.
- **`list_commons`** — list every Commons declaration the gateway has indexed.

All four are read-only. No write tools, no auth.

## Install (Claude.ai, ~30 seconds)

1. Open Claude.ai → **Settings** → **Connectors** (or use the prefilled deep link: <https://claude.ai/settings/connectors?modal=add-custom-connector>).
2. Click **Add custom connector**.
3. **Name:** `4A`
4. **Remote MCP server URL:**

   ```
   https://mcp.4a4.ai/sse
   ```

5. Leave **Advanced settings** alone — 4A's v0 read API is public, no OAuth needed.
6. Click **Add**. Claude will connect to the gateway, list the four tools, and surface them in any new chat under the connector menu.

If you are on a Team or Enterprise plan, an Owner adds the connector once; members then enable it from their own Connectors panel.

## Try it

Once installed, start a new chat and ask:

- "What does 4A know about the Nostr protocol?"
- "List the Commons declarations on 4A so I can see what topical archives exist."
- "Look up credibility scores for `npub1…` and tell me whether to trust their claims."
- "Fetch the 4A entity at `30502:<pubkey>:4a-protocol`."

Claude will pick the right tool, call the gateway, and cite the publisher pubkey for every fact it surfaces.

## Privacy

- **No authentication.** The v0 4A read API is public. Anyone — Claude included — can query it anonymously.
- **No personal data leaves your account.** Claude sends only the query parameters you implicitly authorize when you accept a tool call (e.g. the topic name or pubkey it looked up). The connector receives no chat history, no user identity, no cookies.
- **What the gateway sees.** Standard request metadata: source IP (Anthropic's egress range), the query parameters, and a timestamp. The gateway does not log query content beyond standard Cloudflare access logs (retained per Cloudflare's defaults).
- **What Anthropic sees.** The connector's name and URL. Custom connectors are not verified by Anthropic; you are trusting the source you pasted.
- **No writes.** This connector is read-only. Claude cannot publish to 4A through it. (Publishing requires the local CLI and a Nostr key — see the project README.)

## Notes for editors

- Keep `mcpServerUrl` in sync with the deployed `mcp.` route in `gateway/wrangler.toml`.
- Keep the tool list in `claude-connector.json` aligned with `TOOLS` in `gateway/src/mcp.ts`. If you add a tool there, mirror it here so the directory listing stays accurate.
- Claude.ai has not yet published a public manifest schema; the field names in `claude-connector.json` track what Anthropic has been collecting from third-party connectors as of April 2026. Revisit when the directory submission flow is documented.
