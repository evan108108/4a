# Phase 3 v0 worked-examples test pubkeys

Three deterministic test pubkeys used to publish the SPEC §§8.1, 8.2 worked
examples on the live 4A relay set. Keys are derived as SHA-256(`<seed>`) and
treated directly as secp256k1 secret scalars.

| name  | seed (UTF-8 string)                  | pubkey (hex)                                                       | npub                                                          |
| ----- | ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| alice | `4a/phase-3/example/alice/v1` | `4f234ca09ed68824be7b50dfbba5e3b14e0006ae2749207b23de5a0b8c77782c` | `npub1fu35egy766yzf0nm2r0mhf0rk98qqp4wyayjq7ermedqhrrh0qkq7jl9pp` |
| bob   | `4a/phase-3/example/bob/v1`   | `afbb4f21dbeef3d791f05b6c26e9b7447833390a71f4a22b0f88f08799ccff64` | `npub147a57gwmamea0y0stdkzd6dhg3urxwg2w862y2c03rcg0xwvlajqmx23fv` |
| carol | `4a/phase-3/example/carol/v1` | `f5d87b6e7d06a5adb27c51ad8421503ab629c45aa851d50b0b85f6c7aaa5306d` | `npub17hv8kmnaq6j6mvnu2xkcgg2s82mzn3z64pga2zctshmv0249xpks3pcprv` |

## Reproducing

```js
import { createHash } from "node:crypto";
import { getPublicKey } from "nostr-tools";

const seed = "4a/phase-3/example/alice/v1";
const sk = new Uint8Array(createHash("sha256").update(seed).digest());
const pk = getPublicKey(sk);
```

Run `node scripts/phase-3-examples.mjs` to regenerate (idempotent — relays
deduplicate by event id, gateway addressable triples are replaceable).

## Why deterministic seeds

The 4A CLI's `keygen` subcommand is documented in the README but not yet
implemented at v0. Until it is, the worked-example fixtures use deterministic
test keys so anyone can verify the published events came from the documented
identities. Real users get fresh keys via the gateway's custodial OAuth flow
or by signing locally with their own nsec.

## Addressable triples published

- Bob claim:        `30501:afbb4f21dbeef3d791f05b6c26e9b7447833390a71f4a22b0f88f08799ccff64:next-jit-claim-1`
- Alice score:      `30506:4f234ca09ed68824be7b50dfbba5e3b14e0006ae2749207b23de5a0b8c77782c:8bb425867e51424c02bc7cc76aae6df4f138b3448fb847daeec0ad5f80b16448`
- Alice rationale:  `30507:4f234ca09ed68824be7b50dfbba5e3b14e0006ae2749207b23de5a0b8c77782c:justify-4eabeb6b`
- Carol score:      `30506:f5d87b6e7d06a5adb27c51ad8421503ab629c45aa851d50b0b85f6c7aaa5306d:4eabeb6bdb490435b511f47450efa821892e7c7112906c672001f971a2e89fe7`
- Carol rationale:  `30507:f5d87b6e7d06a5adb27c51ad8421503ab629c45aa851d50b0b85f6c7aaa5306d:justify-8c2cdeed`
