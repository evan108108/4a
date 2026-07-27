// Webhook-relay gateway tests — `POST /v0/hook/:pubkey/:slug` ingress and
// `GET /v0/inbox/:pubkey/stream` auth gates.
//
// Plan verification contract:
//   - body > 64 KiB → 413.
//   - 61st request in the window → 429 (rateLimitCheck, 60/hr).
//   - header forwarding is pattern-based; auth/cookie/x-forwarded-* never pass.
//   - byte preservation: posted body round-trips through the stored wrap
//     byte-for-byte, and a provider HMAC computed over the original bytes
//     verifies against the decoded copy.
//   - inbox stream: 401 without NIP-98, 403 when auth pubkey ≠ path pubkey,
//     hello after a valid connect.
//
// Same harness conventions as stream.test.ts: fake relay-pool stub as a
// plain object, handlers called directly.

import { describe, expect, it, vi } from "vitest";

// webhook-receiver → publish.ts → relay-pool.ts → `cloudflare:workers`,
// which doesn't exist under vitest/node. Only the DurableObject base class
// is touched at module scope — stub it. (Hoisted above the imports below.)
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { signEventWithRawKey } from "../lib/sign";
import { unwrap } from "../lib/nip17";
import {
  handleHookRequest,
  shouldForwardHeader,
  MAX_HOOK_BODY_BYTES,
  type HookEnv,
} from "../webhook-receiver";
import { handleInboxStream, type InboxStreamEnv } from "../inbox-stream";
import type { NostrEvent } from "../relay-pool";

// ── Test keys ───────────────────────────────────────────────────────────────

const RECIPIENT_PRIV = hexToBytes(
  "5555555555555555555555555555555555555555555555555555555555555555",
);
const RECIPIENT_PUB = bytesToHex(schnorr.getPublicKey(RECIPIENT_PRIV));

const OTHER_PRIV = hexToBytes(
  "6666666666666666666666666666666666666666666666666666666666666666",
);

// ── Fake stub ───────────────────────────────────────────────────────────────

interface FakeStub {
  hookWraps: { event: NostrEvent; recipient: string }[];
  storeHookWrap: (event: NostrEvent, recipient: string) => Promise<{ ok: boolean; reason?: string }>;
  listHookWraps: (recipient: string, sinceUnix?: number, limit?: number) => Promise<NostrEvent[]>;
}

function makeFakeStub(): FakeStub {
  const stub: FakeStub = {
    hookWraps: [],
    async storeHookWrap(event, recipient) {
      stub.hookWraps.push({ event, recipient });
      return { ok: true };
    },
    async listHookWraps(recipient, _sinceUnix, limit = 100) {
      return stub.hookWraps
        .filter((w) => w.recipient === recipient)
        .map((w) => w.event)
        .slice(0, limit);
    },
  };
  return stub;
}

function makeEnv(stub: FakeStub): HookEnv & InboxStreamEnv {
  return {
    RELAY_POOL: {
      idFromName: () => "main",
      get: () => stub,
    },
  } as unknown as HookEnv & InboxStreamEnv;
}

function hookRequest(opts: {
  body?: BodyInit;
  headers?: Record<string, string>;
  method?: string;
  ip?: string;
}): Request {
  const headers = new Headers(opts.headers ?? {});
  if (opts.ip !== undefined) headers.set("cf-connecting-ip", opts.ip);
  const method = opts.method ?? "POST";
  return new Request(`https://api.4a4.ai/v0/hook/${RECIPIENT_PUB}/gh`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : (opts.body ?? "{}"),
  });
}

function makeNip98Header(url: string, method: string, priv: Uint8Array): string {
  const signed = signEventWithRawKey(
    {
      created_at: Math.floor(Date.now() / 1000),
      kind: 27235,
      tags: [
        ["u", url],
        ["method", method],
      ],
      content: "",
    },
    priv,
  );
  return "Nostr " + btoa(JSON.stringify(signed));
}

// ── shouldForwardHeader ─────────────────────────────────────────────────────

describe("shouldForwardHeader", () => {
  it("forwards signature-bearing and x-/svix- headers plus content-type and user-agent", () => {
    for (const h of [
      "x-hub-signature-256",
      "X-GitHub-Event",
      "x-agentmail-signature",
      "stripe-signature",
      "svix-id",
      "svix-timestamp",
      "Svix-Signature",
      "content-type",
      "User-Agent",
    ]) {
      expect(shouldForwardHeader(h), h).toBe(true);
    }
  });

  it("never forwards auth material, cookies, or proxy x-forwarded-*", () => {
    for (const h of [
      "authorization",
      "Authorization",
      "cookie",
      "set-cookie",
      "x-forwarded-for",
      "X-Forwarded-Proto",
      "accept",
      "host",
      "content-length",
    ]) {
      expect(shouldForwardHeader(h), h).toBe(false);
    }
  });
});

// ── Hook ingress ────────────────────────────────────────────────────────────

