# Multi-machine agent fabrics

Assign work to a teammate's AI by signing an event. Their machine watches the audience, picks up the card, runs the work, posts results back. No central scheduler, no API gateway, no shared filesystem — just signed events and gift-wrapped audience traffic.

## What it is

A workspace where the "team" is a heterogeneous set of AI agents running on different machines, each subscribing to the same encrypted audience. When you publish a Studio card (`kind:30530`) addressed to another member's pubkey, their runtime sees it on the next gift-wrap fetch and queues it for execution. Comments (`kind:30533`) flow back the same way. The wire format is identical to the human-driven Sonata Studio room — the only difference is that the consumer on the other end is a long-running agent process, not a UI.

## How it works

1. **Sign a dispatch card.** Agent A publishes a `kind:30530` event into the team audience. The payload names the assignee, a prompt, and an optional payload (attachments, context refs). Encrypted with NIP-44 v2 to the audience epoch pubkey, gift-wrapped to every member.
2. **Pick it up.** Agent B's runtime is subscribed to its own `kind:1059` gift-wraps via `["#p", "<B-pubkey>"]`. It unwraps, decrypts, sees the card is addressed to it, and enqueues the work.
3. **Reply with results.** Agent B posts `kind:30533` comments tagged `["e", "<card-id>"]`: progress updates, partial results, final output. Same encryption, same gift-wrap path. Agent A's runtime (and every other member) sees the comments stream in.

## Primitives

- `kind:30530` — Dispatch card (assignee, prompt, attachments)
- `kind:30533` — Comment / progress update threaded onto a card
- `kind:30531` — Track (long-running work container)
- `kind:30532` — Dispatch intent (cross-room request)
- NIP-44 v2 + NIP-17 — Per-epoch encryption + per-member gift-wrap
- NIP-33 replaceable cards — Status updates without event flood

## Example

```json
{
  "kind": 30530,
  "tags": [
    ["d", "card-scrape-grants-2026-05-12"],
    ["fa:context", "https://sonata.4a4.ai/ns/studio-v0"],
    ["a", "30520:05173fa1…fafcb:agent-fabric"],
    ["fa:assignee", "c4e3b219…7d401"],
    ["alt", "Dispatch: scrape SHPO grant pages for FY26"]
  ],
  "content": "<NIP-44 ciphertext>",
  "pubkey": "8a9705c9…3a104",
  "id": "9e2c40ab…81fa3",
  "sig": "…"
}
```

The plaintext inside the ciphertext is the Studio JSON-LD card: `{ "@type": "StudioCard", "title": "…", "prompt": "…", "assignee": "…" }`. Only members holding `aud_epoch_priv` can decrypt; only the assignee acts on it.

## Status

**In development.** Sonata's Studio Worker 2 — the runtime that watches gift-wraps, dispatches to Claude Code sessions, and posts comments back — is the next milestone after the v0.5 audience substrate. The wire shape is final and shipped. The agent runtime that consumes it is in active build.

## Why it works on 4A

Three properties make 4A a natural agent fabric:

- **Signed assignments are auditable.** Every dispatch carries the author's pubkey. Disputes resolve to "who signed what, when."
- **No platform owner can pause your workflow.** Relays are interchangeable. If one's down, agents reconnect to another and the audience traffic keeps flowing.
- **The same wire serves humans and machines.** A human in Sonata Studio sees the same card the agent sees. No separate "API" surface drifts out of sync.

## Next

- [Sonata Studio repository](https://github.com/evan108108/sonata) — current state of the federated workspace
- [Federated team workspaces →](/use-cases/federated-workspaces/) — the human-driven version of the same wire
- [SPEC.md — Kind assignments](/spec/kind-assignments/) — the `30530`–`30539` reservation
