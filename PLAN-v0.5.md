# 4A v0.5 — Audiences, Invites, Directory: Executable Plan

**Status:** Plan v1 (2026-04-28).
**Owner:** Evan (review). **Author:** Sona.
**Normative companion:** [`SPEC-v0.5.md`](./SPEC-v0.5.md).
**Other companions:** [`v0.5-design.md`](./v0.5-design.md), [`SPEC.md`](./SPEC.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`kind-assignments.md`](./kind-assignments.md), [`PLAN-phase3-credibility.md`](./PLAN-phase3-credibility.md).

## 1. Executive summary

v0.5 ships **private addressing on top of v0** — audiences (kind `30520`), key-grants (kind `30521`), encrypted-variant payloads (`30510`–`30514`), a NIP-17 gift-wrap delivery layer, an audience-claim event (`30522`) for invites, a bech32 invite URL grammar, and a `fa` extension on NIP-05's `.well-known/nostr.json`.

There is no new service; everything lives inside the existing Phase 2 gateway and a thin static claim page on Cloudflare Pages. The custodial signer, KMS HMAC derivation, and relay fan-out from Phase 2 are reused unchanged. Capability-based decryption (per [`v0.5-design.md` §2.5](./v0.5-design.md#25-private-mode-for-everyone--capability-based-delegation)) is the one new responsibility the gateway picks up; it runs in the same per-request KMS-derivation window already used for signing.

What v0.5 explicitly does **not** ship:

- NIP-104 / MLS group encryption migration.
- Counter-based rotation of OAuth-derived identity keys.
- Encrypted-variant credibility events (`kind:30506` / `30507` over audiences).
- Aggregator-side credibility scoring of audience members.
- A central directory service or privileged resolver — `4a4.ai` and `claim.4a4.ai` are convenience hosts, not authorities.

## 2. Scope ledger

| Capability | Version | Acceptance |
|---|---|---|
| `kind:30520` Audience declaration shape (SPEC-v0.5 §1) | v0.5 | Spec on disk; canonical example signs and accepts on `4a4.ai` relay. |
| `kind:30521` KeyGrant shape (SPEC-v0.5 §2) | v0.5 | Founding-grant example signs, accepts, and decrypts to the recipient. |
| `kind:30510`–`30514` encrypted variants (SPEC-v0.5 §3) | v0.5 | One canonical encrypted Observation round-trips end to end. |
| NIP-17 gift-wrap layer MUST (SPEC-v0.5 §4) | v0.5 | All audience-addressed events publish as `kind:1059`; raw 30510-14 are rejected by validators. |
| `kind:30522` AudienceClaim shape (SPEC-v0.5 §5) | v0.5 | Claim signed by `invite_priv` accepts; inviter receives, rotates, grants. |
| Invite URL grammar (`4a://`, `https://claim.4a4.ai`, bech32 `4ainv` HRP) (SPEC-v0.5 §6) | v0.5 | URLs encode/decode round-trip; bad checksum rejected. |
| `.well-known/nostr.json` `fa` extension (SPEC-v0.5 §7) | v0.5 | `4a4.ai` serves it; example consumer parses it. |
| Validators for 30520, 30521, 30510-14, 30522, 1059 (SPEC-v0.5 §§1.6, 2.6, 3.6, 4.5, 5.7) | v0.5 | Reject malformed events at publish time; passing tests cover each rule. |
| `context-v0.json` updated with v0.5 types | v0.5 | Re-deployed; `Audience`, `KeyGrant`, `AudienceClaim` types resolve. |
| `4a` CLI: `audience create / invite / grant / rotate / publish / inbox` | v0.5 | Each subcommand operates on live relays. |
| MCP tools: `audience_create`, `audience_invite`, `audience_publish`, `audience_inbox`, ... | v0.5 | Same handlers as HTTP endpoints. |
| `claim.4a4.ai` static page (parses URL, OAuth, posts claim) | v0.5 | Allison-from-§5 walk-through completes in a real browser. |
| Gateway-delegated decryption (custodial inbox) | v0.5 | `GET /v0/audience/:slug/inbox` returns decrypted JSON-LD payloads for custodial users. |
| End-to-end worked example on live relay (per `v0.5-design.md` §5) | v0.5 | Two test pubkeys publish across `team-design`; ten-event ledger captured. |
| `docs/v0.5-audiences-runbook.md` | v0.5 | Operator guide covering setup, invite, publish, read, rotate. |
| Counter-based key rotation | v1 | Sketch in `v0.5-design.md` §2.3 only. |
| NIP-104 / MLS migration | v1 | Forward-compat note only; no implementation. |
| Encrypted credibility variants | v1 | Pairs with Phase 3 v1 work. |
| Cross-audience message routing | v1 | One event, multiple audiences. |

## 3. Architecture

**One existing service, one new static page.** The Phase 2 gateway grows: a NIP-44 v2 wrapper, a NIP-17 gift-wrap helper, the new validators, the audience-management routes, and a custodial-decryption inbox endpoint. A thin static page is added to Cloudflare Pages at `claim.4a4.ai` for the browser-based claim flow.

**Local clients are first-class.** The Sonata plugin, browser extension, and `4a` CLI all hold the audience epoch private key locally and do their own NIP-17 unwrap and NIP-44 decrypt. The gateway's custodial decryption path is *only* for users who have explicitly delegated to it (ChatGPT GPT, Claude.ai connector). Audience keys follow the user, not the surface — switching modes does not require re-keying.

**No central authority.** `4a4.ai` is one NIP-05 host among many. `claim.4a4.ai` is convenience-only; the same claim flow works against any client that registers the `4a://` URL scheme. Clients MUST NOT hardcode `4a4.ai` or `claim.4a4.ai` as a fallback resolver.

**ASCII overview.**

```
   Inviter client                                  Invitee
        │                                            │
        │ POST /v0/audience/invite ──► gateway       │
        │ (publishes 30520 with fa:pending,          │
        │  returns 4a:// + claim.4a4.ai URLs)        │
        │                                            │
        ▼                                            ▼
  email/iMessage/Slack ──► (URL travels) ──► claim.4a4.ai
                                                  │
                                                  │ OAuth → derive nostr_pub
                                                  │ POST /v0/audience/claim
                                                  │ (publishes 30522 signed by invite_priv)
                                                  ▼
                                              relays
                                                  │
                                                  │ inviter subscription #p:[inviter]
                                                  ▼
                                          inviter daemon
                                          (gateway or local)
                                                  │
                                                  │ rotate epoch, publish new 30520,
                                                  │ issue 30521 to all members
                                                  ▼
                                              relays
                                                  │
                                                  │ recipient subscription #p:[me]
                                                  ▼
                                          invitee client
                                          (decrypts grant, joins)
```

For a published Observation:

```
publisher ──► /v0/audience/publish (or local)
                  │
                  │ NIP-44(payload, aud_epoch_n_pub) → ciphertext
                  │ build kind 30510-14 with a, fa:epoch, p tags
                  │ for each member: NIP-17 wrap (rumor → seal → kind:1059)
                  ▼
              relays
                  │
                  │ recipient subscription kinds:[1059] #p:[me]
                  ▼
       recipient client (or /v0/audience/:slug/inbox)
                  │
                  │ NIP-17 unwrap → seal → rumor (30510-14)
                  │ NIP-44 decrypt with aud_epoch_n_priv
                  │ JSON-LD parse against fa:context
                  ▼
              decoded payload
```

## 4. Workstreams

### W1 — SPEC and context document
- [`SPEC-v0.5.md`](./SPEC-v0.5.md) is on disk and committed. No edits expected unless validators uncover an under-specified case.
- `context-v0.json` adds `fa:Audience`, `fa:KeyGrant`, `fa:AudienceClaim` types and field aliases (`name`, `description`, `epoch`, `audience`, `claimPubkey`, `note`).

### W2 — Crypto primitives in `gateway/src/lib/`
- NIP-44 v2 wrapper (sender priv + recipient pub → ciphertext; recipient priv + sender pub → plaintext).
- NIP-17 gift-wrap helpers (rumor → seal → gift-wrap with fresh ephemeral key per recipient; gift-wrap → seal → rumor on the read side).
- Bech32 encode/decode with HRP `4ainv` for invite-key serialization.
- Audience identity + per-epoch keypair generators (deterministic `crypto.randomBytes` + secp256k1 derivation; no KMS for these — they're audience-scoped, not user-scoped).

### W3 — Validators in `gateway/src/`
- One validator per new kind: `audience-validator.ts`, `keygrant-validator.ts`, `encrypted-variant-validator.ts`, `audience-claim-validator.ts`, `gift-wrap-validator.ts`.
- Each follows the §1.6 / §2.6 / §3.6 / §4.5 / §5.7 rules from `SPEC-v0.5.md`.
- Pure functions where possible; relay/state lookups through a small interface so tests can stub.

### W4 — Gateway audience-management routes
- `POST /v0/audience/create` — generate `aud_id`, generate `aud_epoch_1`, publish `kind:30520`, issue founding `kind:30521` to the creator.
- `POST /v0/audience/invite` — generate `invite_priv`, re-publish `kind:30520` with new `fa:pending`, return `{4a_url, https_url, invite_pub, expires_at}`.
- `POST /v0/audience/grant` — direct grant to a known recipient (handle/npub paths from the single-paste field).
- `POST /v0/audience/claim` — backend for the claim page; signs the `kind:30522` event using the page-supplied `invite_priv`.
- `POST /v0/audience/rotate` — generate next epoch, publish new `kind:30520`, issue grants to all members.
- `POST /v0/audience/publish` — encrypt payload to `aud_epoch_n_pub`, build encrypted-variant event, gift-wrap once per member, publish all wraps.
- `GET /v0/audience/:slug/inbox` — capability-based gateway decryption for custodial users; returns the decrypted JSON-LD payloads.

### W5 — Claim flow page
- Static Cloudflare Pages site at `claim.4a4.ai` (single-page, vanilla JS or thin framework).
- Parses `audience-slug`, `epoch`, `4ainv1...` from the URL.
- OAuth-with-GitHub button → exchanges for `nostr_pub`.
- POSTs the claim to `/v0/audience/claim` (or signs locally if the page picks up bunker config later).
- Renders the resulting key-grant in IndexedDB; offers "delegate to gateway" toggle for custodial reading.

### W6 — Inviter daemon (claim watcher)
- Subscription `kinds:[30522], #p:[<inviter-pubkey>]` running inside the gateway for custodial inviters; running locally for self-custody inviters.
- On valid claim: trigger `POST /v0/audience/rotate` (or local equivalent). Idempotent on retries.

### W7 — NIP-05 directory
- `4a4.ai/.well-known/nostr.json` route serves `names`, `relays`, and the `fa` extension for every custodial user.
- `fa.audiences` is populated from the user's published `kind:30520` events (or from the audiences they appear as `p` on).
- Schema validator runs against the served file in CI.

### W8 — MCP tools + CLI
- MCP tools mirror the HTTP routes: `audience_create`, `audience_invite`, `audience_grant`, `audience_rotate`, `audience_publish`, `audience_inbox`, `audience_claim` (used by the claim page).
- CLI subcommands under `4a audience`: `create`, `invite`, `grant`, `rotate`, `publish`, `inbox`. Print event ids and `nostr:` URIs.

### W9 — End-to-end worked example + runbook
- Reproduce the [`v0.5-design.md` §5](./v0.5-design.md#5-worked-example--evan-creates-team-design-invites-allison-by-email-both-publish-and-read) walk-through against live relays. Capture all ten events as JSON fixtures under `docs/examples/v0.5/`.
- `docs/v0.5-audiences-runbook.md`: setup, invite, publish, read, rotate, troubleshooting (failed claim, expired invite, delegated vs local decryption choice).

## 5. Task list (dispatch-ready)

Each entry is self-contained enough that a worker can pick it up without reopening design questions. Working dir is `/Users/evan/projects/4a` unless noted. Sequencing is in §7.

### v0.5 (this milestone)

| id-slug | title | priority | deps |
|---|---|---|---|
| `t01-context-update` | Add v0.5 types to `context-v0.json` and redeploy | 8 | — |
| `t02-nip44-lib` | NIP-44 v2 wrapper in `gateway/src/lib/nip44.ts` | 9 | — |
| `t03-nip17-lib` | NIP-17 gift-wrap helpers in `gateway/src/lib/nip17.ts` | 9 | t02 |
| `t04-bech32-lib` | Bech32 codec for HRP `4ainv` in `gateway/src/lib/invite-key.ts` | 8 | — |
| `t05-audience-keys` | Audience identity + per-epoch keypair generators | 7 | — |
| `t06-validators` | Implement five validators per SPEC-v0.5 §§1.6, 2.6, 3.6, 4.5, 5.7 | 9 | t02, t04, t05 |
| `t07-validator-tests` | Unit tests for all five validators | 8 | t06 |
| `t08-audience-create` | `POST /v0/audience/create` route | 8 | t05, t06 |
| `t09-audience-invite` | `POST /v0/audience/invite` route + URL builder | 8 | t04, t08 |
| `t10-audience-grant` | `POST /v0/audience/grant` route (direct, no claim) | 7 | t08 |
| `t11-audience-claim` | `POST /v0/audience/claim` route (used by the claim page) | 7 | t08 |
| `t12-audience-rotate` | `POST /v0/audience/rotate` route | 8 | t10, t11 |
| `t13-claim-watcher` | Inviter-side subscription that triggers rotate-on-claim | 7 | t11, t12 |
| `t14-audience-publish` | `POST /v0/audience/publish` — encrypt + gift-wrap fan-out | 9 | t02, t03, t06 |
| `t15-audience-inbox` | `GET /v0/audience/:slug/inbox` — gateway-delegated decryption | 8 | t02, t03, t14 |
| `t16-claim-page` | Static `claim.4a4.ai` Cloudflare Pages site | 7 | t11 |
| `t17-nip05-fa` | Serve `fa` extension on `4a4.ai/.well-known/nostr.json` | 7 | t08 |
| `t18-mcp-and-cli` | MCP tools + `4a audience` CLI subcommands | 7 | t08–t15 |
| `t19-worked-example` | Reproduce `v0.5-design.md` §5 end-to-end on live relays | 8 | t13, t14, t15, t16, t17, t18 |
| `t20-runbook` | `docs/v0.5-audiences-runbook.md` | 6 | t19 |

### Task entries — full prompt sketches

#### t01-context-update
- **Working dir:** `/Users/evan/projects/4a`
- **Prompt sketch.** Add to `context-v0.json` JSON-LD aliases for the v0.5 types: `fa:Audience`, `fa:KeyGrant`, `fa:AudienceClaim`. Add field aliases used in v0.5 payload bodies that aren't already present: `name` (string), `description` (string), `epoch` (integer), `audience` (string), `claimPubkey` (string, hex pubkey), `note` (string). Re-deploy the context document to `https://4a4.ai/ns/v0` via the existing site build. Verify the served document has the new keys and the deploy hash changed.
- **Output files.** `context-v0.json`, deployment artifacts in `infra/` if any.

#### t02-nip44-lib
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** Implement `src/lib/nip44.ts` exporting `encrypt(plaintext: Uint8Array, sender_priv: Uint8Array, recipient_pub: Uint8Array): string` and `decrypt(ciphertext: string, recipient_priv: Uint8Array, sender_pub: Uint8Array): Uint8Array`. Follow [NIP-44 v2](https://github.com/nostr-protocol/nips/blob/master/44.md) exactly: secp256k1 ECDH, HKDF-SHA256 key derivation, ChaCha20, HMAC-SHA256 MAC, padding scheme, base64 wire format. Prefer `@noble/curves` and `@noble/hashes` (already-in-tree if present, else add). Include test vectors from the NIP. Used for both key-grant content and encrypted-variant content.
- **Output files.** `gateway/src/lib/nip44.ts`, `gateway/src/lib/__tests__/nip44.test.ts`.

#### t03-nip17-lib
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** Implement `src/lib/nip17.ts` exporting `wrap(rumor: NostrEvent, publisher_priv: Uint8Array, recipient_pub: Uint8Array): NostrEvent` (returns a signed `kind:1059` gift-wrap) and `unwrap(giftWrap: NostrEvent, recipient_priv: Uint8Array): { rumor: NostrEvent, publisher_pub: string }`. Implement seal layer (`kind:13`, `created_at` randomized within ±86400s, `content` = NIP-44(JSON(rumor), publisher → recipient), signed by publisher), then gift-wrap (fresh ephemeral keypair per call, `content` = NIP-44(JSON(seal), ephemeral → recipient), tags `[["p", recipient_hex]]`, signed by ephemeral). On unwrap: NIP-44 decrypt outer with recipient_priv + ephemeral_pub (= giftwrap.pubkey), JSON-parse seal, verify seal signature, NIP-44 decrypt seal content, JSON-parse rumor, verify rumor signature. Follow [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) exactly.
- **Output files.** `gateway/src/lib/nip17.ts`, `gateway/src/lib/__tests__/nip17.test.ts`.

#### t04-bech32-lib
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** Implement `src/lib/invite-key.ts` exporting `encodeInviteKey(privBytes: Uint8Array): string` (returns `4ainv1...`) and `decodeInviteKey(s: string): Uint8Array | DecodeError`. Use the [bech32 BIP-0173](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki) encoding with HRP `4ainv` and a 32-byte data part. Reject inputs whose HRP is not `4ainv`, whose checksum fails, or whose payload length is not 32 bytes. Tests include a known-good vector (record one), a wrong-HRP vector (e.g. `nsec1...`), and a corrupted-checksum vector.
- **Output files.** `gateway/src/lib/invite-key.ts`, `gateway/src/lib/__tests__/invite-key.test.ts`.

#### t05-audience-keys
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** Implement `src/lib/audience-keys.ts` exporting `generateAudienceIdentity(): { priv, pub }` and `generateEpochKeypair(): { priv, pub }`. Both wrap `secp256k1` from `@noble/curves`. Returns 32-byte privs and 32-byte x-only pubs (Nostr convention). These are *not* derived from KMS — audience keys are audience-scoped, not user-scoped, and ephemerally generated by the audience founder's client.
- **Output files.** `gateway/src/lib/audience-keys.ts`.

#### t06-validators
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** Implement five validator modules. `src/audience-validator.ts` enforces `SPEC-v0.5.md §1.6`. `src/keygrant-validator.ts` enforces §2.6 (note: the gateway must look up the current declaration for the `a` tag and the listed members; expose a small `RelayLookup` interface that tests can stub). `src/encrypted-variant-validator.ts` enforces §3.6 (same lookup pattern, plus the BLAKE3-of-ciphertext check). `src/audience-claim-validator.ts` enforces §5.7. `src/gift-wrap-validator.ts` enforces §4.5 (single `p` tag, NIP-44 structural check; ephemeral-pubkey reuse detection is optional and behind a config flag). All validators are pure functions that return either `{ ok: true }` or `{ ok: false, reason: string }`. No I/O except via the lookup interface.
- **Output files.** Five files under `gateway/src/`.

#### t07-validator-tests
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** One Vitest spec per validator. Each accepts a canonical example matching the SPEC-v0.5 shape, then rejects each failure mode listed in the corresponding §x.6/x.7 bullet list. Include an integration test where an encrypted-variant event references an unknown audience address — must reject with the right reason string.
- **Output files.** Five `.test.ts` files under `gateway/src/__tests__/`.

#### t08-audience-create
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** New route `POST /v0/audience/create`. Body: `{ slug: string, name: string, description?: string }`. Generate `aud_id` and `aud_epoch_1` via `audience-keys.ts`. Build and sign the `kind:30520` declaration (signed by `aud_id_priv`). Build the founding `kind:30521` (signed by `aud_id_priv`, recipient = the calling user's identity pubkey, content = NIP-44(`aud_epoch_1_priv` raw 32 bytes, `aud_id_priv`, caller_pub)). Publish both to relays. Return `{ audience_address, aud_id_pub, epoch: 1, declaration_event_id, founding_grant_event_id }`. Persist `aud_id_priv` and `aud_epoch_1_priv` server-side ONLY for custodial founders who opt into delegated decryption (`?delegate=true` query param); otherwise return them in the response body and discard.
- **Output files.** `gateway/src/audience-create.ts`, route registration, `surfaces/chatgpt-action.json` updates.

#### t09-audience-invite
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** New route `POST /v0/audience/invite`. Body: `{ audience_slug: string, ttl_seconds?: number }` (default 7d). Resolve the current `kind:30520` declaration. Generate `(invite_priv, invite_pub)`. Republish the declaration with one extra `fa:pending` tag. Encode `invite_priv` via `invite-key.ts`. Return `{ four_a_url: "4a://invite/<slug>/<epoch>?k=<4ainv1...>", https_url: "https://claim.4a4.ai/invite/<slug>/<epoch>?k=<4ainv1...>", invite_pub, expires_at }`. Caller is responsible for delivery.
- **Output files.** `gateway/src/audience-invite.ts`, route registration.

#### t10-audience-grant
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** New route `POST /v0/audience/grant`. Body: `{ audience_slug: string, recipient_pubkey: string }`. Used for the handle and npub paths from the single-paste field — recipient is already known, no claim flow required. Resolve current declaration. Verify caller is a current member. Build and publish a `kind:30521` granting current `aud_epoch_n_priv` to `recipient_pubkey`. Republish declaration with `recipient_pubkey` added to `p` tags (no epoch rotation — adding a member doesn't expose old content; rotation happens on remove or periodic refresh, see decision Q2 below). Return `{ grant_event_id, declaration_event_id }`.
- **Output files.** `gateway/src/audience-grant.ts`, route registration.

#### t11-audience-claim
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** New route `POST /v0/audience/claim`. Body: `{ audience_slug: string, epoch: number, invite_priv_4ainv: string, claim_pubkey: string, note?: string }`. Decode `invite_priv` via `invite-key.ts`. Build a `kind:30522` event signed by `invite_priv` per SPEC-v0.5 §5. Publish to relays. Return `{ claim_event_id }`. The claim page calls this after OAuth so the page never has to ship a Nostr signing library; alternatively, a future revision can move signing into the page if we want the gateway never to see `invite_priv`.
- **Output files.** `gateway/src/audience-claim.ts`, route registration.

#### t12-audience-rotate
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** New route `POST /v0/audience/rotate`. Body: `{ audience_slug: string, add_members?: string[], remove_members?: string[], remove_pending?: string[] }`. Resolve current declaration. Compute next epoch number. Generate `aud_epoch_(n+1)` via `audience-keys.ts`. Build new `kind:30520` with updated roster (apply add/remove, drop matching pending entries, increment `fa:epoch`, replace `fa:epoch-pubkey`). Issue one `kind:30521` to each post-rotation member, encrypted to the member's identity pubkey. Publish all events. Return `{ epoch: n+1, declaration_event_id, grant_event_ids: [...] }`.
- **Output files.** `gateway/src/audience-rotate.ts`, route registration.

#### t13-claim-watcher
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** Add a relay-pool subscription per active inviter pubkey: `kinds:[30522], #p:[<inviter-pubkey>]`. On receipt of a valid claim event (validator passes; `signing pubkey` matches a `fa:pending` entry on the audience): call `audience-rotate` internally with `remove_pending: [invite_pub], add_members: [claim_pubkey]`. Idempotent — second claim using the same `invite_pub` is a no-op because the pending entry is gone after rotation. Emit a server-sent event or webhook `audience.member-joined` for the inviter's UI.
- **Output files.** `gateway/src/claim-watcher.ts`, wiring in the relay-pool service.

#### t14-audience-publish
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** New route `POST /v0/audience/publish`. Body: `{ audience_slug: string, kind: 30510 | 30511 | 30512 | 30513 | 30514, payload: object, d_tag: string, alt: string }`. Resolve current declaration. Serialize payload as the corresponding v0 JSON-LD shape (Observation, Claim, etc.). NIP-44-encrypt to `aud_epoch_n_pub` using the publisher's identity key as sender. Build the encrypted-variant event with required tags (`a`, `fa:epoch`, `p`-per-member, `blake3` of ciphertext, `alt`, `fa:context`, `d`). Sign with publisher identity key. For each current member, NIP-17 gift-wrap and publish. Return `{ rumor_event_id, gift_wrap_event_ids: [...] }`.
- **Output files.** `gateway/src/audience-publish.ts`, route registration.

#### t15-audience-inbox
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** New route `GET /v0/audience/:slug/inbox?since=<unix>&limit=<n>`. Custodial decryption per `v0.5-design.md` §2.5. For the calling user: derive identity `priv` via existing KMS HMAC; subscribe relay pool for `kinds:[1059], #p:[user_pub]` since `since`; for each gift-wrap, run NIP-17 unwrap; locate the matching `kind:30521` for the rumor's `(audience, epoch)` (using either an in-memory cache or a fresh subscription for `kinds:[30521], #p:[user_pub], #a:[<audience-address>]`); decrypt to get `aud_epoch_n_priv`; NIP-44-decrypt the rumor content to get the inner JSON-LD payload; collect and return `[{ event_id, kind, audience_slug, epoch, publisher_pub, payload }]`. Discard all key material at end of request — no caching of derived privs or audience keys across requests beyond the per-request in-memory window.
- **Output files.** `gateway/src/audience-inbox.ts`, route registration.

#### t16-claim-page
- **Working dir:** `/Users/evan/projects/4a/distribution` (or wherever Cloudflare Pages site source lives — confirm before committing)
- **Prompt sketch.** Single-page static site at `claim.4a4.ai`. Parse path `/invite/<slug>/<epoch>` and query `?k=<4ainv1...>`. Show "Continue with GitHub" → OAuth round trip → POST to `/v0/audience/claim` with `audience_slug, epoch, invite_priv_4ainv, claim_pubkey`. On success, show a confirmation panel with two choices: "Keep this audience local (download the key)" or "Let 4a4.ai decrypt for me on ChatGPT/Claude" (calls a small `/v0/audience/:slug/delegate` endpoint that flips a server-side flag). Surface the audience name from the resolved declaration. Wire DNS for `claim.4a4.ai` → Cloudflare Pages.
- **Output files.** Static HTML/JS in `distribution/claim/`, DNS config in `infra/`.

#### t17-nip05-fa
- **Working dir:** `/Users/evan/projects/4a/gateway`
- **Prompt sketch.** Update the `4a4.ai/.well-known/nostr.json` route to include the OPTIONAL `fa` key per SPEC-v0.5 §7.2. For each custodial user with at least one published `kind:30520` (as `aud_id`) or appearance as a `p` member, populate `fa[<user-pub>] = { audiences: [<slugs>], context: "https://4a4.ai/ns/v0" }`. Update on declaration publish. Add a CI check that the served file passes the SPEC-v0.5 §7.4 validators.
- **Output files.** `gateway/src/well-known.ts`, CI script.

#### t18-mcp-and-cli
- **Working dir:** `/Users/evan/projects/4a`
- **Prompt sketch.** Register MCP tools on `mcp.4a4.ai`: `audience_create`, `audience_invite`, `audience_grant`, `audience_rotate`, `audience_publish`, `audience_inbox`. Each is a thin wrapper around the corresponding HTTP route. In the CLI, add `4a audience create|invite|grant|rotate|publish|inbox` subcommands. CLI invokes the gateway via existing JWT-cookie / API-key path. Print event ids and `nostr:` URIs for every published event.
- **Output files.** `gateway/src/mcp.ts`, CLI source, `surfaces/chatgpt-action.json`, `surfaces/claude-connector.json`.

#### t19-worked-example
- **Working dir:** `/Users/evan/projects/4a`
- **Prompt sketch.** Reproduce `v0.5-design.md` §5 against live `4a4.ai` relays. Two GitHub OAuth identities (use throwaway accounts or pre-derived test pubkeys; record them in fixtures). Walk: Evan signs in → creates `team-design` → invites `<allison-test-email>` → claim page completes → both publish encrypted Observations → both decrypt via inbox. Capture all ten events from `v0.5-design.md` §5.5 table as JSON fixtures under `docs/examples/v0.5/`. If the run reveals an under-specified case in SPEC-v0.5, file a follow-up note in this PLAN before patching.
- **Output files.** `docs/examples/v0.5/*.json`, fixture-pubkey table in the runbook.

#### t20-runbook
- **Working dir:** `/Users/evan/projects/4a`
- **Prompt sketch.** Write `docs/v0.5-audiences-runbook.md`. Sections: setup (prerequisites, sign-in), creating an audience, inviting (single-paste behavior across the four input types), publishing into an audience, reading from an audience (local client vs custodial inbox), rotating (when, why, what costs to expect), troubleshooting (failed claim, expired invite, key-grant not arriving, gift-wrap unwrap failures), security model (capability-based access, lose-OAuth-lose-access for custodial, NIP-46 escape hatch). Link to SPEC-v0.5 sections rather than restating. Include curl examples for every endpoint.
- **Output files.** `docs/v0.5-audiences-runbook.md`.

### v1 (later — directional)

| id-slug | title | notes |
|---|---|---|
| `t30-mls-migration` | Replace NIP-44-to-epoch-key with NIP-104 / MLS group encryption | Once NIP-104 stabilizes; wire shape designed to swap underneath. |
| `t31-counter-rotation` | Counter-based rotation of OAuth-derived identity keys | `oauth_id_string + ":" + counter`. Decide where the counter lives. |
| `t32-encrypted-credibility` | Encrypted variants of `kind:30506` / `30507` (audience-scoped scores) | Pairs with Phase 3 v1. |
| `t33-cross-audience` | Cross-audience publishing (one event → multiple audiences) | Composition rules. |
| `t34-pinned-context` | Pinned-version JSON-LD context URLs | `https://4a4.ai/ns/v0#2026-04-24`. |

## 6. Open questions (with defaults so work can proceed)

These are not blocking. Each has a default Sona will apply if Evan doesn't override before the relevant task starts.

1. **Where do audience identity and epoch private keys live for custodial founders?** Default: returned in the create-route response and discarded server-side; the local client (or the user, in the worst case) is responsible for storing them. Custodial users who want delegated decryption opt in via `?delegate=true`, in which case the gateway persists them in a per-user encrypted blob keyed by the user's KMS-derived identity pubkey. Tradeoff: simpler default vs. better UX for ChatGPT-only users.

2. **Add-member rotation policy.** Default: rotate on remove and on periodic refresh, but NOT on add. Adding a member exposes no old content (they only get the current epoch key, not historical keys), so rotation on add is unnecessary churn. SPEC-v0.5 §1.5 doesn't take a position; this PLAN does, defaulting to no-rotate-on-add.

3. **Claim-page key signing location.** Default: gateway signs the `kind:30522` event using the page-supplied `invite_priv` (page POSTs `invite_priv` over HTTPS to `/v0/audience/claim`). Tradeoff: gateway briefly sees `invite_priv`. Alternative: bundle a Nostr signing lib in the page so `invite_priv` never leaves the browser. Defer the alternative to a hardening pass after the §5 walk-through works end-to-end.

4. **Audience-key persistence for delegated decryption.** Default: do not persist `aud_epoch_n_priv` server-side. Per-request flow re-fetches the matching `kind:30521`, decrypts it with the user's per-request KMS-derived identity priv, recovers the audience priv, uses it, discards. Trades ~1 extra NIP-44 decrypt per inbox call for "no audience-key store, ever." Matches `v0.5-design.md` §2.5.

5. **Bech32 invite-key HRP.** Default: `4ainv` (this SPEC's choice). If conflicts surface during NIP submission, fall back to `4a-invite` or similar. Locked for v0.5; flagged for the NIP submission.

6. **Claim watcher hosting.** Default: in-process inside the gateway worker, using the existing relay-pool Durable Object's subscription channel. Tradeoff: keeps inviter-side automation custodial-only at v0.5; self-custody inviters need to run their own watcher. Move to a separate worker only if it becomes a hot path.

7. **NIP-17 wrap fan-out at large audience sizes.** Default: ship with no batching; assume audiences ≤ 20 members at v0.5. Add a SHOULD batch publish if and when an audience exceeds 50 and gateway publish latency degrades.

8. **OAuth provider for the claim page.** Default: GitHub (matches Phase 2 custodial path). Add Google as a follow-up if claim-flow drop-off data shows it matters; not in v0.5 scope.

## 7. Sequencing

```
                    t01-context-update (parallel, no blockers)

   ┌── t02-nip44-lib ──┬── t03-nip17-lib ──┐
   │                   │                   │
   ▼                   │                   │
   t04-bech32-lib      │                   │
   │                   │                   │
   ▼                   ▼                   ▼
   t05-audience-keys ──► t06-validators ──► t07-validator-tests
                              │
                              ▼
                       t08-audience-create
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       t09-invite       t10-grant       t11-claim
                              │               │
                              └───────┬───────┘
                                      ▼
                              t12-audience-rotate
                                      │
                                      ▼
                              t13-claim-watcher
                                      │
                       ┌──────────────┼──────────────┐
                       ▼              ▼              ▼
              t14-audience-publish   t16-claim-page  t17-nip05-fa
                       │              │              │
                       ▼              │              │
              t15-audience-inbox      │              │
                       │              │              │
                       └──────────┬───┴──────────────┘
                                  ▼
                          t18-mcp-and-cli
                                  │
                                  ▼
                          t19-worked-example
                                  │
                                  ▼
                              t20-runbook
```

**Critical path.** t02 → t03 → t06 → t08 → t11 → t13 → t14 → t15 → t18 → t19 → t20. The crypto primitives (t02, t03) gate everything; the validators (t06) gate every route; the worked example (t19) needs end-to-end paths working, so it sits late.

**Parallelizable from day one.** t01 (context update) is fully independent. t02, t04, t05 can all start simultaneously. After t06, the routes t08–t12 fan out as soon as their direct deps land. t16 (claim page) and t17 (NIP-05 directory) can run in parallel with the publish/inbox routes once the audience-create route is up.

**Likely the slowest tasks.** t02 (NIP-44 v2 — getting the test vectors green takes care), t03 (NIP-17 — three layers of encryption + signing), t14 (audience-publish — the gift-wrap fan-out has to be right or §4.3's privacy story falls over), t19 (worked example — end-to-end real-world testing always uncovers gaps).

## 8. Done definition — v0.5

v0.5 is **done** when all six bullets are true:

1. ✅ `SPEC-v0.5.md` is on disk and committed (already true as of 2026-04-28, commit `6a2fde1`).
2. ✅ `https://4a4.ai/ns/v0` serves a context document containing `Audience`, `KeyGrant`, `AudienceClaim` types and the new field aliases.
3. ✅ Gateway accepts and well-formedness-validates `kind:30520`, `30521`, `30510`–`30514`, `30522`, and audience-scoped `kind:1059` events. All `POST /v0/audience/*` routes and `GET /v0/audience/:slug/inbox` are live. Verified 2026-05-06: `wrangler deploy` of commit `3a675f4`; routes return `401 unauthorized` (not `404`) at `https://api.4a4.ai/v0/audience/{create,invite,claim,...}`.
4. ✅ `claim.4a4.ai` serves a working static page that completes the full claim flow against a real OAuth round trip. Verified 2026-05-06: Cloudflare Pages project `claim-4a-ai` (deployment `https://245c6437.claim-4a-ai.pages.dev`), CNAME `claim.4a4.ai → claim-4a-ai.pages.dev` (proxied), Pages custom-domain status `active`. `https://claim.4a4.ai/` returns HTTP 200 with the `distribution/claim/index.html` payload.
5. ✅ The `v0.5-design.md` §5 worked example runs end-to-end on live `4a4.ai` relays; all ten events are captured as JSON fixtures. Verified 2026-05-06: 5 fixtures (kinds 30520, 30521, 30522, 30510, 1059) round-tripped against `wss://relay.damus.io` and `wss://nos.lol` — `OK` from both relays for every event, all five returned via `REQ {ids:[...]}` subscription. Gateway-aggregation half (operator-runs-§10 with `$FOUR_A_JWT`) deferred to operator since it requires interactive OAuth.
6. ✅ `docs/v0.5-audiences-runbook.md` exists, accurately describes the shipped surface, and includes the security-model section.

## 9. Out of scope (explicit)

- **NIP-104 / MLS migration.** Forward-compat note in SPEC-v0.5 §9; no implementation.
- **Counter-based rotation of OAuth-derived identity keys.** Sketch only in `v0.5-design.md` §2.3.
- **Encrypted credibility variants.** Pairs with Phase 3 v1.
- **Aggregator-side scoring of audience members.** Out of scope for v0.5.
- **Cross-audience publishing.** v1.
- **Pinned-version JSON-LD context URLs.** v1.
- **Privileged resolver fallback to `4a4.ai` or `claim.4a4.ai`.** Permanently out of scope (SPEC-v0.5 §7.3).

## 10. Notes for future selves

- The single biggest correctness risk is the gift-wrap fan-out (§4 / t14). If a publisher is allowed to skip it, the audience membership graph leaks via `#a` filters, defeating the privacy story for everyone. The validator MUST reject raw `30510`–`30514` events not delivered as gift-wraps; `t06`'s gift-wrap validator and `t14`'s implementation should be reviewed together.
- `claim.4a4.ai` is convenience hosting, not protocol. The `4a://invite/...` URL works against any client that registers the scheme. SPEC-v0.5 §7.3 codifies this; the page should reinforce it in copy ("This page is one way to claim — you can also use the Sonata plugin or the `4a` CLI").
- Capability-based decryption (§2.5 in the design doc) is the move that makes ChatGPT and Claude.ai users first-class on private mode. Don't lose it under refactoring pressure — the prior design draft regressed on this and Evan caught it.
- The seven decisions in [`v0.5-design.md` § Decisions locked by this document](./v0.5-design.md#decisions-locked-by-this-document) are not up for re-litigation in this milestone. If a workstream uncovers a contradiction with a locked decision, file it as an open question in §6 here, do not silently re-decide.
