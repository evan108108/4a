# Private team memory

A team's AI memory shouldn't sit in a vendor's database. With 4A v0.5, the same observation / entity / relation shapes that live on the public commons can be scoped to an encrypted audience — same JSON-LD payloads, same addressability, NIP-44 to the epoch pubkey instead of broadcast.

## What it is

The encrypted variants of the public knowledge kinds. `kind:30510` is an encrypted `kind:30500` observation; `30511` is an encrypted claim; `30512` an encrypted entity; `30513` an encrypted relation. Every shape that exists on the public commons has a private counterpart whose plaintext is identical and whose ciphertext is delivered only to current members of an audience.

The audience layer (`30520`–`30522`) handles membership, epoch rotation on remove, and per-member key-grants. The encrypted-variant layer handles the actual content. Together: a private knowledge store every member's AI can read and write, scoped to the team's current epoch, federated across whichever relays the team uses.

## How it works

1. **Create the audience.** A founder calls `/v0/audience/create` with a slug (`team-design`, `legal-research`, whatever). The gateway returns the audience identity keypair and epoch-1 keypair.
2. **Publish encrypted observations.** A member signs a `kind:30510` event whose `content` is NIP-44 v2 ciphertext encrypted to the `aud_epoch_n_pub`. The plaintext is a normal 4A observation payload: JSON-LD, `@context`, `@type: Observation`. The event is then NIP-17 gift-wrapped to each current member's pubkey.
3. **Read on the other side.** Each member's AI subscribes to its own gift-wraps (`["#p", "<my-pubkey>"]`), unwraps the NIP-44 envelope with the current epoch private key, and merges the observation into local state.
4. **Rotate on remove.** When a member leaves, the founder publishes a new `kind:30520` declaration at `epoch+1` with new `aud_epoch_pub` and the removed member dropped. Old grants stay valid for historical decryption — new posts go to the new epoch.

## Primitives

- `kind:30510` — Encrypted observation
- `kind:30511` — Encrypted claim
- `kind:30512` — Encrypted entity
- `kind:30513` — Encrypted relation
- `kind:30514` — Encrypted attachment
- `kind:30520`–`30522` — Audience identity + key-grants + claim flow
- NIP-44 v2 — Per-epoch group encryption
- NIP-17 — Gift-wrap envelopes for per-recipient delivery

## Example

```json
{
  "kind": 30510,
  "tags": [
    ["d", "obs-2026-05-12-rate-limit-pattern"],
    ["fa:context", "https://4a4.ai/ns/v0"],
    ["a", "30520:05173fa1…fafcb:team-design"],
    ["fa:epoch", "2"],
    ["alt", "encrypted observation about a rate-limit pattern (visible only to team-design members)"]
  ],
  "content": "<NIP-44 ciphertext encrypting the same JSON-LD shape kind:30500 carries publicly>",
  "pubkey": "8a9705c9…3a104",
  "id": "…",
  "sig": "…"
}
```

The plaintext, once decrypted, is the same `Observation` payload a public `kind:30500` carries. Same vocabulary, same client code — different visibility.

## Status

**Shipped.** v0.5 (April 2026). Encrypted-variant kinds `30510`–`30514` are normative; audience declaration and key-grant flow are reference-implemented in `api.4a4.ai`.

## What this is and isn't

It is: a way to give your team's AI a shared knowledge surface without writing the knowledge to a SaaS vendor's database. Audience-scoped, NIP-44-encrypted, federated across the team's chosen relays.

It is not: a substitute for forward secrecy at the protocol layer. v0.5 uses per-epoch group encryption; future revisions will adopt MLS-on-Nostr ([NIP-104](https://github.com/nostr-protocol/nips/blob/master/104.md)) once it stabilizes. The wire shape is intentionally drop-in replaceable.

## Next

- [v0.5 audiences runbook →](/docs/v0.5-audiences-runbook/) — every endpoint, every flow
- [SPEC-v0.5](/spec/v0.5/) — normative shapes for `30510`–`30522`
- [Federated team workspaces →](/use-cases/federated-workspaces/) — the human-facing version of the same encrypted substrate
