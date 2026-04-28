# 4A Claude Connector — Distribution Plan

**Status:** v2, refreshed 2026-04-28 for Phase 3 v0 capability
**Goal:** Get the 4A connector (`https://mcp.4a4.ai/sse`) discovered and used by Claude.ai users at scale, beyond the "user pastes a URL into Settings → Connectors" path.

The technical surface is ready: the gateway is OAuth 2.1 / RFC 7591 / RFC 8414 / RFC 9728 compliant; Claude.ai's connector framework auto-DCRs against it with all advanced fields blank. The MCP server now exposes **12 tools** spanning all 7 reserved kinds (30500–30504, 30506, 30507) — read tools (`query_4a`, `get_4a_object`, `list_commons`, `get_credibility`), the auth helper (`auth_4a`), and the seven write tools (`publish_observation`, `publish_claim`, `publish_entity`, `publish_relation`, `score`, `comment`, `attest`). What's missing is **awareness and discoverability** — Claude.ai users need to see "4A" surface in a directory, a search, or a curated list before they will paste a URL.

## What this connector does

4A is a convention on Nostr for AI-mediated public knowledge exchange. Every record is a Nostr-signed JSON-LD event with an identifiable pubkey: observations about software projects, claims about organizations, entity descriptions, typed relations, scores about other publishers' work, and recursive comments that reply to or rebut any 4A object. The connector exposes the full read surface (no auth) and the full write surface (Google or GitHub OAuth, custodial keys derived in AWS KMS — nothing stored).

Phase 3 v0 (live 2026-04-28) adds the credibility primitives. The **`score`** tool is paired-publish: it signs a `kind:30506` Score and an explanatory `kind:30507` Comment together with cross-references in both directions, so aggregators can enforce the paired-rationale convention. The **`comment`** tool is the standalone variant — anyone can comment on any 4A object, including someone else's score or comment, recursively. Aggregators on this format treat unjustified scores as weight-zero by convention; rationale is part of writing a score, not optional.

This plan is structured as: (1) channels and what each requires, (2) test-flow validation status, (3) recommended order of operations, (4) materials we need to assemble, (5) an actual draft PR for the lowest-friction first move.

---

## 1. Distribution Channels

### 1a. Anthropic — Official Connectors Directory (Tier 1)

The bullseye. The Connectors Directory is the in-product list at `claude.ai/settings/connectors` that ships ~50+ curated integrations as of Feb 2026. Listing here is what "scale distribution" actually means.

- **Submission form (Remote MCP / MCP Apps):** <https://clau.de/mcp-directory-submission>
- **Submission form (Desktop extensions, MCPB):** <https://clau.de/desktop-extention-submission>
- **Documentation:** <https://claude.com/docs/connectors/building/submission>
- **FAQ:** <https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq>
- **Public partner page:** <https://www.anthropic.com/partners/mcp>
- **Accessibility / escalation contact:** `mcp-review@anthropic.com`
- **Cost / partner program:** None advertised. The form is open to anyone; Anthropic reviews for security, quality, compatibility before listing. No "expedited track."
- **Review SLA:** Variable, not published. Queue-dependent.

**What they require (per the docs):**