describe("handleHookRequest", () => {
  it("rejects non-POST with 405", async () => {
    const env = makeEnv(makeFakeStub());
    const res = await handleHookRequest(hookRequest({ method: "GET", ip: "10.0.0.1" }), RECIPIENT_PUB, "gh", env);
    expect(res.status).toBe(405);
  });

  it("rejects oversize content-length with 413 before reading the body", async () => {
    const env = makeEnv(makeFakeStub());
    const req = hookRequest({ ip: "10.0.0.2", headers: { "content-length": String(MAX_HOOK_BODY_BYTES + 1) } });
    const res = await handleHookRequest(req, RECIPIENT_PUB, "gh", env);
    expect(res.status).toBe(413);
  });

  it("rejects an actual oversize body with 413", async () => {
    const env = makeEnv(makeFakeStub());
    const big = new Uint8Array(MAX_HOOK_BODY_BYTES + 1);
    const res = await handleHookRequest(hookRequest({ body: big, ip: "10.0.0.3" }), RECIPIENT_PUB, "gh", env);
    expect(res.status).toBe(413);
  });

  it("preserves raw bytes end-to-end and forwards only pattern-matched headers", async () => {
    const stub = makeFakeStub();
    const env = makeEnv(stub);

    // Binary body with non-UTF8 bytes — any parse/reserialize would corrupt it.
    const body = new Uint8Array(1024);
    for (let i = 0; i < body.length; i++) body[i] = (i * 7 + 13) % 256;
    const secret = "whsec_test";
    const sigHex = bytesToHex(hmac(sha256, new TextEncoder().encode(secret), body));

    const res = await handleHookRequest(
      hookRequest({
        body,
        ip: "10.0.0.4",
        headers: {
          "x-hub-signature-256": `sha256=${sigHex}`,
          "x-github-event": "push",
          "content-type": "application/json",
          authorization: "Bearer LEAK-ME-NOT",
          cookie: "session=LEAK-ME-NOT",
          "x-forwarded-for": "1.2.3.4",
        },
      }),
      RECIPIENT_PUB,
      "gh",
      env,
    );
    expect(res.status).toBe(202);
    const resBody = (await res.json()) as { ok: boolean; delivery_id: string };
    expect(resBody.ok).toBe(true);
    expect(stub.hookWraps.length).toBe(1);
    expect(stub.hookWraps[0]!.recipient).toBe(RECIPIENT_PUB.toLowerCase());

    // Unwrap as the recipient would.
    const { rumor } = unwrap(stub.hookWraps[0]!.event, RECIPIENT_PRIV);
    expect(rumor.kind).toBe(1069);
    expect(rumor.tags).toContainEqual(["fa:hook", "gh"]);
    expect(rumor.id).toBe(resBody.delivery_id);

    const payload = JSON.parse(rumor.content) as {
      body_b64: string;
      headers: Record<string, string>;
      slug: string;
      source_ip: string;
    };
    expect(payload.slug).toBe("gh");
    expect(payload.source_ip).toBe("10.0.0.4");

    // Byte-for-byte round trip.
    const decoded = Uint8Array.from(atob(payload.body_b64), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(body.length);
    expect(decoded).toEqual(body);

    // Provider HMAC verifies against the decoded copy.
    const recomputed = bytesToHex(hmac(sha256, new TextEncoder().encode(secret), decoded));
    expect(`sha256=${recomputed}`).toBe(payload.headers["x-hub-signature-256"]);

    // Header policy: signatures and x-github-* survive; auth material doesn't.
    expect(payload.headers["x-github-event"]).toBe("push");
    expect(payload.headers["content-type"]).toBe("application/json");
    expect(payload.headers["authorization"]).toBeUndefined();
    expect(payload.headers["cookie"]).toBeUndefined();
    expect(payload.headers["x-forwarded-for"]).toBeUndefined();
  });

  it("returns 429 once the per-hook rate limit window is exhausted", async () => {
    const env = makeEnv(makeFakeStub());
    // Unique slug so this test owns its rate-limit key; unique IP per call so
    // the per-IP key never trips first.
    let got429 = 0;
    let got202 = 0;
    for (let i = 0; i < 61; i++) {
      const req = new Request(`https://api.4a4.ai/v0/hook/${RECIPIENT_PUB}/ratelimit-test`, {
        method: "POST",
        headers: { "cf-connecting-ip": `10.1.${Math.floor(i / 250)}.${i % 250}` },
        body: "{}",
      });
      const res = await handleHookRequest(req, RECIPIENT_PUB, "ratelimit-test", env);
      if (res.status === 429) got429++;
      else if (res.status === 202) got202++;
    }
    expect(got202).toBe(60);
    expect(got429).toBe(1);
  });
});

// ── Inbox stream auth gates ─────────────────────────────────────────────────

describe("handleInboxStream", () => {
  const streamUrl = `https://api.4a4.ai/v0/inbox/${RECIPIENT_PUB}/stream`;

  it("401s without NIP-98", async () => {
    const env = makeEnv(makeFakeStub());
    const res = await handleInboxStream(new Request(streamUrl), RECIPIENT_PUB, env);
    expect(res.status).toBe(401);
  });

  it("403s when the authenticated pubkey does not match the path pubkey", async () => {
    const env = makeEnv(makeFakeStub());
    const req = new Request(streamUrl, {
      headers: { authorization: makeNip98Header(streamUrl, "GET", OTHER_PRIV) },
    });
    const res = await handleInboxStream(req, RECIPIENT_PUB, env);
    expect(res.status).toBe(403);
  });

  it("emits hello after a valid connect", async () => {
    const env = makeEnv(makeFakeStub());
    const req = new Request(streamUrl, {
      headers: { authorization: makeNip98Header(streamUrl, "GET", RECIPIENT_PRIV) },
    });
    const res = await handleInboxStream(req, RECIPIENT_PUB, env, {
      livePollMs: 20,
      keepaliveMs: 10_000,
      livePollLimit: 100,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 2_000;
    while (!text.includes("event: hello") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(text).toContain("event: hello");
    expect(text).toContain(`"pubkey":"${RECIPIENT_PUB.toLowerCase()}"`);
  });
});
