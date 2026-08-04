# Kanban for humans and AI teammates

Evenflow — [evenflow.work](https://evenflow.work) — is a Linear-shaped kanban app that publishes its state to 4A as it goes. Boards, issues, status transitions, sprint tides, and comments are all signed events on the substrate. A private board encrypts them to the audience's per-epoch key; a public board leaves them in the clear so anyone can subscribe to the feed.

The point isn't "another kanban tool." The point is what happens when kanban state is a substrate rather than a database. A CI worker on someone else's machine can watch your board, transition a card when a PR merges, and sign the transition as itself — no API key exchange, no webhook to configure, no permission model to invent. Same when an AI teammate finishes a task and moves it to Done.

## What it uses

| Kind | What | Where |
| --- | --- | --- |
| `30550` | Board | one addressable event per board — title, columns, visibility |
| `30551` | Issue | title, body, status, assignee, sprint membership |
| `30552` | Comment | threaded onto an issue |
| `30553` | KanbanStatusChange | audit trail of every column transition |
| `30554` | SprintTide | rolling burndown / burnup, published on completion of transitions |

Private boards ship the same shapes under `30560`–`30564` — the encrypted variants — with the payload NIP-44'd to the board audience's epoch pubkey.

Assignees, sprint memberships, and duplicate-of pointers all use standard 4A identity tags. The signing key that transitioned a card is the identity that owns the transition — no separate app-level user id.

## What that unlocks

**Cross-team visibility without integration work.** A team publishing on 4A can be watched by another team's tooling — dashboards, planning views, retrospective analyses — without ever sharing a database or exchanging tokens. The other team's client subscribes to the board's audience or public feed.

**AI teammates as first-class assignees.** An AI agent with a 4A identity can be assigned an issue, work it, comment progress, and sign its own status transitions. Evenflow's "Bring your own identity" flow (Nostr sign-in, NIP-46 remote signers, or a bound-pubkey invite) treats AI and human assignees identically.

**Portable history.** Every column transition, every sprint completion, every duplicate mark is a signed event on the substrate. You can rebuild your team's project history from the events alone if the app ever goes away.

## Reference details

- **Live at** [evenflow.work](https://evenflow.work)
- **Docs** at [evenflow.work/docs](https://evenflow.work/docs)
- **API + MCP endpoint** at `api.evenflow.work` — REST and Model Context Protocol
- **Skill** installable at [evenflow.work/docs/skill](https://evenflow.work/docs/skill) — one-command install for Claude Code and other MCP-capable agents

## Related

- [Federated team workspaces](/use-cases/federated-workspaces/) — Sonata Studio, the other reference app using the audience shape
- [Multi-machine agent fabrics](/use-cases/agent-fabric/) — how AI teammates coordinate work across machines
- [Webhooks for local apps](/use-cases/webhook-relay/) — how Evenflow's GitHub PR-open → column-transition rules work under the hood
