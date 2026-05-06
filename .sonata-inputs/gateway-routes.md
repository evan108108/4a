# Gateway routes

The HTTP surface of `4a4.ai` and its subdomains, as wired in `gateway/src/router.ts`. This file is for an agent that needs to call, debug, or extend the gateway. When the router changes, update this file.

> **Pointer:** `../gateway/src/router.ts` is the source of truth. Per-handler logic lives in `gateway/src/{api,publish,score,comment,audience,auth,mcp,well-known}.ts`.

## Hosts

| Host | Role |
|---|---|
| `4a4.ai` | Apex. Static site (built from repo markdown by `scripts/build-site.mjs`) plus a few worker-served paths. |
| `api.4a4.ai` | Public read API and authenticated write endpoints. |
| `mcp.4a4.ai` | MCP/SSE adapter — exposes the API as MCP tools to Claude.ai and other MCP clients. |
| `claim.4a4.ai` | Static Cloudflare Pages site for the v0.5 claim flow. Convention only — not a privileged authority. See `claim-flow.md`. |

## Apex (`4a4.ai`)

| Method | Path | Behavior |
|---|---|---|
| GET | `/ns/v0` | JSON-LD context document. Immutable. `Cache-Control: public, max-age=86400, immutable`. |
| HEAD | `/ns/v0` | Headers-only variant. |
| OPTIONS | `/ns/v0` | CORS preflight. |
| GET | `/.well-known/nostr.json` | NIP-05 directory + v0.5 `fa` extension. Resolves handles to 4A pubkeys and surfaces audience hints. |
| GET | (anything else) | Static site from `gateway/dist/site/` via `env.ASSETS`. |

## API (`api.4a4.ai`)

### Auth

| Method | Path | Behavior |
|---|---|---|
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 metadata. |
| GET | `/.well-known/oauth-protected-resource` | (Served from `mcp.4a4.ai`, listed here for completeness — RFC 9728.) |
| `*` | `/auth/*` | Dynamic Client Registration (RFC 7591), authorization endpoint, token endpoint (PKCE-aware, RFC 7636), GitHub OAuth round trip. The single `publish` scope authorizes all writes. Reads are public. |

### Public reads (no auth)

Handled by `handleApiRequest` in `gateway/src/api.ts`. Filter parameters: `kind`, `author`, `about`, `topic`, `limit`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/v0/query` | Query relays for 4A events matching the filter. Returns the event array. |
| GET | `/v0/object/:id` | Fetch a single event by id. |
| GET | `/v0/object/:kind:pubkey:d` | Fetch by addressable triple. |
| GET | `/v0/credibility/:pubkey` | Surface NIP-85 trusted assertions for a pubkey (nostr.band, Vertex). 4A-native rollup is deferred. |
| GET | `/v0/commons` | List `kind:30504` Commons declarations. |
| GET | `/v0/health` | Liveness probe. |
| GET | `/me/export` | Return the user's derived `nsec` so they can migrate to a NIP-46 bunker or local signer. Requires auth. |

### Writes (Bearer JWT, scope `publish`)

| Method | Path | Behavior |
|---|---|---|
| POST | `/v0/publish/observation` | Sign and publish a `kind:30500` Observation. Auto d-slug rule: `slug(about)/slug(property)` unless `dSlug` provided. |
| POST | `/v0/publish/claim` | `kind:30501`. Auto d-slug: `slug(about)/slug(appearance[:64])`. |
| POST | `/v0/publish/entity` | `kind:30502`. Auto d-slug: `slug(canonicalId)`. |
| POST | `/v0/publish/relation` | `kind:30503`. Auto d-slug: `slug(subject)-slug(roleName)-slug(object)`. |
| POST | `/v0/attest` | Publish a `kind:30505`-shaped attestation. |
| POST | `/v0/score` | **Paired-publish**. Signs both a `kind:30506` Score and its paired `kind:30507` rationale Comment in one call. Score `d`-tag is `target_event_id`; rationale `d`-tag is `justify-<first-8-of-score-id>` and its `e`-tag references the score event id. Enforces the SPEC paired-rationale rule. |
| POST | `/v0/comment` | Standalone or recursive `kind:30507` Comment. `d` tag is `comment-<random-8hex>` per call. NIP-10 `root`/`reply` markers used when `reply_to_event_id` is present. |
| POST | `/v0/audience/invite` | Mint an invite. Returns `{ four_a_url, https_url, invite_pub, expires_at }`. |
| POST | `/v0/audience/grant` | Issue a `kind:30521` key-grant directly to a known recipient (handle or npub path). |
| POST | `/v0/audience/claim` | Process a `kind:30522` audience claim and issue the matching key-grant. |
| GET | `/v0/audience/inbox` | Read decrypted audience messages. Supports `since`, `limit`. |
| GET | `/v0/audience/:slug/health` | Per-audience liveness. |

## MCP (`mcp.4a4.ai`)

| Method | Path | Behavior |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource` | RFC 9728 metadata. |
| GET | `/sse` | MCP/SSE session establishment. Singleton Durable Object (`McpHub`, id `main`). |
| POST | `/messages?sessionId=...` | MCP request channel. |

The MCP adapter exposes twelve tools — five public reads (`queryEvents`, `getObject`, `listCommons`, `getCredibility`, `getHealth`) and seven authenticated writes (`publishObservation`, `publishClaim`, `publishEntity`, `publishRelation`, `publishScore`, `publishComment`, `attest`). The wires terminate at the same handlers as the HTTP API.

## Cron

The worker registers a 5-minute cron in `wrangler.toml`. On fire, it calls `RelayPool.sweepFromRelays()` to (1) reopen any dropped subscriptions and (2) replay the last 15 minutes of events from each relay. This is the backstop for silent WebSocket death.

## Backing infrastructure

- `RELAY_POOL` Durable Object (`relay-pool.ts`) — long-lived WebSocket connections to the configured relay set. Singleton, id `main`.
- `MCP_HUB` Durable Object (`mcp.ts`) — MCP/SSE session coordinator. Singleton, id `main`.
- `ASSETS` static-asset binding — serves the apex site.
- `KMS_DERIVATION_KEY_ID` — AWS KMS key used by `kms.ts` to derive per-pubkey identity keys via HMAC. Aggregator pubkey uses the same KMS HMAC with prefix `aggregator:4a4.ai:v0`.
