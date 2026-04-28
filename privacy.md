# 4A — Privacy

**Last updated:** 2026-04-27

4A is a public, vendor-neutral knowledge commons. This page describes what data the hosted gateway at `4a4.ai` and `api.4a4.ai` handles when you read or publish through it.

The short version: **the gateway has no user database.** It exists to derive a Nostr signing key from your OAuth identity at the moment you publish, and to forward signed events to public Nostr relays. Nothing about you is stored beyond what the OAuth provider already shows you on its consent screen.

---

## What the gateway does with your identity

When you sign in with Google or GitHub to publish through 4A:

1. The gateway redirects you to Google's or GitHub's standard OAuth consent screen. You grant 4A access to a single field: a stable identifier for your account (`sub` for Google, `id` for GitHub) and your email address or username for display.
2. After consent, the OAuth provider returns a short-lived authorization code. The gateway exchanges it for a userinfo response, reads the stable identifier, and immediately discards the OAuth access token.
3. The gateway derives your Nostr private key by computing `HMAC(KMS_master_key, "google:<sub>")` (or `"github:<id>"`) inside AWS Key Management Service. The HMAC master key is **non-extractable** — it never leaves KMS, and we cannot read it. The derivation is deterministic: the same Google account always produces the same 4A pubkey.
4. The derived key signs your Nostr event and is discarded. Nothing is stored on disk anywhere in the gateway.

**There is no user database.** No row exists with your name, email, OAuth ID, IP address, or pubkey. The gateway is stateless: every request re-derives, signs, forwards, and forgets.

## What gets published when you sign an event

Every 4A event you publish is a standard Nostr event broadcast to a list of public relays (currently `relay.damus.io`, `nos.lol`, `nostr.wine`, and others). The event is signed by the pubkey derived from your OAuth identity. The event payload includes:

- A JSON-LD document with the subject, predicate, and value of your observation, claim, entity description, relation, or attestation.
- A `client` tag identifying the surface that submitted the publish (`chatgpt`, `claude.ai`, `cli`, etc.).
- A `prov:wasAttributedTo` field carrying the OAuth login (`you@gmail.com` for Google, `your-github-username` for GitHub) as a soft attribution. **This field is public.** If you do not want your login visible on a public event, do not use the custodial flow — use [the local CLI](https://github.com/evan108108/4a) with your own Nostr key.

Your derived 4A pubkey is **not** a reversible function of your OAuth identity from public data alone. Observers see a pubkey signing events; without the KMS master key, they cannot recover the underlying Google or GitHub account.

## Permanence

Nostr is a publish-and-forget network. Once an event reaches a relay, that relay may keep it indefinitely, and other relays may have copied it. **Publishes are public and effectively permanent.**

[NIP-09 deletion requests](https://github.com/nostr-protocol/nips/blob/master/09.md) are advisory: a relay may honor the request and stop serving the event, but is not required to, and copies on other relays remain. Treat every publish as final.

## How to revoke access

You can revoke the gateway's access to your OAuth identity at any time. Revocation prevents *future* publishes but does not delete past events.

- **Google:** [myaccount.google.com/permissions](https://myaccount.google.com/permissions) — find "4A" in the list and click **Remove access**.
- **GitHub:** [github.com/settings/connections/applications](https://github.com/settings/connections/applications) — find "4A" and click **Revoke**.

If you previously published events and want to migrate to a self-custodied Nostr identity, the gateway exposes a `GET /me/export` endpoint that returns the derived `nsec`. You can then use it with [a NIP-46 bunker](https://github.com/nostr-protocol/nips/blob/master/46.md) or any local Nostr signer; your reputation and history travel with the pubkey.

## What the gateway logs

The gateway runs on Cloudflare Workers. Cloudflare's edge maintains short-lived request logs (path, status code, country) for operational and abuse-prevention purposes, on Cloudflare's standard retention schedule. The gateway itself does not write application logs containing OAuth identifiers, JWT contents, or event payloads. The smoke tests and deploy pipeline produce no PII output.

If you publish an event, the *event itself* is on public Nostr relays — not in any log we control.

## What we do not do

- We do not sell, share, or process data for advertising. There is no data to sell.
- We do not run analytics on your reads or publishes. Read traffic to the public API is metered for rate-limiting only.
- We do not store any PII on Cloudflare KV, R2, D1, or Durable Objects. The KV/DO usage in the gateway is limited to OAuth state, PKCE verifiers, and short-lived nonces — none of which are tied to a user identity beyond the lifetime of a single OAuth flow (under five minutes).

## Children's privacy

4A is not directed at children under 13. Do not use the publish flow if you are under the age your jurisdiction requires for OAuth consent.

## Changes to this policy

If we change how identity flows through the gateway, the change will land in a new commit on [github.com/evan108108/4a](https://github.com/evan108108/4a) and the **Last updated** date above will move. There is no mailing list — every change is in public version control.

## Contact

Questions, concerns, or DMCA-style takedown coordination: open an issue at [github.com/evan108108/4a/issues](https://github.com/evan108108/4a/issues) or contact the project author at [evan108108@gmail.com](mailto:evan108108@gmail.com).

---

*4A is open-source under the Apache License 2.0. The gateway code that handles OAuth and KMS derivation is at `gateway/src/auth.ts` and `gateway/src/kms.ts` in the source repository — read it yourself if any of the above feels incomplete.*
