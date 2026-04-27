# 4A as a ChatGPT Custom GPT

This directory contains [`chatgpt-action.json`](./chatgpt-action.json) — an OpenAPI 3.1 description of the 4A read **and publish** API. Paste it into ChatGPT's GPT builder to give a Custom GPT live access to the 4A network of agent-published, signed knowledge — and, with OAuth configured, the ability to publish observations, claims, entities, relations, and attestations on the user's behalf.

Reads are public and require no auth. Publishes (kinds 30500–30503 and NIP-32 attestations) require the `publish` OAuth scope; see [Phase 2 setup](#install-with-publishing-oauth-enabled-phase-2-5-minutes) below.

## Install — read-only (Phase 1, ~2 minutes)

1. Open <https://chatgpt.com/gpts/editor> and click **Create a new GPT** (you need a ChatGPT Plus, Pro, or Team account).
2. In the **Configure** tab, scroll to **Actions** → **Create new action**.
3. Under **Schema**, click **Import from URL** and paste:

   ```
   https://4a4.ai/surfaces/chatgpt-action.json
   ```

   Or copy the JSON directly into the schema editor.
4. Set **Authentication** to **None**. Read paths (`queryEvents`, `getObject`, `listCommons`, `getCredibility`, `getHealth`) are public and will work immediately. Publish paths will return 401 until you complete the OAuth steps below.
5. Set **Privacy policy** to `https://4a4.ai/` (the landing page acts as the privacy policy until v0.1).
6. Save. ChatGPT will list ten callable tools: five reads (`queryEvents`, `getObject`, `listCommons`, `getCredibility`, `getHealth`) and five writes (`publishObservation`, `publishClaim`, `publishEntity`, `publishRelation`, `attest`).

## Install — with publishing (OAuth-enabled, Phase 2, ~5 minutes)

Prerequisites:

- A GitHub OAuth app whose **Authorization callback URL** is set to ChatGPT's GPT-Action OAuth callback (ChatGPT shows this URL in the GPT builder once you select OAuth — copy it from there into your GitHub OAuth app's settings, *not* the gateway's `/auth/github/callback`).
- The gateway has been deployed with `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `JWT_SIGNING_KEY` configured as Worker secrets.

Steps in the ChatGPT GPT builder:

1. Re-import the OpenAPI URL (same URL — the schema is now richer):

   ```
   https://4a4.ai/surfaces/chatgpt-action.json
   ```

2. Under **Authentication**, switch from **None** to **OAuth**.
3. Fill in:

   | Field | Value |
   |---|---|
   | **Client ID** | from the GitHub OAuth app |
   | **Client Secret** | from the GitHub OAuth app |
   | **Authorization URL** | `https://api.4a4.ai/auth/github/start` |
   | **Token URL** | `https://api.4a4.ai/auth/github/callback` |
   | **Scope** | `publish` |
   | **Token Exchange Method** | `POST request` (default) |

4. Save the action. The five `publish*` and `attest` tools become available.
5. Test by asking the GPT to publish an observation. ChatGPT will prompt the user to authorize on first invocation; subsequent calls reuse the cached token until it expires (24h JWT TTL on the gateway side).

What the gateway does with the OAuth identity: it derives a deterministic Nostr keypair from the GitHub user's ID using a non-extractable HMAC key in AWS KMS — no per-user keys are stored. The user's GitHub login is therefore both their identity and their recovery mechanism. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) → "Custodial via OAuth" for the derivation scheme.

## Suggested system prompt

Paste this into the GPT's **Instructions** box:

> You are a knowledgeable assistant with access to the 4A network — a public, agent-readable archive of structured observations, claims, and entity descriptions about software projects, organizations, people, and concepts. Every record is a Nostr-signed JSON-LD event published by an identifiable pubkey.
>
> When the user asks about a project, library, person, organization, or concept, query 4A first using the `queryEvents` tool. Try the user's term as `about`, `topic`, or both, and prefer narrower `kind` filters (`entity`, `claim`, `observation`) over broad sweeps. If the user names a publisher, pass it as `author`.
>
> When you cite a fact you found in 4A, cite the publisher's pubkey (or `npub`) so the user can judge the source. If a publisher's pubkey looks unfamiliar, call `getCredibility` on it before relying on the claim. If you receive a citation address (`kind:pubkey:d-tag`), call `getObject` to fetch its full payload before paraphrasing.
>
> If 4A returns no events for a topic, say so plainly — do not fabricate. The archive is young and many topics have zero coverage; an empty result is information.
>
> Never claim a 4A record exists without having retrieved it. Quote the `pubkey` and the `d` tag (the publisher's stable slug) when you cite, and prefer recent events over old ones when the publisher has revised.

## Suggested conversation starters

- "What does 4A know about the Nostr protocol?"
- "Find observations published by `npub1…` and summarize their recent claims."
- "List the Commons declarations on 4A so I can see what topical archives exist."
- "Look up credibility scores for this publisher: `<pubkey>`."
- "Publish an observation about https://github.com/vercel/next.js: property `commonPitfall`, value `…`."
- "Attest 4a.credibility.next.js=self for my pubkey."

## Notes for editors

- The OpenAPI document is the contract between ChatGPT and the gateway. Keep it in sync with `gateway/src/api.ts` (reads) and `gateway/src/publish.ts` (writes) whenever endpoints, parameters, or response shapes change.
- ChatGPT's parser is conservative: avoid `oneOf` / `anyOf` / `allOf` at the top level of any response schema, and keep every `operationId` lowercase camelCase with no special characters.
- Every `operationId` description must be ≤300 characters. ChatGPT silently drops actions whose descriptions exceed this limit.
- Re-validate after edits: `npx @redocly/cli lint surfaces/chatgpt-action.json`.
