# 4A v0.5 worked-example fixtures

Ten JSON files: the events from `v0.5-design.md` §5 / `SPEC-v0.5.md` §5.5,
generated deterministically by `scripts/build-v0.5-fixtures.mjs`.

Use cases:
- driving the §5 walk-through against any compatible relay;
- regression tests that pin v0.5 wire shapes;
- the `docs/v0.5-audiences-runbook.md` curl examples.

## Deterministic seeds

Every keypair below is derived as `SHA-256("4a-v0.5-fixture:" + label)`,
so two runs produce byte-identical output. **These are NOT real production
keys** — they exist solely so humans can diff PR changes without nonce churn.

| Role | Label | Pubkey |
|---|---|---|
| aud_id | aud_id team-design | `05173fa1ee9541bcbd689cfe3d6268fdd7cc7d55c64309dd533107ca2f9fafcb` |
| aud_epoch_1 | aud_epoch_1 team-design | `5d1e7ae7f37e6fb87f89324c13a04fd2e034660c41933d356dd567b36eafad6d` |
| aud_epoch_2 | aud_epoch_2 team-design | `661b233e4487e66086e03064cf3dd401847e437784db325c19aafcf33732cdb9` |
| Evan | evan@github 12345 | `8a9705c9296b6040aeac085c9cc64a52fe3fafe5801b25ace7e98178be23a104` |
| Allison | allison@github 67890 | `62bac60891ac55c8aeaa5f556e106317eb903e9000452b587d432b9376fefb41` |
| invite_priv | invite_priv epoch1 team-design | `dd5857a114db166131d9553f6f16516ee4892a9e198dfe606f0f273b7d2e92a7` |

Audience address: `30520:05173fa1ee9541bcbd689cfe3d6268fdd7cc7d55c64309dd533107ca2f9fafcb:team-design`.

Bech32 invite key:

```
4ainv1apq56wzdptj5qldw8qk7m083qklxrl6l7q5a3etewtvp4tmurz6s7rduge
```

## Files

- [`01-declaration-v1.json`](./01-declaration-v1.json) — Audience declaration v1 — Evan as sole member
- [`02-keygrant-epoch1-evan.json`](./02-keygrant-epoch1-evan.json) — KeyGrant epoch 1 → Evan (founding grant, signed by aud_id)
- [`03-declaration-v1-pending.json`](./03-declaration-v1-pending.json) — Audience declaration v1' — pending invite added
- [`04-claim-from-invite.json`](./04-claim-from-invite.json) — Claim event from invite_priv → Evan
- [`05-declaration-v2.json`](./05-declaration-v2.json) — Audience declaration v2 — Allison joins, epoch bumped
- [`06-keygrant-epoch2-evan.json`](./06-keygrant-epoch2-evan.json) — KeyGrant epoch 2 → Evan
- [`07-keygrant-epoch2-allison.json`](./07-keygrant-epoch2-allison.json) — KeyGrant epoch 2 → Allison
- [`08-encrypted-observation.json`](./08-encrypted-observation.json) — Evan's encrypted Observation (kind:30510 rumor)
- [`09-giftwrap-to-evan.json`](./09-giftwrap-to-evan.json) — Gift-wrap of (8) addressed to Evan
- [`10-giftwrap-to-allison.json`](./10-giftwrap-to-allison.json) — Gift-wrap of (8) addressed to Allison

## Status

All ten events are produced offline by the same algorithms the gateway
uses (see `gateway/src/lib/{audience-events,nip44,sign}.ts` for canonical
TS implementations). To exercise the round-trip against the live `4a4.ai`
relay set, follow `docs/v0.5-audiences-runbook.md` — that's marked
**ready-to-run, needs Evan to execute** since this build session does not
have outbound websocket access to relays.

## Re-running

```sh
node scripts/build-v0.5-fixtures.mjs
```
