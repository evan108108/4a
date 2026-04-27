// 4A — genesis publication.
//
// Publishes the three genesis events (Entity, Commons, Observation) that
// bootstrap the 4A network. Run ONCE; subsequent runs are idempotent
// (replaces the addressable events at the same triple).
//
// The signing key lives at ~/.sonata/private/4a-project.nsec (mode 0600).
// Generated on first run; loaded from disk on subsequent runs.
// The pubkey is captured in 4a-project-pubkey.txt (committed; pubkeys are public).
//
// Run: `node scripts/genesis.mjs`
//      `GATEWAY_URL=http://localhost:8787 node scripts/genesis.mjs` (local test)

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  SimplePool,
  nip19,
} from "nostr-tools";
import { blake3 } from "@noble/hashes/blake3.js";

const KEY_PATH = join(homedir(), ".sonata", "private", "4a-project.nsec");
const PUBKEY_FILE = "4a-project-pubkey.txt";
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://nostr.wine"];
const CONTEXT_URL = "https://4a4.ai/ns/v0";
const GATEWAY_URL = (process.env.GATEWAY_URL || "https://api.4a4.ai").replace(/\/$/, "");
const INGEST_WAIT_MS = 4000;

// base32 encoder must match gateway/src/relay-pool.ts (lowercase RFC 4648)
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function base32Encode(bytes) {
  let bits = 0, value = 0, out = "";
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

function loadOrGenerateKey() {
  if (existsSync(KEY_PATH)) {
    const nsec = readFileSync(KEY_PATH, "utf8").trim();
    const { type, data } = nip19.decode(nsec);
    if (type !== "nsec") throw new Error(`expected nsec, got ${type}`);
    console.log(`loaded existing key from ${KEY_PATH}`);
    return data;
  }
  const sk = generateSecretKey();
  mkdirSync(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  const nsec = nip19.nsecEncode(sk);
  writeFileSync(KEY_PATH, nsec + "\n");
  chmodSync(KEY_PATH, 0o600);
  console.log(`generated new key and saved to ${KEY_PATH}`);
  return sk;
}

const sk = loadOrGenerateKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
console.log(`pubkey hex: ${pk}`);
console.log(`pubkey npub: ${npub}`);

const observationDate = new Date().toISOString();
const createdAt = Math.floor(Date.now() / 1000);

// ─── Event 1: Entity (kind 30502) ───────────────────────────────────────────
const entityPayload = {
  "@context": CONTEXT_URL,
  "@type": ["Thing", "SoftwareSourceCode", "Organization"],
  "@id": "https://4a4.ai",
  name: "4A",
  description:
    "Agent-Agnostic Accessible Archive — a convention on Nostr for AI-mediated public knowledge exchange.",
  codeRepository: "https://github.com/evan108108/4a",
  url: "https://4a4.ai",
};
const entityContent = JSON.stringify(entityPayload);
const entityEvent = finalizeEvent(
  {
    kind: 30502,
    created_at: createdAt,
    tags: [
      ["d", "4a"],
      ["blake3", blake3ContentTag(entityContent)],
      ["alt", "Entity: 4A — Agent-Agnostic Accessible Archive"],
      ["fa:context", CONTEXT_URL],
      ["t", "4a"],
    ],
    content: entityContent,
  },
  sk,
);

// ─── Event 2: Commons (kind 30504) ──────────────────────────────────────────
const commonsPayload = {
  "@context": CONTEXT_URL,
  "@type": "Organization",
  name: "4A Commons",
  description:
    "Meta-knowledge about the 4A convention — its design, evolution, and the conventions that govern its use. This pubkey is the canonical authoritative voice for 4A protocol-level meta-claims.",
  memberOf: { "@id": "https://4a4.ai" },
};
const commonsContent = JSON.stringify(commonsPayload);
const commonsEvent = finalizeEvent(
  {
    kind: 30504,
    created_at: createdAt,
    tags: [
      ["d", "4a"],
      ["blake3", blake3ContentTag(commonsContent)],
      ["alt", "Commons: 4A — meta-knowledge about the convention itself"],
      ["fa:context", CONTEXT_URL],
      ["t", "4a"],
      ["p", pk],
    ],
    content: commonsContent,
  },
  sk,
);

// ─── Event 3: Observation (kind 30500) — the thesis sentence ───────────────
const observationPayload = {
  "@context": CONTEXT_URL,
  "@type": "Observation",
  agent: { "@id": `nostr:${pk}` },
  observationDate,
  observationAbout: { "@id": "https://4a4.ai" },
  measuredProperty: "designPrinciple",
  value:
    "4A is a convention on Nostr, not a new protocol. Every wire-level primitive — signed events, pubkey identity, dumb relays — comes from existing systems. 4A specifies only event kinds (30500-30504), tag conventions, and a JSON-LD context document.",
  "prov:wasDerivedFrom": [
    { "@id": "https://4a4.ai/spec/" },
    { "@id": "https://github.com/nostr-protocol/nips/blob/master/01.md" },
  ],
};
const observationContent = JSON.stringify(observationPayload);
const observationEvent = finalizeEvent(
  {
    kind: 30500,
    created_at: createdAt,
    tags: [
      ["d", "genesis/design-principle"],
      ["blake3", blake3ContentTag(observationContent)],
      ["alt", "Observation: 4A is a convention on Nostr, not a new protocol."],
      ["fa:context", CONTEXT_URL],
      ["t", "4a"],
      ["t", "design"],
      ["a", `30502:${pk}:4a`],
    ],
    content: observationContent,
  },
  sk,
);

const events = [
  ["Entity (30502)", entityEvent],
  ["Commons (30504)", commonsEvent],
  ["Observation (30500)", observationEvent],
];

console.log("\n--- built and signed ---");
for (const [name, ev] of events) {
  const dTag = ev.tags.find((t) => t[0] === "d")[1];
  console.log(`  ${name.padEnd(22)} id=${ev.id.slice(0, 16)}… d=${dTag}`);
}

console.log("\n--- publishing to relays ---");
const pool = new SimplePool();
for (const [name, ev] of events) {
  const pubResults = await Promise.allSettled(pool.publish(RELAYS, ev));
  const accepted = pubResults.filter((r) => r.status === "fulfilled").length;
  const rejected = pubResults
    .filter((r) => r.status === "rejected")
    .map((r) => String(r.reason).slice(0, 60));
  console.log(
    `  ${name.padEnd(22)} ${accepted}/${RELAYS.length} accepted` +
      (rejected.length ? ` (${rejected.length} rejected: ${rejected.join("; ")})` : ""),
  );
}

console.log(`\nwaiting ${INGEST_WAIT_MS}ms for gateway ingest…`);
await new Promise((r) => setTimeout(r, INGEST_WAIT_MS));

console.log("\n--- verifying via gateway ---");
let allPassed = true;
for (const [name, ev] of events) {
  const dTag = ev.tags.find((t) => t[0] === "d")[1];
  const addr = `${ev.kind}:${pk}:${dTag}`;
  const url = `${GATEWAY_URL}/v0/object/${encodeURIComponent(addr)}`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const body = await res.json();
      const ok = body.id === ev.id;
      if (!ok) allPassed = false;
      console.log(
        `  ${name.padEnd(22)} ${ok ? "PASS" : "FAIL"} via /v0/object/${addr.slice(0, 50)}…`,
      );
    } else {
      allPassed = false;
      console.log(`  ${name.padEnd(22)} FAIL HTTP ${res.status}`);
    }
  } catch (err) {
    allPassed = false;
    console.log(`  ${name.padEnd(22)} FAIL ${err.message}`);
  }
}

const pubkeyDoc = `# 4A project pubkey

This pubkey is the canonical 4A project identity. It signed the genesis
events that bootstrapped the 4A network on ${observationDate}.

- pubkey (hex):  ${pk}
- pubkey (npub): ${npub}

Genesis events (addressable triples — \`kind:pubkey:d\`):

- Entity:      \`30502:${pk}:4a\`
- Commons:     \`30504:${pk}:4a\`
- Observation: \`30500:${pk}:genesis/design-principle\`

This identity is recognized as authoritative for 4A meta-claims (the protocol
itself, its conventions, its evolution). Domain-specific knowledge claims
about other projects, libraries, or organizations should come from pubkeys
specific to those communities, not this one.

The signing key is held at ~/.sonata/private/4a-project.nsec on the project
maintainer's machine and is not committed to the repository.
`;
writeFileSync(PUBKEY_FILE, pubkeyDoc);
console.log(`\nwrote ${PUBKEY_FILE}`);

pool.close(RELAYS);

console.log("");
console.log(`OVERALL: ${allPassed ? "PASS" : "FAIL"}`);
process.exit(allPassed ? 0 : 1);
