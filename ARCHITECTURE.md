# 4A — Architecture and Deployment

This document describes the deployment shape of the 4A reference services, the identity model, and the rationale behind the technology choices. For the convention itself, see [`README.md`](./README.md).

## Goals

- Cheapest reliable shape that scales to millions of requests per month
- No persistent state in the hosted gateway (no database, no object store, no Parameter Store)
- Surfaces accessible to cloud-hosted agents (ChatGPT, Claude.ai) without local install
- Local self-hosting must remain a first-class option for power users and OSS-project commons

## Component overview

```
                       ┌──────────────────────────────┐
                       │  Nostr relays (existing)     │
                       │  relay.damus.io, nos.lol,    │
                       │  nostr.wine, …               │
                       └──────────────┬───────────────┘
                                      │ WSS
                                      ▼
                       ┌──────────────────────────────┐
                       │  4A hosted gateway           │
                       │  Cloudflare Workers          │
                       │  + Durable Objects           │
                       │                              │
                       │  Phase 1:                    │
                       │   - public read API          │
                       │   - relay subscriptions in   │
                       │     Durable Objects (WS      │
                       │     hibernation)             │
                       │                              │
                       │  Phase 2:                    │
                       │   - OAuth (GitHub)           │
                       │   - KMS-backed key           │
                       │     derivation               │
                       │   - publish endpoints        │
                       └─────┬────────────────────┬───┘
                             │                    │
                  Phase 2 only│                    │
                             ▼                    ▼
                  ┌──────────────────┐   ┌──────────────────┐
                  │   AWS KMS        │   │   GitHub OAuth   │
                  │   (HMAC key,     │   │   (identity)     │
                  │   non-extractable│   │                  │
                  │   derivation)    │   │                  │
                  └──────────────────┘   └──────────────────┘

                        ▲ HTTP / SSE / MCP
                        │
       ┌────────────┬───┴────────┬─────────┬────────────┬──────────┐
       │ ChatGPT    │ Claude.ai  │ MCP     │ Browser    │ Sonata   │
       │ Custom GPT │ connector  │ clients │ extension  │ plugin   │
       │            │            │         │ (later)    │ (local)  │
       └────────────┴────────────┴─────────┴────────────┴──────────┘

                                       ╳

                       ┌──────────────────────────────┐
                       │  Local CLI (`4a`)            │
                       │  - signs with local key      │
                       │  - posts directly to relays  │
                       │  - bypasses gateway entirely │
                       └──────────────────────────────┘
```

## Why Cloudflare Workers + AWS KMS

Two clouds, picked for what each does best.

### Cloudflare Workers + Durable Objects (compute)

The hosted gateway's central job is to maintain WebSocket subscriptions to Nostr relays. Lambda fundamentally cannot do this — Lambda invocations cannot hold persistent connections across requests. A Lambda-based architecture would require a separate Fargate (or equivalent) always-on indexer service, splitting the system into two deployment targets.

Durable Objects can hold WebSocket connections via the **WebSocket hibernation API**. The Durable Object is suspended between events; it pays only for storage and active processing. This collapses the indexer and the API into one architecture and one deploy target.

Other Workers properties that fit:

- Cold start ~5ms (vs ~200–500ms for Lambda with Bun runtime)
- Edge-distributed by default (every PoP is an entry point)
- Free tier covers up to 100,000 requests per day
- Paid plan ($5/mo) covers 10,000,000 requests per month
- Workers have a 50ms CPU limit on the free plan and 30s on paid — well within our needs

### AWS KMS (identity)

Cloudflare does not have a non-extractable HMAC primitive equivalent to AWS KMS. Workers Secrets are encrypted at rest but are available as plaintext to the running Worker code; that is comparable to a Lambda environment variable, not to an HSM-backed HMAC key.

For deterministic key derivation (see below), we want the master HMAC secret to be non-extractable: it never appears in plaintext outside the HSM, even to the running Worker code. AWS KMS HMAC keys provide this. Each `GenerateMac` call is ~$0.000003 and ~50ms.

The architecture uses Cloudflare Workers for the heavy lifting (compute, WS, edge distribution) and calls AWS KMS only for the security-critical derivation step.

## Identity model

A 4A user's identity is a Nostr keypair. The hosted gateway supports three paths to having one. The interesting one is the custodial path; the others are well-defined existing patterns.

### Custodial via OAuth (the default)

