# Encrypted URL-shareable artifacts

Any HTML page, small image, JSON dashboard, PDF-style report, or self-contained interactive tool can become a URL you paste to a person and they open. The gateway stores ciphertext, serves ciphertext, and can't read what it's carrying. The decryption key rides in the URL fragment — which browsers never send to servers — so anyone with the URL can view the content, and nobody without it can. No accounts, no login, no moderation surface. Losing the URL loses access; sharing it shares access. The exact semantics you already know from Dropbox share-links, Cryptpad, PrivateBin.

## What it is

The gateway exposes four endpoints:

- `POST /v0/artifacts/manifest` — publish a signed `kind:30540 fa:ArtifactManifest` binding a ciphertext blob to a display slug.
- `POST /v0/artifacts/revoke` — publish a signed `kind:5` (NIP-09) to take an artifact down. `["e", <manifest-id>]` revokes a specific version; `["a", "30540:<pubkey>:<slug>"]` revokes every version at that slug.
- `GET /v0/artifacts/<sha256>` — frozen render: this exact ciphertext, forever. Loads a viewer shell that reads `#k=` from the URL fragment, fetches ciphertext from Blossom, decrypts with AES-256-GCM, and mounts the plaintext into a sandboxed iframe.
- `GET /v0/artifacts/<pubkey>/<slug>` — latest render: resolves to whichever manifest was most recently published under `(pubkey, slug)`. Perfect for a dashboard that gets refined.

Ciphertext upload piggybacks on the existing Blossom endpoints — `PUT /blossom/upload` with a BUD-01 signed auth event, first-upload-wins semantics on the sha256 (attribution can't be hijacked by re-uploading someone else's ciphertext). The manifest publish enforces that the signer of the manifest equals the Blossom uploader of the referenced blob.

**Trust model.** The gateway never learns plaintext because it never learns the key. Fragments (`#k=...`) are a browser-specified guarantee: they are visible to JavaScript running on the page, but they are not included in HTTP requests to the origin. Metadata that IS visible to the gateway operator: which sha256es are fetched, from which source IPs. Content-agnostic; if that matters, a Tor-facing mirror is the escalation path. If a URL leaks, the leak-holder can view; the fix is `POST /v0/artifacts/revoke` — the frozen and latest URLs both serve `410 Gone` with attribution within the edge cache TTL (~30s).

**Limits.** Blob size 256 MiB per upload / 1 GiB per pubkey quota. Manifest publish rate-limited 60/hour per authenticated pubkey. Revoke rate-limited 60/hour per pubkey. Both `frozen_url` and `latest_url` are cached for 30 seconds at the edge; revoke propagates in under a minute.

## How it works

1. **Encrypt client-side.** Generate a fresh 32-byte AES-256-GCM key `K` per artifact slug (reuse `K` across republishes of the same slug so old links keep working — never rotate; invalidate via kind:5 instead). Encrypt with a 12-byte random IV. The wire format is `IV || ciphertext+tag` — single-shot, no chunking.
2. **Upload the ciphertext.** `PUT /blossom/upload` with a signed BUD-01 `kind:24242` auth event. Server returns the sha256; store it for the manifest.
3. **Publish the manifest.** Sign a `kind:30540 fa:ArtifactManifest` event with tags `["d", <slug>]`, `["blob", <sha256>]`, `["type", <content-type>]`, optional `["title", ...]`, required `["alt", ...]`, `["blake3", <bk-encoded content hash>]`. POST to `/v0/artifacts/manifest`.
4. **Share the URL.** Compose `https://api.4a4.ai/v0/artifacts/<sha256>#k=<base64url(K)>` (frozen) or `https://api.4a4.ai/v0/artifacts/<pubkey>/<slug>#k=<base64url(K)>` (latest). The `#k=` fragment never leaves the browser.
5. **Recipients open the URL.** The viewer shell reads `#k=`, fetches `/blossom/<sha256>`, decrypts with `crypto.subtle.decrypt`, and renders the plaintext into a sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`) — opaque origin, DOM-isolated from the shell. Attribution chrome shows the signer's pubkey.
6. **Revoke when you want it gone.** Sign a `kind:5` and POST to `/v0/artifacts/revoke`. Both URL shapes return `410 Gone` with a publisher-attributed page. Kind:5 is address-time-scoped per NIP-09, so republishing the same slug later un-revokes it.

## Minimal client

Roughly 60 lines of TypeScript. Uses [nostr-tools](https://www.npmjs.com/package/nostr-tools) for schnorr signing and [@noble/hashes](https://www.npmjs.com/package/@noble/hashes) for sha256 and BLAKE3. Copy, fill in your priv, run under Node 20+ or Bun.

```ts
// npm i nostr-tools @noble/hashes @noble/ciphers @scure/base
import { getPublicKey, finalizeEvent } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2';
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { base32nopad } from '@scure/base';
import { webcrypto } from 'node:crypto';

