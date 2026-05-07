// Round-trip + negative tests for the NIP-98 verifier middleware.

import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { signEventWithRawKey } from "../sign";
import { verifyNip98 } from "../nip98";
import type { SignedEvent } from "../../kms";

const PRIV = hexToBytes(
  "1111111111111111111111111111111111111111111111111111111111111111",
);
const PUB = bytesToHex(schnorr.getPublicKey(PRIV));

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function makeAuthEvent(opts: {
  url: string;
  method: string;
  payloadHashHex?: string;
  kind?: number;
  createdAt?: number;
  omit?: ReadonlyArray<"u" | "method" | "payload">;
}): SignedEvent {
  const omit = opts.omit ?? [];
  const tags: string[][] = [];
  if (!omit.includes("u")) tags.push(["u", opts.url]);
  if (!omit.includes("method")) tags.push(["method", opts.method]);
  if (opts.payloadHashHex !== undefined && !omit.includes("payload")) {
    tags.push(["payload", opts.payloadHashHex]);
  }
  return signEventWithRawKey(
    {
      created_at: opts.createdAt ?? nowSec(),
      kind: opts.kind ?? 27235,
      tags,
      content: "",
    },
    PRIV,
  );
}

function authHeader(signed: SignedEvent): string {
  return "Nostr " + btoa(JSON.stringify(signed));
}

describe("verifyNip98 round-trip", () => {
  it("accepts a valid GET request and returns the signer's pubkey", async () => {
    const url = "https://api.4a4.ai/v0/test?x=1";
    const signed = makeAuthEvent({ url, method: "GET" });
    const req = new Request(url, {
      method: "GET",
      headers: { Authorization: authHeader(signed) },
    });
    const res = await verifyNip98(req, undefined);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.pubkey).toBe(PUB);
      expect(res.authEvent.id).toBe(signed.id);
    }
  });

  it("accepts a valid POST request with body matching payload hash", async () => {
    const url = "https://api.4a4.ai/v0/test";
    const body = new TextEncoder().encode('{"hello":"world"}');
    const payloadHash = bytesToHex(sha256(body));
    const signed = makeAuthEvent({
      url,
      method: "POST",
      payloadHashHex: payloadHash,
    });
    const req = new Request(url, {
      method: "POST",
      headers: { Authorization: authHeader(signed) },
      body,
    });
    const res = await verifyNip98(req, body);
    expect(res.ok).toBe(true);
  });
});

describe("verifyNip98 negatives", () => {
  it("rejects missing header", async () => {
    const req = new Request("https://api.4a4.ai/x", { method: "GET" });
    const res = await verifyNip98(req, undefined);
    expect(res).toEqual({
      ok: false,
      status: 401,
      error: "missing_authorization_header",
    });
  });

  it("rejects malformed header (wrong scheme)", async () => {
    const req = new Request("https://api.4a4.ai/x", {
      method: "GET",
      headers: { Authorization: "Bearer abc" },
    });
    const res = await verifyNip98(req, undefined);
    expect(res).toMatchObject({
      ok: false,
      error: "malformed_authorization_header",
    });
  });

  it("rejects bad signature (flipped byte in sig)", async () => {
    const url = "https://api.4a4.ai/x";
    const signed = makeAuthEvent({ url, method: "GET" });
    const sigBytes = hexToBytes(signed.sig);
    sigBytes[0] = (sigBytes[0]! ^ 0xff) & 0xff;
    const tampered: SignedEvent = { ...signed, sig: bytesToHex(sigBytes) };
    const req = new Request(url, {
      method: "GET",
      headers: { Authorization: authHeader(tampered) },
    });
    const res = await verifyNip98(req, undefined);
    expect(res).toMatchObject({ ok: false, error: "invalid_signature" });
  });

  it("rejects wrong kind", async () => {
    const url = "https://api.4a4.ai/x";
    const signed = makeAuthEvent({ url, method: "GET", kind: 1 });
    const req = new Request(url, {
      method: "GET",
      headers: { Authorization: authHeader(signed) },
    });
    const res = await verifyNip98(req, undefined);
    expect(res).toMatchObject({ ok: false, error: "wrong_kind" });
  });

  it("rejects stale auth event (created_at -120s)", async () => {
    const url = "https://api.4a4.ai/x";
    const signed = makeAuthEvent({
      url,
      method: "GET",
      createdAt: nowSec() - 120,
    });
    const req = new Request(url, {
      method: "GET",
      headers: { Authorization: authHeader(signed) },
    });
    const res = await verifyNip98(req, undefined);
    expect(res).toMatchObject({ ok: false, error: "stale_auth_event" });
  });

  it("rejects URL mismatch", async () => {
    const reqUrl = "https://api.4a4.ai/x";
    const signed = makeAuthEvent({
      url: "https://api.4a4.ai/y",
      method: "GET",
    });
    const req = new Request(reqUrl, {
      method: "GET",
      headers: { Authorization: authHeader(signed) },
    });
    const res = await verifyNip98(req, undefined);
    expect(res).toMatchObject({ ok: false, error: "url_mismatch" });
  });

  it("rejects method mismatch", async () => {
    const url = "https://api.4a4.ai/x";
    const signed = makeAuthEvent({ url, method: "GET" });
    const req = new Request(url, {
      method: "POST",
      headers: { Authorization: authHeader(signed) },
      body: new Uint8Array(0),
    });
    const res = await verifyNip98(req, undefined);
    expect(res).toMatchObject({ ok: false, error: "method_mismatch" });
  });

  it("rejects payload hash mismatch when body provided", async () => {
    const url = "https://api.4a4.ai/x";
    const realBody = new TextEncoder().encode("hello");
    const wrongHash = bytesToHex(
      sha256(new TextEncoder().encode("not hello")),
    );
    const signed = makeAuthEvent({
      url,
      method: "POST",
      payloadHashHex: wrongHash,
    });
    const req = new Request(url, {
      method: "POST",
      headers: { Authorization: authHeader(signed) },
      body: realBody,
    });
    const res = await verifyNip98(req, realBody);
    expect(res).toMatchObject({ ok: false, error: "payload_hash_mismatch" });
  });

  it("rejects missing tags (no u tag)", async () => {
    const url = "https://api.4a4.ai/x";
    const signed = makeAuthEvent({ url, method: "GET", omit: ["u"] });
    const req = new Request(url, {
      method: "GET",
      headers: { Authorization: authHeader(signed) },
    });
    const res = await verifyNip98(req, undefined);
    expect(res).toMatchObject({
      ok: false,
      error: "malformed_authorization_header",
    });
  });
});