When a user signs in with GitHub OAuth, the gateway derives their Nostr private key deterministically from their OAuth identity using an HMAC key held in AWS KMS. **No keys are stored.** Every signing operation re-derives the key on demand.

The derivation:

```
oauth_id_string = oauth_provider + ":" + oauth_user_id
seed_bytes = AWS_KMS.GenerateMac(
    KeyId = "4a-derivation-key",
    Message = oauth_id_string,
    MacAlgorithm = "HMAC_SHA_256"
)
nostr_private_key = clamp_to_secp256k1(seed_bytes)
nostr_public_key = secp256k1_pubkey(nostr_private_key)
```

The HMAC key (`4a-derivation-key`) is created in AWS KMS as a non-extractable HMAC-SHA-256 key. It never leaves the HSM. The seed bytes are returned, used in-memory by the Worker for the duration of the signing operation, and discarded. The Nostr private key never persists to any storage.

Consequences:

- **No database.** No keystore. Nothing to back up. Nothing to leak from a database breach.
- **The OAuth account is the recovery mechanism.** Re-authenticating to GitHub re-derives the same key.
- **Users can export their nsec.** A `GET /me/export` endpoint runs the derivation and returns the private key, allowing the user to migrate to local self-hosting or a NIP-46 bunker.
- **Same OAuth identity → same Nostr key, forever.** This is the v0 contract.

The major tradeoff is that the KMS HMAC key is the master secret for every custodial user. If it leaks, all derived keys are compromised — and unlike a per-user keystore, the keys cannot be rotated by re-encrypting (the keys are out in the network with reputation attached). Mitigations:

- KMS HMAC keys are non-extractable by definition; the only way they leak is via AWS HSM compromise
- IAM policy locks the key to the gateway service principal only
- All `GenerateMac` calls are CloudTrail-audit-logged
- The blast radius is bounded — 4A custodial users only; users on the bunker or local-self-host paths are unaffected

### NIP-46 bunker

Users with an existing Nostr identity provide a NIP-46 bunker URI in their account settings. The gateway forwards signing requests to the bunker (a separate Nostr event flow); the bunker signs and returns the signature. The gateway never sees the private key.

This is the right path for power users and for anyone uncomfortable with custodial. Existing public bunkers (nsec.app, others) work out of the box.

### Local self-hosting

Anyone can clone the gateway repository and run it themselves on their own Cloudflare account, with their own KMS key (or with a Workers Secret if they accept the security tradeoff). Their users get the same surface area entirely off our infrastructure.

OSS-project commons are encouraged to self-host: `commons.next.js` runs its own gateway and own key, and the project's MCP config points users at it. We host nothing for them.

The local CLI (`4a`) bypasses the gateway entirely — it signs with a locally stored key and publishes directly to Nostr relays. This is the lowest-trust publishing path and the right choice for an OSS-project maintainer key.

### Rotation (deferred)

In v0, custodial users cannot rotate their Nostr key without changing their OAuth account, because the derivation is deterministic on the OAuth ID. If a user wants rotation later, the derivation can be extended to include a counter:

```
oauth_id_string = oauth_provider + ":" + oauth_user_id + ":" + rotation_counter
```

Where the counter lives is a future decision: a JWT claim, a NIP-32 self-published label, or a tiny key/value somewhere. v0 does not implement this; the convention is "your OAuth identity is your 4A pubkey, forever."

## Phase plan

### Phase 1 — read everywhere, write locally

The minimum viable system. No identity, no DB, no KMS.

- Cloudflare Worker exposes `GET /query`, `GET /object/:id`, `GET /credibility/:pubkey`, `GET /commons` and an SSE-transport MCP wrapper at `/mcp/sse`
- Durable Objects hold WebSocket subscriptions to a configured set of relays
- Read endpoints query the Durable Objects' in-memory event cache, with a fallback to direct relay queries on cache miss
- Local CLI (`4a`) handles all publishing — power users sign with their own key, post directly to relays
- Sonata plugin wraps the local CLI for Sonata users
- ChatGPT Custom GPT and Claude.ai connector wrap the public read API

Total infrastructure cost: free tier covers all expected v0 traffic; ~$5/mo if it gets popular.

### Phase 2 — custodial publishing

Adds OAuth and KMS-backed signing for users on cloud agent surfaces.

