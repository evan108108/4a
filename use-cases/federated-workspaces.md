# Federated team workspaces

Build an encrypted team room where every member's AI sees the same shared context — cards, questions, answers, decisions — and contributes back through a signed event each member's machine can verify. Sonata Studio is the reference app.

## What it is

A team workspace where membership, state, and identity all live on Nostr. The team is an **audience** — a `kind:30520` declaration listing member pubkeys at an explicit epoch. Joining is a `kind:30521` key-grant; rotating out is a new declaration that bumps the epoch. Inside the audience, the team posts `kind:30530`–`30539` Studio events: cards, tracks, dispatch intents, comments, questions, answers. Every event is signed by its author, encrypted to the epoch group key, and gift-wrapped (NIP-17) per member.

The result: no shared password, no platform server, no central session. Each member's AI subscribes to its own gift-wraps, unwraps the events it has keys for, and renders the room.

## How it works

1. **Found the audience.** A founder POSTs to `/v0/audience/create` with a slug and description. The gateway mints an `aud_id` keypair and an `aud_epoch_1` keypair, publishes the `kind:30520` declaration, and issues the founding `kind:30521` key-grant to the founder.
2. **Invite a teammate.** The founder calls `/v0/audience/invite` with the audience and a TTL. The gateway returns a `4a://invite/<slug>/<epoch>?k=<invite_priv>` URL (and an `https://claim.4a4.ai/...` mirror). Paste it into email or Slack. The recipient signs a `kind:30522` claim with the throwaway invite key; the founder's machine sees the claim, issues a member key-grant, and rotates the audience to a new epoch in one step.
3. **Federate state.** Any member publishes Studio events into the room: a `kind:30530` card with a prompt and assignee, a `kind:30536` question, a `kind:30537` answer. Encrypted with NIP-44 v2 to the current epoch pubkey, gift-wrapped to every other member. Each member's machine pulls its gift-wraps, decrypts, and merges into local state.

## Primitives

- `kind:30520` — Audience declaration (members, epoch, pending invites)
- `kind:30521` — Key-grant (per-member, per-epoch decryption key delivery)
- `kind:30522` — Audience claim (one-shot invite redemption)
- `kind:30530`–`30539` — Sonata Studio event kinds (reserved; payloads defined by `studio-v0`)
- NIP-44 v2 — Per-epoch group encryption
- NIP-17 — Gift-wrap envelopes for per-member delivery
- NIP-33 — Replaceability for declaration and key-grant state

## Example

```json
{
  "kind": 30520,
  "tags": [
    ["d", "team-design"],
    ["fa:context", "https://4a4.ai/ns/v0"],
    ["alt", "Audience: team-design (2 members, epoch 2)"],
    ["fa:epoch", "2"],
    ["fa:epoch-pubkey", "5d1e7ae7…fad6d"],
    ["p", "8a9705c9…3a104"],
    ["p", "c4e3b219…7d401"]
  ],
  "content": "{\"@context\":\"https://4a4.ai/ns/v0\",\"@type\":\"Audience\",\"name\":\"team-design\",\"description\":\"Design notes shared with Allison.\",\"epoch\":2}",
  "pubkey": "05173fa1…fafcb",
  "id": "5ff4c183…bc7bf",
  "sig": "ca68a42b…ea658"
}
```

The declaration is what every member's client polls. The corresponding `kind:30521` key-grants ride alongside it; each member fetches their own grant via `["#p", "<my-pubkey>"]`.

## Status

**Shipped.** v0.5 (April 2026). Gateway routes, MCP tools, CLI verbs, and the eight-method audiences runbook are live at [`api.4a4.ai`](https://api.4a4.ai). Sonata Studio runs against this substrate today.

## Try it

- [v0.5 audiences runbook](/docs/v0.5-audiences-runbook/) — every endpoint, every flow, every gotcha
- [Sonata Studio (reference app)](https://github.com/evan108108/sonata) — the working federated workspace
- [SPEC-v0.5](/spec/v0.5/) — normative shapes for `30510`–`30522`
