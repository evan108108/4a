// 4A Phase 2 end-to-end smoke test.
//
// Exercises the custodial publish path end-to-end:
//   1. Mint a test JWT directly (synthetic claims, signed with JWT_SIGNING_KEY)
//   2. POST each publish endpoint and capture the KMS-derived pubkey
//   3. Confirm the same JWT subject yields the same pubkey on every call
//      (deterministic derivation contract — fail hard on violation)
//   4. Wait for relay → gateway ingest
//   5. Re-fetch each addressable event via /v0/object and schnorr-verify
//      the gateway's KMS-derived signature
//   6. Confirm auth gating returns 401 for missing / garbage / expired tokens
//
// Run: `npm run smoke-test:phase2`
// Override target: `GATEWAY_URL=https://staging.example npm run smoke-test:phase2`
//
// Required: JWT_SIGNING_KEY in .env or process env. Must match the value
// stored in the deployed gateway via `wrangler secret put JWT_SIGNING_KEY`.
//
// Exit 0 on full pass, 1 on any failure, 2 on missing config.

import { existsSync, readFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";
import { verifyEvent } from "nostr-tools";

const GATEWAY_URL = (process.env.GATEWAY_URL || "https://api.4a4.ai").replace(/\/$/, "");
const ENV_FILE = ".env";
const INGEST_WAIT_MS = 4000;

// ─── env loader ─────────────────────────────────────────────────────────────

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = loadEnvFile(ENV_FILE);
const JWT_SIGNING_KEY = process.env.JWT_SIGNING_KEY ?? fileEnv.JWT_SIGNING_KEY ?? "";

if (!JWT_SIGNING_KEY) {
  console.error("ERROR: JWT_SIGNING_KEY is not set.");
  console.error("");
  console.error("Set it to run the smoke test. The value must match the deployed");
  console.error("gateway's JWT_SIGNING_KEY (a wrangler secret in production):");
  console.error("");
  console.error("  echo 'JWT_SIGNING_KEY=<the_secret>' >> .env");
  console.error("    or");
  console.error("  JWT_SIGNING_KEY=<the_secret> npm run smoke-test:phase2");
  console.error("");
  console.error("The smoke test mints test JWTs locally; the gateway only accepts");
  console.error("them if its JWT_SIGNING_KEY matches the value used to mint here.");
  process.exit(2);
}

// ─── HS256 JWT minting (Node Web Crypto) ────────────────────────────────────

const enc = new TextEncoder();

function b64urlBytes(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function b64urlString(s) {
  return b64urlBytes(enc.encode(s));
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function mintJwt(claims) {
  const header = b64urlString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlString(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  const key = await importHmacKey(JWT_SIGNING_KEY);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(input)));
  return `${input}.${b64urlBytes(sig)}`;
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function publish(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body is fine; status is what matters */ }
  return { status: res.status, body: data };
}

// ─── result tracking ────────────────────────────────────────────────────────

const results = [];
function record(step, ok, detail = "") {
  results.push({ step, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${step}${detail ? " — " + detail : ""}`);
}

function summary(t0) {
  const allPassed = results.every((r) => r.ok);
  console.log("");
  console.log("--- summary ---");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.step}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log(`total: ${Date.now() - t0}ms`);
  console.log(`OVERALL: ${allPassed ? "PASS" : "FAIL"}`);
  process.exit(allPassed ? 0 : 1);
}

// ─── synthetic test fixtures ────────────────────────────────────────────────

const testRandom = Math.random().toString(36).slice(2, 10);
const testOauthId = `smoke-test-${testRandom}`;
const testEntityUri = `https://4a4.ai/test/smoke/${testRandom}`;
const TEST_TOPIC = "smoke-test";

function nowSec() { return Math.floor(Date.now() / 1000); }

const validClaims = {
  provider: "test",
  oauth_id: testOauthId,
  login: "smoke-test",
  iat: nowSec(),
  exp: nowSec() + 600,
};

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log(`4A Phase 2 smoke test — gateway=${GATEWAY_URL} subject=test:${testOauthId}`);

  const jwt = await mintJwt(validClaims);
  record("mint test JWT", true, `len=${jwt.length}`);

  const publishedAddrs = []; // { kind, address, eventId }
  let derivedPubkey = null;

  // ─── observation ─────────────────────────────────────────────────────────
  {
    const body = {
      about: testEntityUri,
      property: "smoke-test/phase2-roundtrip",
      value: `phase2-${testRandom}`,
      topic: [TEST_TOPIC],
      derivedFrom: ["https://4a4.ai/scripts/smoke-test-phase2.mjs"],
    };
    const { status, body: data } = await publish("/v0/publish/observation", body, jwt);
    if (status !== 200 || !data?.ok) {
      record("publish observation", false, `HTTP ${status} — ${JSON.stringify(data).slice(0, 200)}`);
      return summary(t0);
    }
    derivedPubkey = data.pubkey;
    publishedAddrs.push({ kind: 30500, address: data.address, eventId: data.eventId });
    record("publish observation", true, `pubkey=${data.pubkey.slice(0, 16)}… address=${data.address}`);
  }

  // ─── claim ───────────────────────────────────────────────────────────────
  {
    const body = {
      about: testEntityUri,
      appearance: `Smoke-test claim ${testRandom}: phase 2 publish path is reachable`,
      topic: [TEST_TOPIC],
    };
    const { status, body: data } = await publish("/v0/publish/claim", body, jwt);
    if (status !== 200 || !data?.ok) {
      record("publish claim", false, `HTTP ${status} — ${JSON.stringify(data).slice(0, 200)}`);
      return summary(t0);
    }
    if (data.pubkey !== derivedPubkey) {
      record(
        "publish claim — determinism check",
        false,
        `DETERMINISM VIOLATION: pubkey changed ${derivedPubkey.slice(0, 16)}… → ${data.pubkey.slice(0, 16)}…`,
      );
      return summary(t0);
    }
    publishedAddrs.push({ kind: 30501, address: data.address, eventId: data.eventId });
    record("publish claim", true, `address=${data.address}`);
  }

  // ─── entity ──────────────────────────────────────────────────────────────
  {
    const body = {
      canonicalId: testEntityUri,
      name: `Smoke Test Entity ${testRandom}`,
      description: "Synthetic entity created by the Phase 2 smoke test.",
      topic: [TEST_TOPIC],
    };
    const { status, body: data } = await publish("/v0/publish/entity", body, jwt);
    if (status !== 200 || !data?.ok) {
      record("publish entity", false, `HTTP ${status} — ${JSON.stringify(data).slice(0, 200)}`);
      return summary(t0);
    }
    if (data.pubkey !== derivedPubkey) {
      record("publish entity — determinism check", false, "DETERMINISM VIOLATION: pubkey changed");
      return summary(t0);
    }
    publishedAddrs.push({ kind: 30502, address: data.address, eventId: data.eventId });
    record("publish entity", true, `address=${data.address}`);
  }

  // ─── relation ────────────────────────────────────────────────────────────
  {
    const body = {
      subject: testEntityUri,
      object: "https://4a4.ai",
      roleName: "smokeTestSubjectOf",
    };
    const { status, body: data } = await publish("/v0/publish/relation", body, jwt);
    if (status !== 200 || !data?.ok) {
      record("publish relation", false, `HTTP ${status} — ${JSON.stringify(data).slice(0, 200)}`);
      return summary(t0);
    }
    if (data.pubkey !== derivedPubkey) {
      record("publish relation — determinism check", false, "DETERMINISM VIOLATION: pubkey changed");
      return summary(t0);
    }
    publishedAddrs.push({ kind: 30503, address: data.address, eventId: data.eventId });
    record("publish relation", true, `address=${data.address}`);
  }

  // ─── attest (kind 1985, not addressable) ────────────────────────────────
  {
    const body = {
      subject: derivedPubkey,
      namespace: "4a.credibility.smoke-test",
      value: "self",
    };
    const { status, body: data } = await publish("/v0/attest", body, jwt);
    if (status !== 200 || !data?.ok) {
      record("publish attest", false, `HTTP ${status} — ${JSON.stringify(data).slice(0, 200)}`);
      return summary(t0);
    }
    if (data.pubkey !== derivedPubkey) {
      record("publish attest — determinism check", false, "DETERMINISM VIOLATION: pubkey changed");
      return summary(t0);
    }
    record("publish attest (kind 1985)", true, `eventId=${data.eventId.slice(0, 16)}…`);
  }

  record(
    "deterministic derivation contract",
    true,
    `same JWT subject → same pubkey across all 5 publishes`,
  );

  // ─── wait for ingest ─────────────────────────────────────────────────────
  console.log(`waiting ${INGEST_WAIT_MS}ms for relay → gateway ingest…`);
  await new Promise((r) => setTimeout(r, INGEST_WAIT_MS));

  // ─── verify each addressable event roundtrips and has a valid signature ─
  for (const { kind, address, eventId } of publishedAddrs) {
    const url = `${GATEWAY_URL}/v0/object/${encodeURIComponent(address)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      record(`fetch kind ${kind} via /v0/object`, false, `network error: ${err.message}`);
      continue;
    }
    if (!res.ok) {
      record(`fetch kind ${kind} via /v0/object`, false, `HTTP ${res.status}`);
      continue;
    }
    const event = await res.json();
    if (event.id !== eventId) {
      record(
        `fetch kind ${kind} via /v0/object`,
        false,
        `id mismatch (got ${(event.id || "").slice(0, 16)}… want ${eventId.slice(0, 16)}…)`,
      );
      continue;
    }
    record(`fetch kind ${kind} via /v0/object`, true, `id matches`);

    // The single most important assertion in the suite: the signature the
    // gateway produced via KMS-derived secp256k1 actually verifies.
    const sigOk = verifyEvent(event);
    record(
      `schnorr verify kind ${kind}`,
      sigOk,
      sigOk
        ? `pubkey=${event.pubkey.slice(0, 16)}… sig valid`
        : "KMS-derived signature did NOT verify — derivation/signing is broken",
    );
  }

  // ─── auth gating ─────────────────────────────────────────────────────────
  const minBody = {
    about: testEntityUri,
    property: "smoke-test/auth-gate",
    value: `auth-gate-${testRandom}`,
  };
  {
    const { status } = await publish("/v0/publish/observation", minBody, null);
    record("auth gate: missing Authorization → 401", status === 401, `got HTTP ${status}`);
  }
  {
    const { status } = await publish("/v0/publish/observation", minBody, "definitely.not.a.jwt");
    record("auth gate: garbage Bearer → 401", status === 401, `got HTTP ${status}`);
  }
  {
    const expiredJwt = await mintJwt({
      ...validClaims,
      iat: nowSec() - 7200,
      exp: nowSec() - 60,
    });
    const { status } = await publish("/v0/publish/observation", minBody, expiredJwt);
    record("auth gate: expired JWT → 401", status === 401, `got HTTP ${status}`);
  }

  summary(t0);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
