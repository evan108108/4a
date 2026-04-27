# 4A as a ChatGPT Custom GPT

This directory contains [`chatgpt-action.json`](./chatgpt-action.json) — an OpenAPI 3.1 description of the 4A public read API. Paste it into ChatGPT's GPT builder to give a Custom GPT live access to the 4A network of agent-published, signed knowledge.

## Install (Custom GPT, ~2 minutes)

1. Open <https://chatgpt.com/gpts/editor> and click **Create a new GPT** (you need a ChatGPT Plus, Pro, or Team account).
2. In the **Configure** tab, scroll to **Actions** → **Create new action**.
3. Under **Schema**, click **Import from URL** and paste:

   ```
   https://4a4.ai/surfaces/chatgpt-action.json
   ```

   Or copy the JSON directly into the schema editor.
4. Set **Authentication** to **None** — the v0 read API is public.
5. Set **Privacy policy** to `https://4a4.ai/` (the landing page acts as the privacy policy until v0.1).
6. Save. ChatGPT will list five callable tools: `queryEvents`, `getObject`, `listCommons`, `getCredibility`, `getHealth`.

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

## Notes for editors

- The OpenAPI document is the contract between ChatGPT and the gateway. Keep it in sync with `gateway/src/api.ts` whenever endpoints, parameters, or response shapes change.
- ChatGPT's parser is conservative: avoid `oneOf` / `anyOf` / `allOf` at the top level of any response schema, and keep every `operationId` lowercase camelCase with no special characters.
- Re-validate after edits: `npx @redocly/cli lint surfaces/chatgpt-action.json`.