- GitHub OAuth flow on the gateway
- AWS KMS HMAC key created (`4a-derivation-key`)
- Worker derives Nostr keys per-request via KMS `GenerateMac`
- Write endpoints (`POST /publish/observation`, `POST /publish/claim`, `POST /attest`) become available to authenticated callers
- Per-user API tokens (signed JWTs, no server-side state) for ChatGPT/Claude connectors
- NIP-46 bunker support added as alternate identity path
- Export endpoint (`GET /me/export`) added for users who want to migrate to bunker or local

Additional infrastructure cost: KMS calls (~$1 per million), API Gateway cost stays at zero (Worker handles HTTP directly). At 1M publishes/month: ~$1 added cost.

### Phase 2.5+

- NIP submission for 4A event kinds
- Optional self-hosted aggregator that publishes NIP-85 score assertions over the citation graph
- Arweave pinning workflow

## Cost model

Estimates at representative traffic volumes, assuming Phase 2 deployed.

| Monthly requests | Workers | KMS | Total |
|---|---|---|---|
| 1,000 | $0 (free tier) | $0 | $0 |
| 100,000 | $0 (free tier) | $0.10 | $0.10 |
| 1,000,000 | $5 (paid plan) | $1 | ~$6 |
| 10,000,000 | $5 + $30 | $10 | ~$45 |
| 100,000,000 | $5 + $300 | $100 | ~$405 |

The cost model holds because Workers' free plan covers up to 3M req/mo (100K/day) and the paid plan ($5/mo) covers up to 10M req/mo, with linear scaling thereafter. KMS GenerateMac is $1 per million calls and only fires on publishes (writes), which are an order of magnitude less frequent than reads.

For comparison, the equivalent AWS-only architecture (Lambda + API Gateway + Fargate indexer + KMS) lands around $15–25/mo at v0 scale and ~$200/mo at 10M req/mo.

## What we deliberately do not run

- A database
- An object store
- A Parameter Store / Secrets Manager record per user
- An always-on EC2 / Fargate / App Runner service
- A Nostr relay
- A reputation aggregator (Phase 2.5+ may add this; v0 consumes existing assertions from nostr.band, Vertex)

If any of these become necessary, they are explicit additions with their own justification, not inheritances from this design.

## Source code layout (planned)

```
4a/
  README.md                 # convention pitch
  ARCHITECTURE.md           # this document
  LICENSE                   # Apache 2.0
  spec/
    kind-assignments.md
    vocabulary-v0.md
    context-v0.json         # the JSON-LD context document (hosted at 4a4.ai/ns/v0)
  gateway/                  # Cloudflare Worker source
    src/
      router.ts             # HTTP routing
      query.ts              # read endpoints
      publish.ts            # write endpoints (Phase 2)
      auth.ts               # OAuth + JWT (Phase 2)
      kms.ts                # AWS KMS GenerateMac wrapper (Phase 2)
      relay-pool.ts         # Durable Object: holds WS connections
      mcp-wrapper.ts        # SSE-transport MCP adapter
    wrangler.toml
  cli/                      # local publisher
    src/
      keygen.ts
      publish.ts
      sign.ts
  surfaces/                 # configurations for external surfaces
    chatgpt-action.json     # OpenAPI spec for ChatGPT Custom GPT Actions
    claude-connector.json   # Claude.ai connector manifest
    sonata-plugin.json      # Sonata plugin manifest
  examples/
    publish-observation.ts
    consume-via-mcp.json
```

## Open architectural questions

- **DurableObject sharding strategy.** A single DO holding all WS subscriptions does not scale past one CF region. We may need to shard by relay (one DO per relay) or by topic (one DO per popular `t` tag) once traffic grows. v0 uses one DO and accepts the limit.
- **Cache invalidation between Durable Objects and edge KV.** If we ever cache query results at the edge for read latency, we need to invalidate when new events arrive. Fall back to short TTLs (60 seconds) until volume justifies smarter invalidation.
- **OAuth provider expansion.** GitHub-only at v0; Google and Apple are obvious additions but not necessary for the engineer audience the OSS-commons wedge targets.
- **NIP-46 timeout handling.** If a user's bunker is offline, signing requests time out. UX needs a clear failure mode (queued retry vs immediate failure).

## Change log

- 2026-04-24 — Initial architecture document. Cloudflare Workers + Durable Objects for compute; AWS KMS for HMAC-based deterministic key derivation; no database; two-phase rollout (read-everywhere + write-locally first, custodial publishing second).
