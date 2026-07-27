# Webhooks for local apps

Any HTTP service that speaks webhooks — GitHub, Stripe, AgentMail, Linear, anything svix-based, anything with a "send a POST when X happens" affordance — can push straight into a local app on your laptop. No tunnel, no port forwarding, no cloud service on your account, no public URL that leaks your machine's identity. Sign up for a pubkey, share a URL keyed to it, tail an SSE stream, decrypt with your priv. That's the whole thing.

## What it is

The gateway exposes two endpoints:

- `POST /v0/hook/:pubkey/:slug` — public, unauthenticated. Third parties POST here.
- `GET /v0/inbox/:pubkey/stream` — NIP-98-authenticated (path pubkey must match the auth pubkey). You subscribe here.

The relay captures the raw request body, curates a set of headers (`x-*`, `svix-*`, `*-signature`, plus `content-type` and `user-agent` — never `authorization` or `cookie`), wraps everything as a NIP-59 gift-wrap addressed to `:pubkey`, and stores it. Your subscriber tails the stream, unwraps with your private key, and forwards the payload to whatever handler your local app cares to write.

**Trust model.** The relay sees the plaintext at ingress — unavoidable, since third parties can't gift-wrap to you — but never has your private key, and never persists more than the retention window (7 days). The real authenticity check is the third party's own signature (HMAC, Svix, etc.) verified in your local app against the per-hook secret you set with the third party. Compromise of the relay exposes only whatever plaintext transited during the window; it can't forge deliveries.

**Body cap** 64 KiB. **Rate limits** 60 requests/hour per (pubkey, slug) AND per source IP. **Retention** 7 days on the DO. **Byte preservation** end-to-end: raw request bytes flow base64-encoded through the wrap's inner rumor, decoded at your app, so HMAC signatures verify against the same bytes the sender signed.

## How it works

1. **Pick a pubkey and a slug.** Any 32-byte hex pubkey you can sign for. Slugs are per-third-party (`github`, `stripe-billing`, `agentmail`). Copy the URL — `https://api.4a4.ai/v0/hook/<pubkey>/<slug>` — into the third party's dashboard.
2. **Subscribe to your inbox.** Your local app opens a long-lived streaming fetch to `https://api.4a4.ai/v0/inbox/<pubkey>/stream` with NIP-98 headers signed by the matching private key. The gateway delivers gift-wraps via SSE with a 2-second live-tail cadence.
3. **Unwrap and route.** For each gift-wrap, unwrap with your priv (kind:1059 → seal → rumor). The rumor's `content` is a JSON envelope: `{received_at_ms, source_ip, headers, body_b64, slug}`. Base64-decode the body, verify the third party's signature over the exact bytes, and hand off to whatever handler you wrote for this slug — dispatch a worker, store to memory, DM someone, log, whatever.

## Minimal client

Roughly 60 lines of TypeScript. Uses [nostr-tools](https://www.npmjs.com/package/nostr-tools) for NIP-44 + NIP-98 and [@noble/hashes](https://www.npmjs.com/package/@noble/hashes) for the rumor-id check. Copy, fill in your priv, run under Node 20+ or Bun.

```ts
// npm i nostr-tools @noble/hashes
import { nip44, nip98, getPublicKey, finalizeEvent } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

interface Hook {
  slug: string;
  body: Uint8Array;                     // exact raw bytes the sender signed
  headers: Record<string, string>;
  receivedAtMs: number;
  sourceIp: string | null;
  wrapEventId: string;                  // rumor id — your dedup key
}

async function* subscribe(priv: Uint8Array, gateway = 'https://api.4a4.ai'): AsyncGenerator<Hook> {
  const pub = getPublicKey(priv);
  const url = `${gateway}/v0/inbox/${pub}/stream`;
  const auth = await nip98.getToken(url, 'GET', t => finalizeEvent(t, priv), true);

  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok || !res.body) throw new Error(`inbox stream failed: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!raw.startsWith('event: gift-wrap')) continue;
      const data = raw.match(/^data: (.+)$/m)?.[1];
      if (!data) continue;

      // Unwrap: gift-wrap (kind:1059) → seal (kind:13) → rumor (kind:1069)
      const { wrap_event: wrap } = JSON.parse(data);
      const seal = JSON.parse(nip44.v2.decrypt(wrap.content,
        nip44.v2.utils.getConversationKey(priv, wrap.pubkey)));
      const rumor = JSON.parse(nip44.v2.decrypt(seal.content,
        nip44.v2.utils.getConversationKey(priv, seal.pubkey)));

      // Verify the rumor's id — makes wrapEventId trustworthy for dedup
      const canonical = JSON.stringify([0, rumor.pubkey, rumor.created_at, rumor.kind, rumor.tags, rumor.content]);
      if (bytesToHex(sha256(new TextEncoder().encode(canonical))) !== rumor.id.toLowerCase()) continue;

      const slug = rumor.tags.find((t: string[]) => t[0] === 'fa:hook')?.[1];
      if (!slug) continue;  // not a hook wrap
      const content = JSON.parse(rumor.content);
      yield {
        slug,
        body: Uint8Array.from(atob(content.body_b64), c => c.charCodeAt(0)),
        headers: content.headers ?? {},
        receivedAtMs: content.received_at_ms,
        sourceIp: content.source_ip ?? null,
        wrapEventId: rumor.id,
      };
    }
  }
}

