# Cross-org attestation

A score from `alice@safety.lab` should mean something specific, and the verification should be portable. The NIP-05 `fa` extension carries scorer policy; signed claims any party can audit travel with the event itself. No platform owns the attestation graph.

## What it is

A way to publish verified claims that span organizations. An attestation is the standard 4A claim/score/rationale triple — but with a verified scorer identity attached via the NIP-05 `fa` extension. Alice publishes a `nip05.json` at her domain declaring herself a registered scorer in a credential domain (e.g. `safety`). Aggregators (or any consumer) fetch the JSON, verify the pubkey match, and apply policy: "weight scores from `safety`-domain scorers higher" or "require at least one `safety`-domain rationale on every claim about model behavior."

The whole graph is auditable. Every score is signed by a known pubkey. Every paired rationale spells out the methodology. The NIP-05 record names the scorer's identity domain. A third-party auditor with no inside access can read the relay history and reconstruct the verification chain end-to-end.

## How it works

1. **Publish a NIP-05 record.** Alice serves `https://safety.lab/.well-known/nostr.json` with her pubkey and a `fa` extension naming the credential domains she's registered in: `{ "names": { "alice": "<pub-hex>" }, "fa": { "scorer": { "domains": ["model-safety", "evals"] } } }`.
2. **Sign claims and scores.** Alice publishes a `kind:30506` score with paired `kind:30507` rationale on a claim her work bears on. The score event carries Alice's `pubkey`; aggregators that care about `fa:scorer` look up the NIP-05 record at her domain.
3. **Audit.** A regulator, a board, a downstream aggregator — anyone with internet access — fetches Alice's NIP-05 record, walks her recent `kind:30506` events from the relay set, and reconstructs the attestation chain. Every step is a signed event with a paired rationale they can read.

## Primitives

- NIP-05 + `fa` extension — Identity policy (which scorer domains a pubkey belongs to)
- `kind:30501` — Claim being attested
- `kind:30506` — Score (the attestation)
- `kind:30507` — Rationale (the audit trail)
- Aggregator reference impl — Non-normative; applies policy across scorer domains

## Example NIP-05 record

```json
{
  "names": {
    "alice": "4f234ca0…7782c"
  },
  "relays": {
    "4f234ca0…7782c": ["wss://relay.4a4.ai", "wss://relay.safety.lab"]
  },
  "fa": {
    "scorer": {
      "domains": ["model-safety", "evals"],
      "issued_at": 1777300000,
      "expires_at": 1808836000
    }
  }
}
```

Paired with one of Alice's `kind:30506` events, this is enough for an aggregator to weight her score under a `model-safety` domain policy and for an auditor to verify the chain.

## Status

**Shipped (substrate).** v0 credibility events (`30506`/`30507` with paired rationale) and the NIP-05 `fa` extension are normative as of April 2026. Aggregator-side policy (which domains get what weight) is non-normative — different aggregators will reach different rankings; both are valid as long as the inputs are auditable.

## Why this is different from a centralized auditor

A centralized auditor publishes verdicts; a 4A attestation graph publishes the inputs to verdicts. Anyone can rerun the aggregation with different weights. Anyone can challenge a specific score by publishing a `kind:30507` rationale of their own. Anyone can verify a NIP-05 record from a clean machine without an account on any platform. Trust degrades gracefully — disagreement is visible and threaded, not erased and re-litigated in private.

## Next

- [Credibility — Attestations](/spec/credibility/attestations/) — research that produced this design
- [Phase 3 runbook →](/docs/phase-3-credibility-runbook/) — operational guide for paired scoring
- [AI peer-review networks →](/use-cases/peer-review/) — the same primitives, applied to AI-on-AI review
