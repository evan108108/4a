# Claim flow (v0.5)

End-to-end walkthrough of how a 4A audience invite goes from "Evan invites Allison" to "Allison's client has the audience epoch private key and can decrypt." This is the load-bearing flow for v0.5 audiences. Source narrative: `../v0.5-design.md` §4 and `../SPEC-v0.5.md` §§5–6.

> **Pointer:** Static page lives at `../distribution/claim/index.html`, deployed to `claim.4a4.ai` via Cloudflare Pages project `claim-4a-ai`. Server endpoints live in `../gateway/src/audience.ts`.

## Roles

| Role | Who | What they do |
|---|---|---|
| Inviter | Evan's client (Sonata, `4a` CLI, or hosted ChatGPT/Claude connector) | Has the audience epoch private key. Mints an invite. |
| Invitee | Allison | Receives a URL by email/iMessage/Slack. Claims it. |
| Claim page | `claim.4a4.ai` (static, Cloudflare Pages) | Parses the URL, runs OAuth, posts the claim. **Convention only — not a privileged authority.** Any 4A client that registers the `4a://` URL scheme can replace this page. |
| Gateway | `api.4a4.ai` | Verifies the claim, signs and broadcasts the `kind:30521` key-grant under the inviter's audience. |
| Relays | Configured Nostr relay set | Carry the events. |

## Step 1 — Mint invite

Inviter calls `POST /v0/audience/invite` with `{ audience_slug, ttl_seconds? }` (default 7d).

The gateway:

1. Resolves the current `kind:30520` audience declaration.
2. Generates a fresh keypair `(invite_priv, invite_pub)`.
3. Republishes the declaration with one extra `fa:pending` tag pointing at `invite_pub`.
4. Encodes `invite_priv` as `4ainv1...` (bech32, HRP `4ainv`) using `invite-key.ts`.
5. Returns:

```json
{
  "four_a_url": "4a://invite/<slug>/<epoch>?k=<4ainv1...>",
  "https_url":  "https://claim.4a4.ai/invite/<slug>/<epoch>?k=<4ainv1...>",
  "invite_pub": "<hex>",
  "expires_at": "<unix>"
}
```

The inviter is responsible for delivering the URL out-of-band.

## Step 2 — URL travels

Email, iMessage, Slack, hand-delivered — anything. The `4a://` form is canonical. The `https://claim.4a4.ai/...` form is a transport convenience for surfaces that cannot register the `4a://` URL scheme; both resolve to the same flow.

**Clients MUST NOT hardcode `claim.4a4.ai` as a fallback resolver** (SPEC-v0.5 §7.3). It is one host of convenience; users may swap in any equivalent.

## Step 3 — Claim page (browser path)

Allison clicks the HTTPS link. `claim.4a4.ai` (single-page, vanilla JS, no framework) loads in her browser. The page:

1. Parses the path `/invite/<slug>/<epoch>` and the `?k=<4ainv1...>` query.
2. Decodes `invite_priv`. Refuses to proceed if the bech32 checksum fails or the HRP is wrong.
3. Surfaces the audience name from the resolved declaration so the user knows what they're joining.
4. Shows "Continue with GitHub" (default OAuth provider; v0.5 does not ship Google).
5. After OAuth, derives `claim_pubkey` from the user's KMS-backed identity (or accepts a user-provided pubkey for non-custodial users).
6. POSTs to `/v0/audience/claim` with `{ audience_slug, epoch, invite_priv_4ainv, claim_pubkey }`.

## Step 4 — Gateway verifies and grants

`/v0/audience/claim` (handler in `gateway/src/audience.ts`):

1. Verifies that `invite_priv` produces the `invite_pub` listed under `fa:pending` in the current declaration.
2. Verifies the OAuth identity matches `claim_pubkey` (custodial path) or accepts a self-asserted pubkey (non-custodial path).
3. Builds and signs a `kind:30521` `fa:KeyGrant` event:
   - `d` tag: `<audience-slug>:<epoch>:<recipient-hex>` (composite, addressable).
   - `p` tag: `claim_pubkey`.
   - `content`: NIP-44 v2 ciphertext of the audience epoch private key, encrypted to `claim_pubkey`.
4. Republishes the audience declaration `kind:30520` with:
   - `fa:pending` tag for `invite_pub` removed.
   - `p` tag for `claim_pubkey` added (the new member).
5. Broadcasts both events to the configured relay set.
6. Returns `{ grant_event_id, declaration_event_id }`.

Adding a member does **not** rotate the epoch — that only happens on remove or periodic refresh. Adding a new member does not expose old content because old content was published only to that older epoch.

## Step 5 — Invitee receives the grant

Allison's claim page (or her ongoing client, if she's not in a browser) is subscribed `kinds:[30521], #p:[claim_pubkey]`. The grant arrives, is decrypted in-place using `claim_pubkey`'s private key, and the audience epoch private key is recovered.

The page then offers two surfaces:

- **Keep local** — store the audience key in browser IndexedDB / Sonata plugin / `4a` CLI. Non-custodial: the gateway never sees the key after this point.
- **Delegate to gateway** — POST to `/v0/audience/:slug/delegate`. Allison can now read this audience from ChatGPT or Claude.ai through the hosted connectors. The gateway derives the per-request decryption capability via the same KMS HMAC pattern used for signing — transient in memory, no vault.

Both options decrypt with the same key. The choice is about *where* the key lives, not *who* is trusted.

## Direct paths (no claim flow)

When the recipient is already known, skip the claim flow:

- **Handle (`alice@4a4.ai`)** — resolve to npub via NIP-05, then `POST /v0/audience/grant` directly.
- **Raw npub** — `POST /v0/audience/grant` directly.

The claim flow exists specifically for the email/iMessage/Slack-to-stranger case where the inviter doesn't have a pubkey yet.

## Failure modes worth knowing

| Symptom | Likely cause |
|---|---|
| `claim.4a4.ai` returns 404 | Cloudflare Pages deployment not propagated. Check `claim-4a-ai` project, verify CNAME is proxied. |
| Bech32 decode fails on `?k=` | URL was truncated or copy-paste broke the checksum. Mint a fresh invite. |
| Grant arrives but page shows "decryption failed" | `claim_pubkey` mismatch — the OAuth flow produced a different pubkey than the grant was encrypted to. Re-run claim. |
| Inviter sees claim succeed but no membership update | `kind:30520` republish failed at the relay. Cron sweep should heal within 5 minutes; if not, inviter re-runs `/v0/audience/grant` manually. |

## Verification status

- 2026-05-06: end-to-end claim flow verified live. Cloudflare Pages project `claim-4a-ai` (deployment `https://245c6437.claim-4a-ai.pages.dev`), CNAME `claim.4a4.ai → claim-4a-ai.pages.dev` (proxied), Pages custom-domain status `active`. `https://claim.4a4.ai/` returns HTTP 200 with the `distribution/claim/index.html` payload.