const GATEWAY = 'https://api.4a4.ai';

async function publish(priv: Uint8Array, opts: {
  content: Uint8Array;                  // your raw plaintext (HTML, PNG, JSON, …)
  contentType: string;                  // 'text/html' | 'image/png' | 'application/json' | …
  slug: string;                         // your stable per-artifact d-tag (^[A-Za-z0-9_-]{1,64}$)
  key: Uint8Array;                      // 32 random bytes; reuse across republishes of `slug`
  title?: string;
}) {
  const pub = getPublicKey(priv);

  // 1. Encrypt: IV(12) || ciphertext+tag
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await webcrypto.subtle.importKey('raw', opts.key, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, opts.content));
  const blob = new Uint8Array(12 + ct.length); blob.set(iv, 0); blob.set(ct, 12);
  const sha = bytesToHex(sha256(blob));

  // 2. BUD-01 signed upload
  const now = Math.floor(Date.now() / 1000);
  const auth = finalizeEvent({ kind: 24242, created_at: now, content: 'Upload',
    tags: [['t','upload'], ['x', sha], ['expiration', String(now + 600)]] }, priv);
  const up = await fetch(`${GATEWAY}/blossom/upload`, { method: 'PUT',
    headers: { 'Content-Type': opts.contentType,
      'Authorization': `Nostr ${btoa(JSON.stringify(auth))}` }, body: blob });
  if (!up.ok) throw new Error(`upload ${up.status}: ${await up.text()}`);

  // 3. Sign + publish the kind:30540 manifest
  const content = JSON.stringify({ '@context': 'https://4a4.ai/ns/v0',
    '@type': 'ArtifactManifest', contentType: opts.contentType, encryption: 'aes-256-gcm' });
  const tags: string[][] = [['d', opts.slug], ['blob', sha], ['type', opts.contentType]];
  if (opts.title) tags.push(['title', opts.title]);
  tags.push(['alt', `Public artifact: ${opts.title ?? opts.slug} (${opts.contentType})`]);
  tags.push(['blake3', `bk-${base32nopad.encode(blake3(new TextEncoder().encode(content))).toLowerCase()}`]);
  tags.push(['fa:context', 'https://4a4.ai/ns/v0']);
  const manifest = finalizeEvent({ kind: 30540, created_at: now, tags, content }, priv);
  const pub_ = await fetch(`${GATEWAY}/v0/artifacts/manifest`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: manifest }) });
  if (!pub_.ok) throw new Error(`manifest ${pub_.status}: ${await pub_.text()}`);
  const { frozen_url, latest_url } = (await pub_.json()) as any;

  // 4. Compose the shareable URLs (the #k= fragment stays on the client forever)
  const k = Buffer.from(opts.key).toString('base64url');
  return { sha256: sha, frozenURL: `${frozen_url}#k=${k}`, latestURL: `${latest_url}#k=${k}` };
}
```

**Not shown, worth adding for production:**
- **Key stability per slug.** Keep a `(slug → K)` table locally. Reuse `K` across republishes so shared latest-URLs keep decrypting; never rotate within a slug. If you want to burn all previously-shared URLs, publish a `kind:5` a-tag revocation — real `410 Gone`, not decrypt-to-garbage.
- **Idempotent re-upload.** Blossom is first-upload-wins on sha256. Re-uploading identical ciphertext by the original signer is a fast no-op 200.
- **A revoke primitive.** `POST /v0/artifacts/revoke` with a signed kind:5. `["e", event.id]` revokes a specific version; `["a", "30540:<pubkey>:<slug>"]` revokes the slug.
- **Content-type discipline.** The viewer shell renders `text/html` / `image/*` / `text/plain` / `application/json` natively. Anything else falls back to a "Download artifact" link. Pick your allowlist upstream.

Sonata's plugin at [`plugins/sonata-studio/src/actions/artifact.ts`](https://github.com/evan108108/sonata/blob/main/plugins/sonata-studio/src/actions/artifact.ts) has all of these, plus a per-slug in-process mutex around K mint that closes a concurrent-publish race, entity+secret persistence, and full 17-scenario vitest coverage.

## Reference implementation

Sonata — a personal AI runtime — uses this as its "here's a URL" primitive. The user asks Sona to "publish this as a public artifact"; Sonata's sonata-studio plugin encrypts client-side, uploads via Blossom, signs the manifest, and hands back the URL. A **Personal → Public Artifacts** panel in Studio lists everything the user has published, with copy-URL, open-in-browser, revoke, and read-only attribution details. The stack — plugin actions (`studio_artifact_publish/list/revoke`), a Swift `StudioArtifactsView` in Sonata's Studio sidebar, per-dTag key persistence in the plugin's secret store — is documented in the [Public Artifacts Studio-client plan](https://github.com/evan108108/sonata/blob/main/plugins/sonata-studio/README.md).

The reference is a few thousand lines of TypeScript + Swift + tests. But the endpoints are protocol-level. You can wire the same primitive into a CLI (`artifact publish ./dashboard.html`), a VS Code extension ("right-click → publish as public artifact"), a static-site builder shipping ephemeral preview URLs per PR, or any other client that can encrypt bytes and sign a Nostr event.

## Compared to

- **Dropbox / Google Drive share-links.** The provider can read the content, and the URL is tied to an account they can suspend. This has neither property. Compare posture, not features.
- **Cryptpad / PrivateBin.** Same fragment-key model; those apps run it on their own substrate with their own text/document primitives. 4A gives you a Nostr-shaped substrate, signed attribution, and portable identity across any client — but you bring your own document type.
- **GitHub Gists / Pastebin.** Public and unencrypted; account-tethered. This is closer to "unlisted Gist with the anonymity guarantee actually being enforced."
- **Blob storage + hand-rolled S3 bucket.** You could. You'd also do the encryption, the key derivation, the revocation semantics, the viewer shell, the sandboxed iframe. Or you could not.

## Primitives

- `POST /v0/artifacts/manifest` — publish (signed event is the auth)
- `POST /v0/artifacts/revoke` — kind:5 NIP-09 revocation
- `GET /v0/artifacts/<sha256>` — frozen render, 30s cache
- `GET /v0/artifacts/<pubkey>/<slug>` — latest render, 30s cache
- `PUT /blossom/upload` — BUD-01 signed ciphertext upload
- `GET /blossom/<sha256>` — ciphertext fetch (immutable, long cache)
- `kind:30540 fa:ArtifactManifest` — the publish event (parameterized-replaceable)
- `kind:5` — the deletion event (per NIP-09)
- Fragment-key URL model — `#k=<base64url(32 random bytes)>`, never sent to any server
- Sandboxed iframe with CSP `default-src 'none'; script-src 'self' 'unsafe-inline'; …` — DOM-isolated from the shell

## Also see

- The [specification](/spec/) for event shapes and validation rules
- The [Sonata Studio client](https://github.com/evan108108/sonata/tree/main/plugins/sonata-studio) — full walkthrough of a personal-runtime implementation: plugin actions, Swift UI, key persistence, tests
- [Webhooks for local apps](/use-cases/webhook-relay/) — sibling substrate feature, same "4a as a low-trust encrypted transport" pattern
