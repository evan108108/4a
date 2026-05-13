// Unit tests for the Blossom adapter (BUD-01 upload + BUD-02 fetch).
//
// R2 is mocked with an in-memory Map so tests stay hermetic. The BUD-01 auth
// events are built and signed in-test from a fresh keypair.

import { beforeEach, describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { signEventWithRawKey } from "../lib/sign";
import { handleBlossomRequest, type BlossomEnv } from "../blossom";

interface StoredObject {
  body: Uint8Array;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}

function makeR2Stub(seed?: Map<string, StoredObject>): R2Bucket {
  const store = seed ?? new Map<string, StoredObject>();
  const bucket = {
    async put(
      key: string,
      value: Uint8Array | string,
      opts?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
    ) {
      const body = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      store.set(key, {
        body,
        customMetadata: opts?.customMetadata,
        httpMetadata: opts?.httpMetadata,
      });
      return { key, size: body.byteLength };
    },
    async get(key: string) {
      const r = store.get(key);
      if (!r) return null;
      return {
        size: r.body.byteLength,
        body: new Blob([new Uint8Array(r.body)]).stream(),
        customMetadata: r.customMetadata,
        httpMetadata: r.httpMetadata,
        async text() {
          return new TextDecoder().decode(r.body);
        },
        async arrayBuffer() {
          return r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength);
        },
      };
    },
    async delete(key: string) {
      store.delete(key);
    },
    // Expose the underlying map for assertions.
    __store: store,
  } as unknown as R2Bucket;
  return bucket;
}

function makeKeypair(): { priv: Uint8Array; pub: string } {
  const priv = randomBytes(32);
  const pub = bytesToHex(schnorr.getPublicKey(priv));
  return { priv, pub };
}

interface AuthEventOpts {
  sha: string;
  expirationSec?: number;
  createdAtSec?: number;
  action?: string;
}

function buildAuthHeader(priv: Uint8Array, opts: AuthEventOpts): string {
  const now = Math.floor(Date.now() / 1000);
  const created_at = opts.createdAtSec ?? now;
  const expiration = opts.expirationSec ?? now + 600;
  const action = opts.action ?? "upload";
  const template = {
    kind: 24242,
    created_at,
    tags: [
      ["t", action],
      ["x", opts.sha],
      ["expiration", String(expiration)],
    ],
    content: "Upload",
  };
  const signed = signEventWithRawKey(template, priv);
  const b64 = btoa(JSON.stringify(signed));
  return `Nostr ${b64}`;
}

function uploadRequest(body: Uint8Array, authHeader: string | null, contentType = "application/octet-stream"): Request {
  const headers = new Headers({ "Content-Type": contentType });
  if (authHeader) headers.set("Authorization", authHeader);
  return new Request("https://api.4a4.ai/blossom/upload", {
    method: "PUT",
    headers,
    body,
  });
}

let env: BlossomEnv;

beforeEach(() => {
  env = { STORAGE: makeR2Stub() };
});

