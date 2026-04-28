# 4A v0.5 — Audiences, Invites, Directory (SPEC stub)

**Status:** Draft v0.5 SPEC stub (2026-04-28). Pins normative event shapes for the design locked in [`v0.5-design.md`](./v0.5-design.md). Subject to NIP discussion.
**Convention name:** Agent-Agnostic Accessible Archive
**Version:** v0.5
**Context URL:** `https://4a4.ai/ns/v0`

## Conformance language

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) when, and only when, they appear in capitals.

## Scope

This document defines the wire shape of the v0.5 additions to 4A:

- A new addressable kind `30520` (`fa:Audience`) for audience declarations.
- A new addressable kind `30521` (`fa:KeyGrant`) for distributing per-epoch decryption keys.
- Five encrypted-variant kinds `30510`–`30514` carrying audience-addressed payloads of `Observation`, `Claim`, `Entity`, `Relation`, and `Commons`.
- A NIP-17 gift-wrap layer that conceals the audience association from relay operators.
- A new addressable kind `30522` (`fa:AudienceClaim`) carrying the off-band claim that converts a one-shot invite key into a real key-grant.
- The `4a://invite/...` URL grammar and its HTTPS twin.
- A `fa` extension key for `.well-known/nostr.json` (NIP-05) so handles can advertise audiences.
- Publish-time validator helpers the reference gateway runs against each new kind.

The v0 envelope, BLAKE3 tagging, JSON-LD `@context`, identity derivation, and public kinds (`30500`–`30504`, `30506`, `30507`) are unchanged. References to v0 in this document point at [`SPEC.md`](./SPEC.md); duplication is avoided.

