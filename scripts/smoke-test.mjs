// 4A end-to-end smoke test.
//
// Generates a fresh nostr keypair, builds and signs a 4A Observation,
// publishes it to the relays the gateway listens to, then asserts the
// gateway returns it via /v0/query and /v0/object, and that /ns/v0 serves
// a valid JSON-LD context.
//
// Run: `npm run smoke-test`
// Override the gateway target: `GATEWAY_URL=http://localhost:8787 npm run smoke-test`
//
// Exit 0 on full pass, 1 on any failure.

import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  SimplePool,
} from "nostr-tools";
import { blake3 } from "@noble/hashes/blake3.js";

const GATEWAY_URL = (process.env.GATEWAY_URL || "https://api.4a4.ai").replace(/\/$/, "");
const CONTEXT_URL = "https://4a4.ai/ns/v0";
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://nostr.wine"];
const KIND_OBSERVATION = 30500;
const INGEST_WAIT_MS = 3000;

// Custom base32 (lowercase RFC 4648) — must match gateway/src/relay-pool.ts.
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function blake3ContentTag(content) {
  return "bk-" + base32Encode(blake3(new TextEncoder().encode(content)));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const results = [];

function record(step, ok, detail = "", ms = 0) {
  results.push({ step, ok, detail, ms });
  const tag = ok ? "PASS" : "FAIL";
  const time = ms ? ` (${ms}ms)` : "";
  const tail = detail ? ` — ${detail}` : "";
  console.log(`[${tag}] ${step}${time}${tail}`);
}

function finish(allPassed, t0) {
  const total = Date.now() - t0;
  console.log("");
  console.log("--- summary ---");
  for (const r of results) {
    const tag = r.ok ? "PASS" : "FAIL";
    const time = r.ms ? ` (${r.ms}ms)` : "";
    const tail = r.detail ? ` — ${r.detail}` : "";
    console.log(`${tag} ${r.step}${time}${tail}`);
  }
  console.log(`total: ${total}ms`);
  console.log(`OVERALL: ${allPassed ? "PASS" : "FAIL"}`);
  process.exit(allPassed ? 0 : 1);
}

async function main() {
  const t0 = Date.now();
  console.log(`4A smoke test — gateway=${GATEWAY_URL} relays=${RELAYS.length}`);

  // Step 1 — keypair
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  record("keygen", true, `pubkey=${pk.slice(0, 16)}…`);

  // Step 2-4 — build, hash, sign Observation
  const dTag = `smoke-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const observationDate = new Date().toISOString();
  const payload = {
    "@context": CONTEXT_URL,
    "@type": "Observation",
    agent: { "@id": `nostr:${pk}` },
    observationDate,
    observationAbout: { "@id": "https://github.com/4a4ai/test" },
    measuredProperty: "smoke-test/roundtrip",
    value: `roundtrip-${dTag}`,
    "prov:wasDerivedFrom": [{ "@id": "https://4a4.ai/scripts/smoke-test.mjs" }],
  };
  const content = JSON.stringify(payload);
  const cidTag = blake3ContentTag(content);

  const template = {
    kind: KIND_OBSERVATION,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", dTag],
      ["blake3", cidTag],
      ["alt", `Observation: 4A smoke-test roundtrip (${dTag})`],
      ["fa:context", CONTEXT_URL],
      ["t", "smoke-test"],
      ["L", "4a.credibility.test"],
      ["l", "self", "4a.credibility.test"],
    ],
    content,
  };
  const event = finalizeEvent(template, sk);
  record(
    "build+sign event",
    true,
    `id=${event.id.slice(0, 16)}… d=${dTag} blake3=${cidTag.slice(0, 14)}…`,
  );

  // Step 5 — publish to relays
  const pool = new SimplePool();
  const pubStart = Date.now();
  const pubResults = await Promise.allSettled(pool.publish(RELAYS, event));
  const accepted = pubResults.filter((r) => r.status === "fulfilled").length;
  const rejected = pubResults
    .filter((r) => r.status === "rejected")
    .map((r) => String(r.reason).slice(0, 80));
  const pubMs = Date.now() - pubStart;
  if (accepted === 0) {
    record(
      "publish to relays",
      false,
      `0/${RELAYS.length} accepted — ${rejected.join("; ")}`,
      pubMs,
    );
    pool.close(RELAYS);
    return finish(false, t0);
  }
  record(
    "publish to relays",
    true,
    `${accepted}/${RELAYS.length} accepted${rejected.length ? ` (${rejected.length} rejected)` : ""}`,
    pubMs,
  );

  // Step 6 — wait for gateway to ingest from relays
  await sleep(INGEST_WAIT_MS);

  // Step 7 — query by author + kind
  const queryUrl = `${GATEWAY_URL}/v0/query?author=${pk}&kind=observation`;
  const qStart = Date.now();
  let queryOk = false;
  let queryDetail = "";
  try {
    const res = await fetch(queryUrl);
    if (!res.ok) {
      queryDetail = `HTTP ${res.status}${res.status >= 500 ? " (gateway not yet deployed?)" : ""}`;
    } else {
      const body = await res.json();
      const events = Array.isArray(body.events) ? body.events : [];
      const found = events.find((e) => e.id === event.id);
      queryOk = Boolean(found);
      queryDetail = found
        ? `event present in ${body.count ?? events.length} result(s)`
        : `event id ${event.id.slice(0, 16)}… not in ${body.count ?? events.length} result(s)`;
    }
  } catch (err) {
    queryDetail = `fetch failed: ${err.message} (gateway not yet deployed?)`;
  }
  record("query author+kind", queryOk, queryDetail, Date.now() - qStart);

  // Step 8 — object lookup by addressable triple
  const objAddr = `${KIND_OBSERVATION}:${pk}:${dTag}`;
  const objUrl = `${GATEWAY_URL}/v0/object/${encodeURIComponent(objAddr)}`;
  const oStart = Date.now();
  let objOk = false;
  let objDetail = "";
  try {
    const res = await fetch(objUrl);
    if (!res.ok) {
      objDetail = `HTTP ${res.status}`;
    } else {
      const body = await res.json();
      if (body.id === event.id) {
        objOk = true;
        objDetail = `id matches`;
      } else {
        objDetail = `id mismatch: got ${(body.id || "").slice(0, 16)}…`;
      }
    }
  } catch (err) {
    objDetail = `fetch failed: ${err.message}`;
  }
  record("object lookup by address", objOk, objDetail, Date.now() - oStart);

  // Step 9 — JSON-LD context document
  const cStart = Date.now();
  let ctxOk = false;
  let ctxDetail = "";
  try {
    const res = await fetch(CONTEXT_URL, { headers: { Accept: "application/ld+json" } });
    if (!res.ok) {
      ctxDetail = `HTTP ${res.status}`;
    } else {
      const body = await res.json();
      const ctx = body["@context"];
      if (ctx && typeof ctx === "object" && typeof ctx.fa === "string" && ctx.fa.length > 0) {
        ctxOk = true;
        ctxDetail = `@context.fa = ${ctx.fa}`;
      } else {
        ctxDetail = `@context.fa missing or invalid`;
      }
    }
  } catch (err) {
    ctxDetail = `fetch failed: ${err.message}`;
  }
  record("context document", ctxOk, ctxDetail, Date.now() - cStart);

  pool.close(RELAYS);
  finish(queryOk && objOk && ctxOk, t0);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
