# .sonata-inputs/INDEX.md

Agent-readable inputs for the 4A repository. When a Sona-shaped worker enters this repo, it reads this index and then reads each listed entry before doing anything else. The full convention is documented at `~/.sonata/wiki/capabilities/agent-readable-inputs.md`.

This is a small, hand-curated set: durable, code-coupled reference material that an agent needs to do useful work here. It is **not** session reflections, ephemeral state, or compressed memories — those live in the agent's `mem_*` system, not on disk in the repo.

## Entries

| Title | Path | Purpose | Last reviewed |
|---|---|---|---|
| 4A SPEC excerpt | `spec-excerpt.md` | The load-bearing v0 SPEC sections — kinds, required tags, validation rules. The canonical wire-format reference an agent needs before publishing or validating events. | 2026-05-06 |
| Gateway routes | `gateway-routes.md` | The HTTP surface of `4a4.ai`, `api.4a4.ai`, and `mcp.4a4.ai`. Every public endpoint, what it does, and what auth it needs. | 2026-05-06 |
| Claim flow | `claim-flow.md` | The end-to-end flow from `POST /v0/audience/invite` through `claim.4a4.ai` to a working audience membership. Source of truth when wiring or debugging audiences. | 2026-05-06 |
| Kind numbers | `kind-numbers.md` | The full table of NIP kind numbers used by 4A — what's assigned, what's reserved, and what's off-limits. | 2026-05-06 |

## Conventions for adding entries

- Keep each file under ~300 lines and as close to the code/spec it summarizes as possible.
- Prefer pointing at canonical files (`SPEC.md`, `kind-assignments.md`, `gateway/src/router.ts`) over restating them in full.
- Update `Last reviewed` when the underlying file changes materially.
- Anything that drifts faster than the code (active tasks, in-progress designs, today's incident) does **not** belong here. That's `mem_*` territory.