The locked design — including the seven decisions in [`v0.5-design.md` § Decisions locked by this document](./v0.5-design.md#decisions-locked-by-this-document) — is the input to this stub. Decisions are not relitigated here.

## 1. Audience declaration (kind:30520)

A `kind:30520` event declares the existence and current epoch of a named audience.

### 1.1 Required tags

| Tag             | Value                                                       | Notes |
| --------------- | ----------------------------------------------------------- | ----- |
| `d`             | The audience slug (e.g. `team-design`)                      | Makes (`aud_id`, `30520`, `<slug>`) the addressable key. |
| `fa:context`    | `https://4a4.ai/ns/v0`                                      | Per [`SPEC.md` § Required tags](./SPEC.md#required-tags). |
| `alt`           | One-line summary, e.g. `"Audience: team-design (4 members, epoch 7)"` | NIP-31 fallback. |
| `fa:epoch`      | Decimal integer ≥ 1 of the current epoch                    | MUST monotonically increase across supersessions. |
| `fa:epoch-pubkey` | 32-byte hex secp256k1 pubkey of the current `aud_epoch_n` | Pubkey only; the matching private key is never on the wire. |
| `p`             | One per current member, value = member identity pubkey (32-byte hex) | Public roster, repeatable. |

### 1.2 Optional tags

| Tag             | Value                                                       | Notes |
| --------------- | ----------------------------------------------------------- | ----- |
| `fa:pending`    | `<invite_pub>:<expiration-unix>`, repeatable                | One per outstanding invite. `invite_pub` is the 32-byte hex pubkey from the invite URL; expiration is a Unix timestamp. The corresponding `invite_pub` MAY also appear as a `p` tag for filter compatibility but is NOT a real member. |
| `expiration`    | Unix timestamp                                              | NIP-40. Audiences MAY declare their own retirement window. |

### 1.3 Content

The `content` field MUST be a stringified JSON-LD object:

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Audience",
  "name": "<human-friendly name>",
  "description": "<one or two sentences>",
  "epoch": 7
}
```

The `epoch` field MUST equal the integer in the `fa:epoch` tag.

### 1.4 Signing

A `kind:30520` event MUST be signed by `aud_id` — the audience identity keypair — and MUST NOT be signed by any member pubkey. Consumers MUST reject `kind:30520` events whose `pubkey` does not match every prior version's `pubkey` for the same `d` slug; the audience identity key never rotates.

### 1.5 Replaceability

`kind:30520` is parameterized-replaceable per [NIP-33](https://github.com/nostr-protocol/nips/blob/master/33.md). The (`aud_id`, `30520`, `<slug>`) triple identifies the canonical declaration. Each membership change or epoch rotation publishes a new declaration that supersedes the previous one. Relays MAY retain history; aggregators MAY walk it for audit purposes.

### 1.6 Validators

The reference gateway MUST reject a `kind:30520` event at publish time when any of the following hold:

- A required tag is missing or malformed.
- `fa:epoch` is not a positive decimal integer.
- `fa:epoch-pubkey` is not a 32-byte hex string.
- `content.epoch` does not equal the integer in `fa:epoch`.
- The `pubkey` of the event differs from the `pubkey` of any previously-seen `kind:30520` event with the same `d`.
- A `fa:pending` tag is malformed or its expiration is in the past.

These checks are publish-time helpers, not relay-level mandates. Implementations MAY apply equivalent checks at consumption time.

## 2. Key-grant (kind:30521)

A `kind:30521` event delivers an audience epoch's private key to one recipient.

### 2.1 Required tags

| Tag             | Value                                                       | Notes |
| --------------- | ----------------------------------------------------------- | ----- |
| `d`             | `<audience-slug>:<epoch>:<recipient-hex-pubkey>`            | Composite key. Makes (`granter`, `30521`, `<d>`) unique per (granter, audience, epoch, recipient). |
| `fa:context`    | `https://4a4.ai/ns/v0`                                      | |
| `alt`           | One-line summary, e.g. `"KeyGrant: team-design epoch 7"`    | NIP-31 fallback. |
| `a`             | `30520:<aud_id-hex>:<audience-slug>` pointing at the audience declaration | Per [`SPEC.md` § Optional tags](./SPEC.md#optional-tags). |
| `fa:epoch`      | Decimal integer matching the audience declaration's current `fa:epoch` at publish time | |
| `p`             | Recipient identity pubkey (32-byte hex), exactly one        | Used by the recipient as a subscription filter. |

### 2.2 Content

The `content` field MUST be the [NIP-44 v2](https://github.com/nostr-protocol/nips/blob/master/44.md) ciphertext of the audience epoch's secp256k1 private key, encrypted from the granter's identity key to the recipient's identity key.

The plaintext that NIP-44 v2 encrypts MUST be the **raw 32-byte big-endian secp256k1 scalar** of `aud_epoch_n_priv`. Implementations MUST NOT hex-encode, base-encode, or otherwise wrap the scalar before passing it to NIP-44; the inner payload is exactly 32 bytes. This avoids decode ambiguity and matches the byte length NIP-44 v2 already pads to its smallest bucket.

The `content` field MUST NOT carry any JSON-LD; the entire 4A semantics of a key-grant are conveyed by its tags and the bare scalar.

### 2.3 Signing

A `kind:30521` event MUST be signed by an existing member of the audience (or, for the founding grant, by the audience identity key acting as the founder). The recipient MUST verify that the granter is a current member of the audience as listed on the latest `kind:30520` event before accepting the grant.

### 2.4 Replaceability

`kind:30521` is parameterized-replaceable. The composite `d` makes superseded grants harmless: re-issuing under the same `d` overwrites. After an epoch rotation, the old `(audience-slug, old-epoch, recipient)` grants remain queryable from history but are not the latest version for any current epoch.

### 2.5 Subscription pattern

A recipient discovers grants addressed to them by subscribing:

```json
["REQ", "4a-keygrants", { "kinds": [30521], "#p": ["<my-pubkey-hex>"] }]
```

On receipt the recipient: verifies the granter is a current member; NIP-44 v2-decrypts `content`; treats the resulting 32-byte scalar as `aud_epoch_n_priv`; stores it locally indexed by (`audience-slug`, `epoch`).

### 2.6 Validators

The reference gateway MUST reject a `kind:30521` event at publish time when any of the following hold:

- A required tag is missing or malformed.
- The `a` tag does not resolve to a known `kind:30520` declaration.
- `fa:epoch` does not equal the current `fa:epoch` of the referenced declaration.
- `content` is not valid NIP-44 v2 ciphertext (length, version byte, MAC failure).
- `p` does not appear as a member (`p` tag) or pending invite (`fa:pending`) on the current declaration.
- The signing pubkey does not appear as a member of the current declaration (or, for the founding grant, does not equal the audience identity pubkey).

The gateway MUST NOT attempt to decrypt `content`; ciphertext validity is verified structurally only.

## 3. Encrypted variants (kinds:30510–30514)

Kinds `30510`–`30514` carry audience-addressed payloads of the v0 public kinds:

| Encrypted kind | Public counterpart | Inner payload |
| -------------- | ------------------ | ------------- |
| 30510          | 30500              | `Observation` ([`SPEC.md` § Observation](./SPEC.md#observation-kind-30500)) |
| 30511          | 30501              | `Claim` ([`SPEC.md` § Claim](./SPEC.md#claim-kind-30501)) |
| 30512          | 30502              | `Entity` ([`SPEC.md` § Entity](./SPEC.md#entity-kind-30502)) |
| 30513          | 30503              | `Relation` ([`SPEC.md` § Relation](./SPEC.md#relation-kind-30503)) |
| 30514          | 30504              | `Commons` ([`SPEC.md` § Commons](./SPEC.md#commons-kind-30504)) |

### 3.1 Inner payload

The plaintext to be encrypted MUST be the JSON-LD `content` string the publisher would have published as the corresponding public-kind event. The shape is exactly the v0 shape; no audience-specific fields are added inside the payload. The plaintext is a UTF-8 string (the same string a public-kind event's `content` would contain), not a binary serialization.

### 3.2 Encryption

The publisher MUST encrypt the plaintext under [NIP-44 v2](https://github.com/nostr-protocol/nips/blob/master/44.md), using the publisher's identity key as the sender and the audience's current `aud_epoch_n_pub` (NOT any individual recipient pubkey) as the recipient. The resulting ciphertext is the value of the encrypted-variant event's `content` field.

NIP-44 v2 with an audience epoch pubkey as the counterparty is well-defined: the ECDH conversation key is computed against `aud_epoch_n_pub`; any holder of `aud_epoch_n_priv` can derive the same conversation key and decrypt.

### 3.3 Required tags

| Tag             | Value                                                       | Notes |
| --------------- | ----------------------------------------------------------- | ----- |
| `d`             | Same `d` slug the public-kind event would have used         | Parameterized-replaceable per `(publisher, kind, d)`. |
| `fa:context`    | `https://4a4.ai/ns/v0`                                      | |
| `alt`           | One-line summary, e.g. `"encrypted Observation in team-design"` (MUST NOT leak inner payload contents beyond the `@type` and audience slug) | NIP-31 fallback. |
| `a`             | `30520:<aud_id-hex>:<audience-slug>` pointing at the audience declaration | |
| `fa:epoch`      | Decimal integer matching the epoch the payload was encrypted to | MUST equal the audience declaration's current `fa:epoch` at publish time. |
| `p`             | Recipient member pubkey (32-byte hex), repeatable, one per current member | Used to drive per-recipient gift-wrapping in §4. |

The `blake3` tag of [`SPEC.md` § Required tags](./SPEC.md#required-tags) is REPLACED on encrypted-variant events by the BLAKE3 of the **ciphertext** `content` (with the same `bk-` + base32 encoding). This preserves the integrity-check semantics of v0 without leaking plaintext bytes; consumers who decrypt then re-verify the inner payload's own self-references as needed.

### 3.4 Signing

Encrypted-variant events MUST be signed by the publisher's identity key (the same key they would use to publish a public-kind event). They MUST NOT be signed by `aud_id` or by `aud_epoch_n_*`.

### 3.5 Replaceability

Encrypted-variant events are parameterized-replaceable per `(publisher, kind, d)`, mirroring v0. Republishing under the same `d` after an epoch rotation re-encrypts the payload to the new epoch's pubkey and updates `fa:epoch` accordingly.

### 3.6 Validators

The reference gateway MUST reject an encrypted-variant event at publish time when any of the following hold:

- A required tag is missing or malformed.
- The `a` tag does not resolve to a known `kind:30520` declaration.
- `fa:epoch` does not equal the current `fa:epoch` of the referenced declaration.
- `content` is not valid NIP-44 v2 ciphertext (length, version byte, structural checks).
- `blake3` does not match `bk-` + base32(BLAKE3(ciphertext)).
- The set of `p` tags does not match the set of `p` tags on the current declaration (the publisher MUST address every current member; missing or extra `p` tags are a publish-time error).

## 4. NIP-17 gift-wrap layer

Every encrypted-variant event published to an audience MUST be delivered as one or more [NIP-17 gift-wraps](https://github.com/nostr-protocol/nips/blob/master/17.md) (`kind:1059`), one per current member of the audience. The bare encrypted-variant event MUST NOT be published directly.

### 4.1 Wrap procedure

For each current member with pubkey `p_i`, the publisher:

1. Treats the `kind:30510`–`30514` event built per §3 as the **rumor** (an unsigned event in the NIP-59 sense; in 4A v0.5 the rumor is a fully-formed and signed encrypted-variant event whose `id` is computed normally — NIP-17 permits the rumor to be a signed event).
2. Builds a **seal** (`kind:13`) per [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md): `content` = NIP-44 v2 ciphertext of the JSON-serialized rumor, encrypted from the publisher's identity key to `p_i`. The seal carries no other tags. The seal is signed by the publisher's identity key.
3. Generates a fresh ephemeral secp256k1 keypair `(eph_priv_i, eph_pub_i)` per recipient. Ephemeral keys MUST NOT be reused across recipients or across messages.
4. Builds a **gift-wrap** (`kind:1059`): `content` = NIP-44 v2 ciphertext of the JSON-serialized seal, encrypted from `eph_priv_i` to `p_i`. Tags: exactly `[["p", "<p_i hex>"]]` and nothing else. The gift-wrap is signed by `eph_priv_i`.
5. Publishes the gift-wrap to the relay set.

The `created_at` of the gift-wrap and seal SHOULD be randomized within `created_at_real ± 86400` per NIP-59 to obscure publish timing.

### 4.2 What the wire reveals

Outside the gift-wrap envelope, only the following is visible to a relay or third-party observer:

- The gift-wrap `pubkey` is a fresh ephemeral key with no link to the publisher.
- The single `p` tag identifies one recipient.
- The `content` is opaque NIP-44 ciphertext.
- The `kind` is `1059`.

The audience slug, epoch number, payload kind (`30510`–`30514`), publisher pubkey, and member roster all live inside the seal and are not visible without `p_i`'s identity key. This is the entire point of the gift-wrap layer: an `#a:[<audience-address>]` filter against the bare encrypted-variant event would let a relay map the membership graph; gift-wrapping prevents that.

### 4.3 Why MUST and not SHOULD

The metadata-privacy gain from gift-wrapping is what makes audiences usable for anything sensitive. Allowing publishers to skip the wrap (and thereby leak the membership graph to relays) would defeat §1's privacy story for the entire audience, not just the publisher. The fan-out cost (one wrap per member) is acceptable at the audience sizes v0.5 targets (typically 2–20 members).

### 4.4 Subscription pattern

A recipient subscribes to `kinds:[1059], #p:[<my-pubkey-hex>]` and unwraps every gift-wrap landing on that subscription:

1. NIP-44 v2-decrypt `content` using `eph_pub` (carried as the gift-wrap's `pubkey`) and the recipient's identity private key. The result is a serialized seal.
2. Verify the seal's signature against its `pubkey` (the publisher's identity key).
3. NIP-44 v2-decrypt the seal's `content`. The result is a serialized rumor (the encrypted-variant event from §3).
4. Verify the rumor's signature against the same publisher pubkey.
5. Locate `aud_epoch_n_priv` for the rumor's `(a, fa:epoch)` pair. If absent, the recipient does not yet have access to this epoch and discards.
6. NIP-44 v2-decrypt the rumor's `content` using the publisher's identity pubkey and `aud_epoch_n_priv`.
7. Parse the resulting plaintext as the corresponding public-kind JSON-LD payload.

### 4.5 Validators

The reference gateway MUST reject a `kind:1059` event addressed to an audience-relevant `p` at publish time when any of the following hold:

- The gift-wrap carries any tag other than a single `p`.
- `content` is not valid NIP-44 v2 ciphertext.
- The signing pubkey is not freshly used for this gift-wrap (gateway MAY enforce by tracking pubkey reuse within a sliding window; gateway MUST NOT enforce by requiring publisher disclosure of the rumor).

The gateway MUST NOT inspect the seal or rumor; doing so would require the recipient's identity key.

## 5. Audience claim (kind:30522)

A `kind:30522` event is the off-band claim that converts a one-shot invite key into a real key-grant. It is the only 4A event signed by the throwaway `invite_priv` from an invite URL.

### 5.1 Choice of kind

This SPEC introduces a new addressable kind in the v0.5 expansion block (`30522+`) rather than reusing an ephemeral kind such as `1100`. Reasoning:

- Addressable replaceability lets a recovering invitee re-publish a claim under the same `d` if their first claim was lost, without the inviter seeing two separate claim events.
- Relay history retention for addressables gives the inviter a reliable inbox even if they were offline when the first claim was issued (ephemeral kinds may be discarded immediately).
- The composite `d` (audience slug + epoch + invite pubkey) is naturally garbage-collected: once the audience rotates past the epoch, the addressable becomes stale and is no longer the canonical version of anything.

The cost is one more reserved kind. The benefit is consistent reasoning across all v0.5 surfaces.

### 5.2 Required tags

| Tag             | Value                                                       | Notes |
| --------------- | ----------------------------------------------------------- | ----- |
| `d`             | `<audience-slug>:<epoch>:<invite-pub-hex>`                  | Composite. Makes (`invite_pub`, `30522`, `<d>`) unique. |
| `fa:context`    | `https://4a4.ai/ns/v0`                                      | |
| `alt`           | One-line summary, e.g. `"claim audience team-design epoch 1"` | NIP-31 fallback. |
| `a`             | `30520:<aud_id-hex>:<audience-slug>` pointing at the audience declaration | |
| `fa:epoch`      | Decimal integer of the epoch named in the invite URL        | MUST equal the `fa:epoch` of the declaration at the time the invite URL was generated. |
| `p`             | The inviter's identity pubkey (32-byte hex)                 | So the inviter — or any of their delegated daemons — can subscribe by `#p`. |
| `fa:claim-pubkey` | The invitee's actual identity pubkey (32-byte hex)        | The pubkey to which the inviter MUST issue the resulting key-grant. |

### 5.3 Optional tags

| Tag             | Value                                                       | Notes |
| --------------- | ----------------------------------------------------------- | ----- |
| `expiration`    | Unix timestamp                                              | NIP-40. SHOULD match the invite URL's TTL (default 7 days from invite generation). |

### 5.4 Content

The `content` field MUST be a stringified JSON-LD object:

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": "AudienceClaim",
  "audience": "<audience-slug>",
  "epoch": 1,
  "claimPubkey": "<invitee identity pubkey, 32-byte hex>",
  "note": "<short human-readable note from the invitee, optional>"
}
```

The `claimPubkey` field MUST equal the value of the `fa:claim-pubkey` tag.

### 5.5 Signing

A `kind:30522` event MUST be signed by `invite_priv` — the throwaway one-shot keypair from the invite URL. The signing pubkey MUST equal the `invite_pub` named in the audience declaration's `fa:pending` tag for the named epoch.

### 5.6 TTL and lifecycle

- The claim event SHOULD carry an `expiration` tag matching the invite URL's TTL.
- On receipt of the first valid claim, the inviter SHOULD issue a `kind:30521` key-grant to `claimPubkey` and SHOULD immediately rotate the audience to a new epoch (publishing a new `kind:30520` declaration with the pending invite pubkey removed and the invitee added as a member). Subsequent claims using the same `invite_priv` are no-ops because `invite_pub` is no longer pending.
- A claim event whose `expiration` is in the past MUST be ignored by the inviter.

### 5.7 Validators

The reference gateway MUST reject a `kind:30522` event at publish time when any of the following hold:

- A required tag is missing or malformed.
- The `a` tag does not resolve to a known `kind:30520` declaration.
- The signing pubkey does not appear as a `fa:pending` invite pubkey on the current declaration for the named epoch.
- `fa:claim-pubkey` is not a 32-byte hex string.
- `content.claimPubkey` does not equal `fa:claim-pubkey`.
- An `expiration` tag is present and in the past.

## 6. Invite URL grammar

### 6.1 Grammar

```
invite-url      = scheme "//invite/" audience-slug "/" epoch "?k=" invite-key
scheme          = "4a:" / "https://claim.4a4.ai"
audience-slug   = 1*( ALPHA / DIGIT / "-" )
epoch           = 1*DIGIT
invite-key      = bech32-string
```

The `4a://` form is the canonical wire form. The `https://claim.4a4.ai/invite/...` form is a transport convenience for surfaces that cannot register the `4a://` URL scheme; it MUST resolve to the same claim flow. `claim.4a4.ai` is a host of convenience, not a privileged authority — see §7.3.

### 6.2 Encoding of `invite_key`

The `invite-key` MUST be a [bech32](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki) string with HRP `4ainv`. The data part is the raw 32-byte big-endian secp256k1 private key. This produces strings of the form `4ainv1...`.

Reasoning for bech32 over base32 / base64url:

- Bech32 is the encoding [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md) already uses for `npub`, `nsec`, `nprofile`, and `nevent`. 4A inherits Nostr's tooling; using bech32 means existing Nostr libraries can encode and decode invite keys with their existing primitives.
- The `4ainv` HRP cannot collide with any standard Nostr HRP (`npub`, `nsec`, etc.) and cannot be mistaken for a regular Nostr key when scanned visually.
- The bech32 checksum catches single-character transcription errors, which matters because invite URLs travel over channels (email, Slack, paper) where corruption is common.

Implementations MUST reject invite URLs whose `k` parameter is not a valid `4ainv1...` bech32 string with a 32-byte payload.

### 6.3 Pending-invite lifecycle

When the inviter's client generates an invite URL, it:

1. Generates a fresh secp256k1 keypair `(invite_priv, invite_pub)`.
2. Re-publishes the audience declaration (a new `kind:30520` event) with one extra `fa:pending` tag: `["fa:pending", "<invite-pub-hex>:<expiration-unix>"]`. Default expiration SHOULD be 7 days from generation.
3. Encodes `invite_priv` as `4ainv1...` and emits both the `4a://` URL and the `https://claim.4a4.ai/...` twin.
4. Subscribes to `kinds:[30522], #p:[<inviter-pubkey>]` to watch for claim events.

When a claim arrives — or when the invite expires — the audience declaration is re-published once more with the matching `fa:pending` tag removed. The combination of `fa:pending` expirations and re-publish-on-claim bounds the window during which a leaked invite URL is useful.

Clients SHOULD treat invite URLs as bearer credentials: anyone holding the URL can claim the pending slot. Inviters SHOULD deliver invite URLs over channels appropriate to that risk model.

## 7. Directory: NIP-05 with `fa` extension

### 7.1 Lookup procedure

A 4A handle is `<name>@<host>`. To resolve, a client MUST issue:

```
GET https://<host>/.well-known/nostr.json?name=<name>
```

The request MUST be over HTTPS. The response MUST be `application/json`.

Clients MUST handle the following outcomes:

- **`200 OK` with valid JSON.** Parse per §7.2.
- **`200 OK` with malformed JSON, or non-JSON `Content-Type`.** Treat as an unresolvable handle. MUST NOT fall back to any other host.
- **`4xx`.** Treat as an unresolvable handle. The client MAY surface "no such handle on this host" to the user.
- **`5xx` or network error.** Treat as a transient resolution failure; the client MAY retry with bounded backoff. After exhausting retries, surface a transient error distinct from "no such handle."

### 7.2 Response schema

The body is the standard NIP-05 shape with an OPTIONAL `fa` extension:

```json
{
  "names": {
    "<name>": "<32-byte hex pubkey>"
  },
  "relays": {
    "<32-byte hex pubkey>": ["wss://<relay>", "..."]
  },
  "fa": {
    "<32-byte hex pubkey>": {
      "audiences": ["<audience-slug>", "..."],
      "context": "https://4a4.ai/ns/v0"
    }
  }
}
```

The `names` and `relays` keys are stock [NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md) and MUST NOT be repurposed.

The `fa` key is OPTIONAL. When present:

- It MUST be a JSON object whose keys are 32-byte hex pubkeys (matching values in `names`).
- Each value MUST be a JSON object containing at least `audiences` (a JSON array of audience slugs the named pubkey publishes to) and `context` (the 4A context URL the named pubkey uses).
- Clients MUST function with hosts that omit the `fa` key entirely — only the standard NIP-05 fields are required for handle resolution.

A client resolving `alice@example.com` to issue a key-grant SHOULD use the `fa` key (when present) to skip a round trip when discovering Alice's audiences; when absent, the client MUST proceed as if Alice publishes to no audiences (the inviter falls back to the §6 claim flow).

### 7.3 No privileged resolver

A 4A client MUST NOT hardcode `4a4.ai`, `claim.4a4.ai`, or any other host as a fallback resolver for handles whose host does not respond. There is no global 4A directory. Each `<host>` is the root of trust for handles issued under it. Clients MAY maintain a user-configured list of known hosts for handle suggestions, but MUST NOT implicitly query a host the user has not asked them to.

`4a4.ai` runs as one NIP-05 host among many. Handles like `alice@4a4.ai` resolve against `4a4.ai`'s `.well-known/nostr.json`. Handles like `bob@enginable.com` resolve against `enginable.com`'s `.well-known/nostr.json`. Neither host is privileged.

### 7.4 Validators

The reference gateway, when serving its own `.well-known/nostr.json` for `4a4.ai`-hosted handles, MUST ensure:

- Every key in `fa` also appears as a value in `names`.
- Every `audiences` entry is a syntactically valid audience slug (per §6.1's `audience-slug` rule).
- Every `context` value is exactly `https://4a4.ai/ns/v0` (or a future pinned-version URL once defined).

Clients consuming a `.well-known/nostr.json` from another host MAY apply the same checks defensively but MUST NOT reject the response solely on `fa`-shape grounds — the standard NIP-05 fields remain authoritative.

## 8. Reserved-but-unused kinds

This SPEC reserves the following kinds for future v0.5 expansion:

| Kind range  | Reserved for |
| ----------- | ------------ |
| 30523–30529 | Future v0.5 audience-side metadata events (rotation announcements, audience-scoped credibility wrappers, audience subscription endorsements). Implementations MUST NOT publish in this range until a successor SPEC defines specific semantics. |

The following ranges remain reserved as documented in [`kind-assignments.md`](./kind-assignments.md):

- 30505, 30508–30509: post-v0 public additions.
- 30515–30519: further post-v0 kinds.

## 9. Forward-compatibility note (non-normative)

[NIP-104 / MLS-on-Nostr](https://github.com/nostr-protocol/nips/blob/master/104.md) will eventually offer proper forward and backward secrecy at the group encryption layer. v0.5 deliberately encrypts to a per-epoch keypair (NIP-44 v2) rather than building on NIP-104, because NIP-104 is not yet stable enough to ship against. The v0.5 wire shape — encrypted-variant kinds in the `30510`–`30514` range, audience declaration `30520`, key-grant `30521`, gift-wrap layer `kind:1059` — is intended to be drop-in replaceable with an MLS-based encryption layer once NIP-104 stabilizes. Migration would replace §3.2 (NIP-44 v2 to `aud_epoch_n_pub`) and §2.2 (key-grant content) with the MLS welcome / commit equivalents; the JSON-LD payloads, `fa:context`, replaceability behavior, and gift-wrap layer would remain.

Counter-based rotation of OAuth-derived identity keys (sketched in [`v0.5-design.md` § 2.3](./v0.5-design.md#23-the-lose-oauth-lose-access-tradeoff)) is similarly out of scope for this SPEC; v0.5 pins the contract that an OAuth identity maps to a single 4A pubkey until rotation semantics are formalized.

Aggregator-side credibility scoring of audience members is out of scope. The `kind:30506` / `kind:30507` substrate of [`SPEC.md` § Credibility events](./SPEC.md#credibility-events) operates over public events only in v0.5; encrypted-variant credibility events are deferred to a future revision per [`SPEC.md` Appendix C](./SPEC.md#appendix-c--credibility-events-deferred-to-v1).

## 10. Compatibility

v0.5 introduces no breaking changes to the v0 wire format. The seven existing kinds (`30500`–`30504`, `30506`, `30507`) are unchanged. Existing publishers and consumers continue to work.

The new kinds are additive: a v0-only consumer that does not recognize `30510`–`30514`, `30520`, `30521`, or `30522` MUST fall back to the `alt` tag per [`SPEC.md` § Compliance levels](./SPEC.md#compliance-levels) and ignore the events. Encrypted-variant events that a consumer holds no key for are indistinguishable from gift-wraps addressed to other recipients; both are silently dropped after the gift-wrap is unwrapped.

The custodial publishing layer at `4a4.ai` accepts the new kinds without configuration changes; signing, BLAKE3 tagging, and JSON-LD context handling are identical to existing kinds. Capability-based decryption for custodial users is delivered by the gateway per [`v0.5-design.md` § 2.5](./v0.5-design.md#25-private-mode-for-everyone--capability-based-delegation) and uses the same per-request KMS-derivation window already used for signing.

## Companion documents

- [`v0.5-design.md`](./v0.5-design.md) — design rationale and the seven locked decisions
- [`SPEC.md`](./SPEC.md) — v0 normative spec (event envelope, public kinds, identity paths)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — Phase 1/2 deployment, KMS-backed derivation
- [`kind-assignments.md`](./kind-assignments.md) — kind block registry

## Change log

- 2026-04-28 — Initial v0.5 SPEC stub. Normative shapes for kinds 30510-30514, 30520, 30521, the claim event, invite URLs, and the NIP-05 `fa` extension.