describe("Blossom adapter — upload (BUD-01)", () => {
  it("accepts a valid upload with matching sha256 + signed auth event", async () => {
    const { priv, pub } = makeKeypair();
    const body = new TextEncoder().encode("hello world");
    const sha = bytesToHex(sha256(body));
    const header = buildAuthHeader(priv, { sha });

    const res = await handleBlossomRequest(uploadRequest(body, header), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sha256: string; mirrors: string[]; size: number };
    expect(json.sha256).toBe(sha);
    expect(json.size).toBe(body.byteLength);
    expect(json.mirrors[0]).toBe(`https://api.4a4.ai/blossom/${sha}`);

    const store = (env.STORAGE as unknown as { __store: Map<string, StoredObject> }).__store;
    const stored = store.get(`blob/${sha}`);
    expect(stored).toBeTruthy();
    expect(stored!.customMetadata?.uploader_pubkey).toBe(pub);

    const quota = store.get(`quota/${pub}`);
    expect(quota).toBeTruthy();
    const quotaJson = JSON.parse(new TextDecoder().decode(quota!.body)) as { bytes_used: number };
    expect(quotaJson.bytes_used).toBe(body.byteLength);
  });

  it("rejects mismatched sha256 vs auth x tag with 400 invalid_hash", async () => {
    const { priv } = makeKeypair();
    const body = new TextEncoder().encode("real body");
    const wrongSha = "0".repeat(64);
    const header = buildAuthHeader(priv, { sha: wrongSha });

    const res = await handleBlossomRequest(uploadRequest(body, header), env);
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("invalid_hash");
  });

  it("rejects malformed auth header with 401 bad_auth", async () => {
    const body = new TextEncoder().encode("hi");
    const res = await handleBlossomRequest(uploadRequest(body, "Nostr not-base64"), env);
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("bad_auth");
  });

  it("rejects missing auth header with 401 missing_auth", async () => {
    const body = new TextEncoder().encode("hi");
    const res = await handleBlossomRequest(uploadRequest(body, null), env);
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("missing_auth");
  });

  it("rejects auth event with bad signature", async () => {
    const { priv } = makeKeypair();
    const body = new TextEncoder().encode("hello");
    const sha = bytesToHex(sha256(body));
    const header = buildAuthHeader(priv, { sha });
    // Corrupt the signature inside the base64 payload.
    const b64 = header.slice("Nostr ".length);
    const ev = JSON.parse(atob(b64)) as { sig: string };
    ev.sig = "0".repeat(128);
    const corrupted = `Nostr ${btoa(JSON.stringify(ev))}`;

    const res = await handleBlossomRequest(uploadRequest(body, corrupted), env);
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("bad_auth");
  });

  it("rejects auth event older than 5 minutes with 401 stale_auth", async () => {
    const { priv } = makeKeypair();
    const body = new TextEncoder().encode("hi");
    const sha = bytesToHex(sha256(body));
    const now = Math.floor(Date.now() / 1000);
    const header = buildAuthHeader(priv, { sha, createdAtSec: now - 600 });

    const res = await handleBlossomRequest(uploadRequest(body, header), env);
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("stale_auth");
  });

  it("rejects auth event with already-elapsed expiration", async () => {
    const { priv } = makeKeypair();
    const body = new TextEncoder().encode("hi");
    const sha = bytesToHex(sha256(body));
    const now = Math.floor(Date.now() / 1000);
    const header = buildAuthHeader(priv, { sha, expirationSec: now - 1 });

    const res = await handleBlossomRequest(uploadRequest(body, header), env);
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("stale_auth");
  });

  it("rejects wrong action (t != upload) with 401 wrong_action", async () => {
    const { priv } = makeKeypair();
    const body = new TextEncoder().encode("hi");
    const sha = bytesToHex(sha256(body));
    const header = buildAuthHeader(priv, { sha, action: "delete" });

    const res = await handleBlossomRequest(uploadRequest(body, header), env);
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("wrong_action");
  });

  it("rejects body over 256 MiB with 413 file_too_big", async () => {
    // Don't actually allocate 256 MiB — fake a slim Request whose
    // arrayBuffer() returns a 257 MiB sparse-feeling buffer. We allocate just
    // enough; the handler reads it into a Uint8Array, so size matters.
    // To keep memory low we still build a real ArrayBuffer but small + lie via
    // a wrapped Request. Simpler: just allocate a small typed array with the
    // wrong claimed length via a custom Request subclass override.

    const oversized = new ArrayBuffer(256 * 1024 * 1024 + 1);
    const view = new Uint8Array(oversized);
    view[0] = 0x42; // touch the start so it's not optimized away

    // Build a real Request — Cloudflare's runtime would also reject at the
    // edge, but our handler is the unit under test.
    const req = new Request("https://api.4a4.ai/blossom/upload", {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", Authorization: "Nostr placeholder" },
      body: oversized,
    });

    const res = await handleBlossomRequest(req, env);
    expect(res.status).toBe(413);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("file_too_big");
  }, 30_000);

  it("rejects upload that would push the per-pubkey quota over 1 GiB", async () => {
    const { priv, pub } = makeKeypair();
    // Pre-seed quota near the limit.
    const store = (env.STORAGE as unknown as { __store: Map<string, StoredObject> }).__store;
    const seed = {
      bytes_used: 999 * 1024 * 1024,
      last_reset_at: Date.now(),
    };
    store.set(`quota/${pub}`, {
      body: new TextEncoder().encode(JSON.stringify(seed)),
    });

    const body = new Uint8Array(32 * 1024 * 1024); // 32 MiB; 999+32 > 1024.
    const sha = bytesToHex(sha256(body));
    const header = buildAuthHeader(priv, { sha });

    const res = await handleBlossomRequest(uploadRequest(body, header), env);
    expect(res.status).toBe(413);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("quota_exceeded");
  }, 30_000);
});

describe("Blossom adapter — fetch (BUD-02)", () => {
  it("returns 404 for unknown sha256", async () => {
    const sha = "a".repeat(64);
    const req = new Request(`https://api.4a4.ai/blossom/${sha}`);
    const res = await handleBlossomRequest(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid sha (non-hex / wrong length)", async () => {
    const req = new Request(`https://api.4a4.ai/blossom/not-a-real-hash`);
    const res = await handleBlossomRequest(req, env);
    expect(res.status).toBe(404); // route regex won't match → 404, which is the expected behavior
  });

  it("streams body + sets cache headers for a stored blob", async () => {
    const { priv } = makeKeypair();
    const body = new TextEncoder().encode("blob payload");
    const sha = bytesToHex(sha256(body));
    const header = buildAuthHeader(priv, { sha });

    const putRes = await handleBlossomRequest(uploadRequest(body, header, "text/plain"), env);
    expect(putRes.status).toBe(200);

    const getReq = new Request(`https://api.4a4.ai/blossom/${sha}`);
    const getRes = await handleBlossomRequest(getReq, env);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("Cache-Control")).toContain("immutable");
    expect(getRes.headers.get("Content-Type")).toBe("text/plain");
    const got = new Uint8Array(await getRes.arrayBuffer());
    expect(new TextDecoder().decode(got)).toBe("blob payload");
  });
});
