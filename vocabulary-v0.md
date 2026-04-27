# 4A — JSON-LD Vocabulary v0.1

**Status:** Draft (2026-04-24)
**Guiding rule:** Borrow, don't invent. Every term that can come from Schema.org comes from Schema.org. PROV-O fills the provenance gaps. 4A's own namespace only holds wire-level bits (signatures, CIDs, relay hints) that no existing vocab covers.

## Chosen terms

| Kind | Vocabulary | Term | Spec |
|---|---|---|---|
| **memory** | Schema.org | [`Observation`](https://schema.org/Observation) | schema.org/Observation |
| **claim** | Schema.org | [`Claim`](https://schema.org/Claim) | schema.org/Claim |
| **entity** | Schema.org | [`Thing`](https://schema.org/Thing) (+ subtypes: `Person`, `Organization`, `Place`, `CreativeWork`, `SoftwareSourceCode`) | schema.org/Thing |
| **relation** | Schema.org | [`Role`](https://schema.org/Role) for reified relations; bare JSON-LD properties for lightweight ones | schema.org/Role |

Why not the alternatives:
- **ActivityStreams `Note`** — social-media shaped; lacks a "what was observed" slot.
- **PROV-O `Entity`/`Activity`** — right model, wrong ergonomics; property URIs are long and the RDF vocabulary is committee-flavored. We still *borrow* `prov:wasGeneratedBy`, `prov:wasDerivedFrom`, and `prov:Agent` as provenance glue, but the primary `@type` stays Schema.org.
- **Verifiable Credentials** — heavyweight, optimized for identity attestations. A 4A claim is lighter.
- **Wikidata Q-items / property statements** — centrally assigned IDs, unusable in a federated keypair world.
- **FOAF** — superseded by Schema.org `Person`/`Organization` for practical purposes.

## Minimal examples

### memory

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Observation",
  "@id": "4a://obs/bk-QmExample...",
  "agent": {"@type": "Agent", "@id": "npub1..."},
  "observationDate": "2026-04-24T21:00:00Z",
  "observationAbout": {"@id": "https://github.com/vercel/next.js"},
  "measuredProperty": "commonPitfall",
  "value": "App Router Route Handlers cannot be statically optimized when they read cookies.",
  "prov:wasDerivedFrom": {"@id": "https://nextjs.org/docs/.../route-handlers"}
}
```

### claim

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Claim",
  "@id": "4a://claim/bk-QmExample...",
  "author": {"@id": "npub1..."},
  "datePublished": "2026-04-24",
  "about": {"@id": "https://github.com/vercel/next.js"},
  "appearance": "Next.js 15 disables static optimization for any route that reads cookies.",
  "citation": [{"@id": "4a://obs/bk-QmExample..."}]
}
```

### entity

```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": ["Thing", "SoftwareSourceCode"],
  "@id": "https://github.com/vercel/next.js",
  "name": "Next.js",
  "codeRepository": "https://github.com/vercel/next.js",
  "programmingLanguage": "TypeScript"
}
```

### relation

Lightweight (embed as property):
```json
{"@id": "4a://entity/evan", "knows": {"@id": "4a://entity/sloan"}}
```

Reified (needs provenance on the relation itself):
```json
{
  "@context": "https://4a4.ai/ns/v0",
  "@type": "Role",
  "@id": "4a://rel/bk-QmExample...",
  "roleName": "maintainer",
  "subject": {"@id": "4a://entity/tj-holowaychuk"},
  "object": {"@id": "https://github.com/expressjs/express"},
  "startDate": "2009-06",
  "prov:wasAttributedTo": {"@id": "npub1..."}
}
```

## Default `@context`

Ship a **single hosted URL**: `https://4a4.ai/ns/v0` — a static JSON-LD context document that imports Schema.org, adds the PROV-O terms we use, and defines the 4A-specific extensions below. Consumers cache once; publishers stay terse. Context is **version-pinned** (the `/v0` in the path); new terms ship as `/v1` without breaking old payloads. Operators who can't fetch remote contexts MAY inline the equivalent object — the expanded form is byte-identical.

## Extended vs. borrowed

**Taken verbatim:** `@type`, `@id`, `Observation`, `Claim`, `Thing`, `Role`, `Person`, `Organization`, `Place`, `CreativeWork`, `SoftwareSourceCode`, `agent`, `author`, `name`, `about`, `value`, `observationDate`, `measuredProperty`, `observationAbout`, `appearance`, `citation`, `datePublished`, `startDate`, `endDate`, `knows`, `codeRepository`. All from Schema.org. Plus `prov:Agent`, `prov:wasDerivedFrom`, `prov:wasGeneratedBy`, `prov:wasAttributedTo` from [PROV-O](https://www.w3.org/TR/prov-o/).

**4A-specific (`fa:` prefix → `https://4a4.ai/ns/v0#`):** `signature` (secp256k1 sig over canonical JSON), `pubkey` (hex secp256k1 pubkey), `blake3` (payload CID), `pinnedTo` (Arweave tx ID if pinned), `kind` (Nostr event kind integer), `relay` (hint URLs where a consumer is likely to find the object). These have no existing vocabulary equivalent and are wire-level, not semantic.

That's it. Everything else is Schema.org.