| Field | We have it? |
|---|---|
| Server name, URL, tagline, description, use cases | ✅ — see [`/connectors.md`](../connectors.md), [`/surfaces/claude-connector.md`](../surfaces/claude-connector.md) |
| Auth type, transport protocol, read/write capabilities | ✅ — OAuth 2.1 + DCR, SSE transport, read-only public + authenticated publish |
| Tool annotations (`title`, `readOnlyHint` / `destructiveHint`) | ⚠️ — needs verification in `gateway/src/mcp.ts` for all 12 tools (Phase 3 added `score` + `comment`) |
| OAuth 2.0 + HTTPS + Origin-header validation | ✅ — confirmed during ChatGPT/Claude.ai integration testing |
| Privacy policy URL (HTTPS) | ⚠️ — currently `https://4a4.ai/` doubles as policy. A real `/privacy` page would help review |
| Documentation link (public by publish date) | ✅ — README + connectors.md + surfaces/* |
| Test account with setup instructions | ⚠️ — we should provide a clean `mcp-review@anthropic.com`-friendly walkthrough; the Google OAuth flow is in production but reviewers will want a 1-minute happy path |
| Server logo (URL or SVG) | ❌ — no logo asset exists |
| Favicon | ❌ — `4a4.ai` favicon TBD |
| MCP App promotional screenshots (3–5 PNG, ≥1000px wide, app response only) | ❌ — not produced yet |
| Data handling, third-party connections, health data, category | ✅ derivable — public read API, custodial publish via Google/GitHub OAuth, no PII storage, category = "Knowledge & Memory" or "Developer Tools" |

**Risk:** No baseline of paid users actively requesting 4A means review may be deferred or rejected for "not enough demand." We should accumulate signal (HN post, awesome-mcp listing, Phase 2 launch tweet thread) **before** submitting here.

### 1b. Official MCP Registry (Tier 1, low-friction)

Anthropic-led but project-governed. The official central index. ~500 servers as of late 2025, growing.

- **Registry:** <https://registry.modelcontextprotocol.io/>
- **Quickstart docs:** <https://modelcontextprotocol.io/registry/quickstart>
- **CLI:** `mcp-publisher` (Homebrew or GitHub release binary)
- **Authentication:** GitHub-based (server name must start with `io.github.evan108108/`); DNS auth available for custom domains (could use `4a4.ai/`)
- **Submission:** Edit `server.json` → `mcp-publisher publish`. No human review for the registry itself; downstream consumers (PulseMCP, Glama, etc.) auto-pick up registered servers.

**What we need:**
- A `server.json` at the gateway root, e.g. `https://4a4.ai/.well-known/mcp/server.json` or in the GitHub repo at `4a/server.json`
- Either: (a) publish an npm package wrapping the remote URL (the registry was originally built around package metadata), or (b) use the registry's `remote` server type — see `modelcontextprotocol.io/registry/quickstart` → "support for remote servers" link
- Optional: DNS auth via TXT record on `4a4.ai` so we can register under `ai.4a4/` rather than `io.github.evan108108/`

**Effort:** ~1 hour. **Yield:** Indexed by everyone downstream that mirrors the official registry.

### 1c. Community curated lists (Tier 2, ship-this-week)

These are GitHub-flavored awesome-lists that show up in every "how do I find MCP servers?" search. Submission is a PR.

| List | Stars | Format | Submission | 4A category | URL |
|---|---|---|---|---|---|
| **punkpeye/awesome-mcp-servers** | 85.7k | README bullet list with emoji legend | PR appended in alphabetical order to category | `🧠 Knowledge & Memory` | <https://github.com/punkpeye/awesome-mcp-servers> |
| **jaw9c/awesome-remote-mcp-servers** | (smaller, more curated) | Markdown table — `\| Name \| Category \| URL \| Auth \| Maintainer \|` | PR adding row | Knowledge / Knowledge Graph | <https://github.com/jaw9c/awesome-remote-mcp-servers> |
| **appcypher/awesome-mcp-servers** | mid | Similar to punkpeye | PR | Knowledge & Memory | <https://github.com/appcypher/awesome-mcp-servers> |
| **wong2/awesome-mcp-servers** | mid | Similar | PR | Knowledge & Memory | <https://github.com/wong2/awesome-mcp-servers> |
| **modelcontextprotocol/servers** | official | Reference + community section | PR to "community" section | (project list) | <https://github.com/modelcontextprotocol/servers> |

**Best first move:** `jaw9c/awesome-remote-mcp-servers` — it is *specifically* about remote servers (which is what 4A is), the table format is precise (no fuzzy "is this entry good enough" review), and the maintainer publishes a newsletter that includes new additions, so we get bonus reach for free. Draft PR included below.

`punkpeye/awesome-mcp-servers` is high-traffic but the Knowledge & Memory category has ~100+ entries already, so signal-to-noise is mediocre — still worth doing as a parallel PR.

### 1d. Hosted MCP marketplaces (Tier 2)

These are not GitHub lists; they are SaaS directories with web UIs and search. Some have one-click install for compatible clients (Cline, Claude Desktop).

| Directory | Submission method | Notes |
|---|---|---|
| **Glama (`glama.ai/mcp/servers`)** | Auto-indexes from `punkpeye/awesome-mcp-servers` PR + GitHub | We get this for free once the awesome-mcp PR lands |
| **mcp.so** | GitHub issue with name/description/connection details | <https://mcp.so/> → Submit button |
| **mcpmarket.com** | Form on site | One-click install for Cline |
| **LobeHub MCP marketplace** | Submit modal at <https://lobehub.com/mcp>; quality checklist (README, install methods, ≥1 tool, license, friendly install) | We pass all 5 boxes |
| **PulseMCP** | <https://www.pulsemcp.com/submit> (form) | Auto-pulls from MCP registry → bonus from Tier 1b |
| **Cline MCP Marketplace** | PR to <https://github.com/cline/mcp-marketplace> | Cline-specific install integration |
| **Smithery (`smithery.ai`)** | `smithery mcp publish` CLI or web dashboard | One of the older directories; non-trivial install path for our remote-only server |

**Multi-submission shortcut:** The community tool **`mcp-submit`** automates submission to 10+ directories in one command. Worth running once the awesome-mcp PR is merged so we have a canonical entry to point at.

### 1e. Anthropic dev rel & community channels (Tier 3, slow-burn)

These are the conversational paths — not formal applications, but where awareness gets earned.

- **MCP GitHub Discussions:** <https://github.com/orgs/modelcontextprotocol/discussions> — show-and-tell category for project announcements
- **r/mcp subreddit:** <https://www.reddit.com/r/mcp> — post launch announcement with screenshots
- **MCP Discord:** linked from the awesome-list (Glama's): <https://glama.ai/mcp/discord> — `#showcase` channel
- **Anthropic Twitter/X:** Tag `@AnthropicAI` and the MCP team on the launch tweet. The X draft already in memory (`4A Phase 2 launch draft — X / Twitter post`) covers this.
- **Hacker News Show HN:** Already drafted in memory as "4A Phase 2 launch draft — Hacker News Show HN post." Time it for a Tuesday/Wednesday morning ET.
- **Anthropic partnerships email:** No public alias is published, but `mcp-review@anthropic.com` is the documented review contact and reads as the closest thing.

---

## 2. Validation: does the connector flow actually work for someone other than Evan?

**Status (2026-04-28):** Google OAuth verification confirmed in production via Evan's private-window test on the ChatGPT GPT — clean consent screen, no unverified-app warning. The Claude.ai-side fresh-account walkthrough is still **NOT INDEPENDENTLY VERIFIED**; the task remaining is to repeat the test through the Claude.ai connector path with at least one trusted non-test-user account.

### What we know works
- Claude.ai's "Add custom connector" UI accepts `https://mcp.4a4.ai/sse` with all advanced fields blank.
- DCR via RFC 7591 happens silently against `https://api.4a4.ai/auth/register`.
- The MCP discovery flow surfaces tools (12 of them as of Phase 3 v0).
- Read tools work without auth.
- Publish tools redirect to Google OAuth (or GitHub) — and Google OAuth is verified in production as of 2026-04-28.

### What I (Sonata, as a worker process) cannot do
This worker is running in a non-interactive Claude Code session. I do **not** have:
- A real browser session capable of completing Google OAuth's bot detection.
- Credentials for `sona@agentmail.to` as a Google account (that address is an AgentMail inbox, not a Google account).
- The ability to validate the "fresh, never-used-4A Google account" path that the task asks for.

### What Evan needs to do (recommended test protocol)

The point of this test is to confirm Google OAuth's **production verification status** is real — i.e., the consent screen does *not* show the "unverified app" warning to a user who is not on the Google Cloud test-users allowlist. This is the same gating issue that delayed the ChatGPT GPT publish path.

1. Open Claude.ai in a private window signed into a fresh Google identity that has never been used with 4A and is **not** in the GCP test-users list. (Anything from a personal Gmail Evan hasn't tested with — or a colleague's account.)
2. Settings → Connectors → Add custom connector → name `4A`, URL `https://mcp.4a4.ai/sse`, all advanced blank → Add.
3. Open a new chat → enable the 4A connector → ask "List the Commons declarations on 4A." Read tools should answer immediately, no auth challenge.
4. Ask "Publish an observation about https://github.com/vercel/next.js: property `commonPitfall`, value `getStaticProps caches forever in some edge cases`." This forces the publish path. Claude will surface a Google sign-in popup.
5. **Check the consent screen carefully.** A verified app shows the 4A app name, the requested scopes, and a normal "Continue" button. An unverified app shows a yellow "Google hasn't verified this app" warning and an "Advanced → Go to … (unsafe)" hidden link. If we see the warning, the GPT-distribution-blocker is *not* fixed; if we don't, we're shipped.
6. Approve, return to Claude, confirm the publish succeeds with a Nostr event ID and a derived pubkey.
7. Open `https://nostr.band/?q=<derived-pubkey>` to confirm the event lands on relays.

If that walkthrough succeeds for a fresh account, the technical bar for distribution is met and we can move on. If the consent screen warns, the Google Cloud OAuth verification needs to finish before any Anthropic submission — Anthropic reviewers will hit the same warning.

---

## 3. Recommended order of operations

**This week (low friction, build signal):**

1. **Submit to `jaw9c/awesome-remote-mcp-servers`.** Patch drafted at [`awesome-mcp.patch`](./awesome-mcp.patch). Best first move — clean format, focused list, newsletter reach.
2. **Submit to `punkpeye/awesome-mcp-servers`.** Largest list. Auto-feeds Glama. Same PR template, different format (bullet list, not table).
3. **Run validation walkthrough** (Section 2) to confirm fresh-account OAuth works.
4. **Publish to the official MCP Registry** (`mcp-publisher publish`). Auto-feeds PulseMCP and other downstream indexers.

**Next week (after signal accumulates):**

5. **Hacker News Show HN post** using draft in memory. Time for Tuesday 8–10am ET. Pull traffic to `4a4.ai`.
6. **r/mcp post** with screenshots from Claude.ai showing tool calls. Cross-link to GitHub.
7. **MCP Discord `#showcase` post.** Same content, smaller audience but high-quality.
8. **Run `mcp-submit` to fan out** to the rest of the directories.

**Following week (after reviewable signal exists):**

9. **Produce assets:** SVG logo (4A wordmark on the existing site palette), favicon, 3–5 PNG screenshots (1000px wide, response-only) of Claude.ai using the connector. Without these, the Anthropic submission will be deferred.
10. **Submit to Anthropic Connectors Directory** (`https://clau.de/mcp-directory-submission`) with screenshots, logo, privacy policy page, and a documentation link to the new `4a4.ai/connectors` page (built from `connectors.md`). This is the slowest, highest-yield channel — submit it last so the application carries existing signal.
11. **Email `mcp-review@anthropic.com`** if no acknowledgment in 7 days.

---

## 4. Materials checklist

What we need to assemble before the Anthropic submission. Most are at-or-near ready; the gaps are visual assets.

| Asset | Status | Owner |
|---|---|---|
| Server description (1-paragraph, 1-sentence tagline) | ✅ — connectors.md provides both | — |
| Use-case list | ✅ — surfaces/claude-connector.md sections | — |
| Tool list with `title` + `readOnlyHint`/`destructiveHint` annotations | ⚠️ verify in `gateway/src/mcp.ts` | Evan / dev pass |
| Privacy policy page (separate URL, not landing page) | ❌ → need `/privacy` route on `4a4.ai` | Evan / quick page |
| Documentation hub | ✅ — README + connectors.md + surfaces/* | — |
| Test account / sandbox path | ⚠️ — write a 5-step "what to test" snippet for reviewers | Evan |
| SVG logo | ❌ | Evan or designer |
| Favicon | ❌ | Evan |
| 3–5 PNG screenshots (≥1000px, app response only) | ❌ — capture from a Claude.ai session running 4A | Evan with browser |
| Promotional copy / blog post | ⚠️ — HN draft exists; needs trimming for Anthropic submission | Sonata can draft |
| Server logo URL | ❌ — depends on logo above | — |

**Gap to ship:** logo, favicon, screenshots, privacy page, tool annotations. Roughly half a day of work.

---

## 5. Draft PR — `jaw9c/awesome-remote-mcp-servers`

The lowest-friction first move. The repo's table is alphabetical by Name, so 4A lands near the top.

**PR title:** `Add 4A — agent-readable Nostr knowledge archive`

**PR body:**

```markdown
## Server

- **Name:** 4A (Agent-Agnostic Accessible Archive)
- **URL:** `https://mcp.4a4.ai/sse`
- **Category:** Knowledge / Knowledge Graph
- **Authentication:** OAuth 2.1 (with Dynamic Client Registration, RFC 7591) — read tools work unauthenticated; publish tools authorize via Google or GitHub OAuth
- **Maintainer:** [4A](https://4a4.ai)

## What it does

4A is a convention on Nostr for AI-mediated public knowledge exchange. Every record is a Nostr-signed JSON-LD event with an identifiable pubkey: observations about software projects, claims about organizations, entity descriptions, typed relations, scores about other publishers' work, and recursive comments that reply to or rebut any 4A object.

Phase 3 v0 (live 2026-04-28) adds two credibility primitives — `kind:30506` Score and `kind:30507` Comment — and a paired-rationale convention: the `score` tool signs a Score and a justifying Comment together with cross-references in both directions. Aggregators on this format treat unjustified scores as weight-zero by convention.

The MCP gateway exposes **12 tools** covering reads (`query_4a`, `get_4a_object`, `list_commons`, `get_credibility`), the auth helper (`auth_4a`), and authenticated writes (`publish_observation`, `publish_claim`, `publish_entity`, `publish_relation`, `score`, `comment`, `attest`).

The gateway is a thin Cloudflare Worker; identity is custodial via deterministic HMAC derivation in AWS KMS — the same Google or GitHub login produces the same Nostr keypair across ChatGPT, Claude.ai, and any other client, with no per-user keys stored anywhere.

## Compliance with quality criteria

- **Production-ready:** Deployed on Cloudflare Workers + Durable Objects; uptime mirrors Cloudflare's edge. Phase 3 v0 capability is live on production as of 2026-04-28.
- **Active maintenance:** Source at https://github.com/evan108108/4a, ongoing development. Most recent capability addition: paired Score + Comment publishing (kinds 30506, 30507) on 2026-04-28.
- **OAuth 2.0:** Full RFC 8414 / RFC 9728 / RFC 7591 / RFC 7636 (PKCE) implementation. Dynamic client registration is supported, so MCP clients self-configure with no manual API key handoff.
- **Documentation:** https://4a4.ai/connectors, https://4a4.ai/docs/phase-3-credibility-runbook/, https://github.com/evan108108/4a

## Specification & docs

- Convention spec: https://github.com/evan108108/4a/blob/main/SPEC.md
- Connector setup (Claude / ChatGPT): https://4a4.ai/connectors
- OpenAPI 3.1 surface: https://4a4.ai/surfaces/chatgpt-action.json
- MCP surface notes: https://github.com/evan108108/4a/blob/main/surfaces/claude-connector.md
```

**Patch file:** `/Users/evan/projects/4a/distribution/awesome-mcp.patch` — applies directly to a fresh fork of `jaw9c/awesome-remote-mcp-servers`. To use:

```bash
git clone https://github.com/<your-fork>/awesome-remote-mcp-servers.git
cd awesome-remote-mcp-servers
git apply /Users/evan/projects/4a/distribution/awesome-mcp.patch
git commit -am "Add 4A — agent-readable Nostr knowledge archive"
git push
gh pr create --title "Add 4A — agent-readable Nostr knowledge archive" --body-file /Users/evan/projects/4a/distribution/pr-body.md
```

Per the task instructions, **the patch is drafted but not pushed.** Awaiting Evan's review of the wording, the category placement, and the PR body before opening the PR.

---

## Appendix: contact paths

- **Anthropic MCP review queue:** `mcp-review@anthropic.com`
- **Anthropic partner page:** <https://www.anthropic.com/partners/mcp>
- **MCP project Discussions (best for "we built X" announcements):** <https://github.com/orgs/modelcontextprotocol/discussions>
- **r/mcp:** <https://www.reddit.com/r/mcp>
- **MCP Discord (Glama-hosted):** <https://glama.ai/mcp/discord>
- **Awesome list maintainers (`jaw9c`, `punkpeye`, `appcypher`, `wong2`):** GitHub PRs are the channel; direct outreach is unnecessary and unwelcome.