// ── Usage ─────────────────────────────────────────────────────────────
const priv = hexToBytes(process.env.MY_PRIV_HEX!);  // 32-byte private key
for await (const hook of subscribe(priv)) {
  console.log(`[${hook.slug}] ${hook.body.length} bytes from ${hook.sourceIp}`);
  // At this point YOU verify the sender's signature over hook.body.
  // e.g. GitHub: HMAC-SHA256(hook.body, secret) === hook.headers['x-hub-signature-256']
  //     Svix:  see https://docs.svix.com/receiving/verifying-payloads
}
```

**Not shown, worth adding for production:**
- Reconnect with exponential backoff on stream close
- Persist `wrapEventId` (or a `sinceUnix` cursor) so a restart doesn't miss deliveries in flight
- Dedup on `wrapEventId` — the same wrap may replay if you reconnect within the retention window
- The third-party signature verification — the whole point; every provider is different

Sonata's plugin at [`plugins/4a-webhook-relay/`](https://github.com/evan108108/sonata/tree/main/plugins/4a-webhook-relay) has all of these if you want a fuller reference.

## Reference implementation

Sonata — a personal AI runtime — uses this to receive AgentMail webhooks. Real email arrives from Gmail → AgentMail → Svix-signed POST to 4a → gift-wrap addressed to Sonata's plugin → SSE decrypt on Sonata's laptop → dispatched to the email routing chain. **Median latency ~3 seconds** end-to-end. Before webhooks, Sonata polled AgentMail every 120s (average latency ~60s). The whole stack — a dedicated 4a-webhook-relay plugin, a Sonata core `WebhookRouter` with signature verifiers for `none`/`bearer`/`hmacSha256`/`svix`, a Settings UI for adding new routes, an audit log — is documented at [`Sonata/docs/webhook-routes.md`](https://github.com/evan108108/sonata/blob/main/docs/webhook-routes.md).

The reference is ~4,500 lines of Swift, TypeScript, and tests. But the endpoints are protocol-level. You can wire the same URL into a CLI receiver, a browser extension pushing into your dev machine, a docker container listening on a Raspberry Pi, or any other client that can do a Nostr unwrap.

## Compared to

- **ngrok / Cloudflare Tunnel.** Different problem. Tunnels expose your localhost to the internet. This buffers webhooks for you and delivers them E2E-encrypted when your app is online. Your machine can be offline — deliveries queue on the relay for the retention window. No inbound port ever opens on your side.
- **Smee (GitHub's dev proxy).** Smee is a plain relay, unencrypted. This is Smee if Smee did NIP-59 and gave you an identity you own.
- **Svix (as a receiver).** Svix runs webhook infrastructure for senders; this runs it for receivers. Complements, doesn't compete.

## Primitives

- `POST /v0/hook/:pubkey/:slug` — public ingress
- `GET /v0/inbox/:pubkey/stream` — authenticated SSE tail
- NIP-59 gift-wrap (kind:1059) — encrypted envelope
- NIP-98 — HTTP-request-signing for the stream endpoint
- Inner rumor kind:1069 with `["fa:hook", slug]` tag — the format for hook payloads

## Also see

- The [specification](/spec/) for wire shapes
- Sonata's [`webhook-routes.md`](https://github.com/evan108108/sonata/blob/main/docs/webhook-routes.md) — full walkthrough of a local-side implementation: route CRUD, signature verifiers, destination dispatch, debugging
