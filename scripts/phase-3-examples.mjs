// Phase 3 v0 t09 — worked examples on the live 4A relay set.
//
// Publishes the two SPEC §§8.1, 8.2 examples end-to-end:
//
//   Example A — Alice scores Bob's claim with a paired rationale.
//   Example B — Carol meta-scores Alice's score with a paired rationale.
//
// Bob first publishes a kind:30501 claim (the target of Alice's score).
// All five events (Bob claim, Alice score+rationale, Carol score+rationale)
// are signed locally with deterministic test keys and published directly to
// the same relay set the gateway fans out to. We bypass the gateway's
// /v0/score and /v0/comment helpers because (a) those require a JWT for one
// custodial identity, and we need three (alice/bob/carol), and (b) this is
// the same pattern scripts/genesis.mjs already uses for fixed test pubkeys.
//
// Test seeds (documented in docs/examples/phase-3/pubkeys.md):
//   alice = SHA-256("4a/phase-3/example/alice/v1")
//   bob   = SHA-256("4a/phase-3/example/bob/v1")
//   carol = SHA-256("4a/phase-3/example/carol/v1")
//
// Run: `node scripts/phase-3-examples.mjs`
//      `GATEWAY_URL=http://localhost:8787 node scripts/phase-3-examples.mjs`

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey, SimplePool, nip19 } from "nostr-tools";
import { blake3 } from "@noble/hashes/blake3.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));
const FIXTURES_DIR = join(REPO_ROOT, "docs", "examples", "phase-3");
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://nostr.wine"];
const CONTEXT_URL = "https://4a4.ai/ns/v0";
const GATEWAY_URL = (process.env.GATEWAY_URL || "https://api.4a4.ai").replace(/\/$/, "");
const INGEST_WAIT_MS = 5000;

const SEEDS = {
  alice: "4a/phase-3/example/alice/v1",
  bob: "4a/phase-3/example/bob/v1",
  carol: "4a/phase-3/example/carol/v1",
};

// base32 lowercase RFC 4648, matches gateway/src/lib/blake3-tag.ts encoding.
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

function deriveKey(seed) {
  // SHA-256(seed) gives a 32-byte scalar < 2^256. The probability that any
  // such hash exceeds the secp256k1 curve order N is ~1 in 2^128 — for our
  // three fixed seeds we just trust it. nostr-tools' getPublicKey will
  // throw if the scalar happens to be invalid, which is the right failure.
  return new Uint8Array(createHash("sha256").update(seed).digest());
}

function makeKeypair(name, seed) {
  const sk = deriveKey(seed);
  const pk = getPublicKey(sk);
  const npub = nip19.npubEncode(pk);
  return { name, seed, sk, pk, npub };
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function findTag(event, name) {
  const t = event.tags.find((x) => x[0] === name);
  return t ? t[1] : null;
}

function addrOf(event, pubkey) {
  const d = findTag(event, "d");
  return `${event.kind}:${pubkey}:${d}`;
}

// ─── event builders ─────────────────────────────────────────────────────────

function buildBobClaim(bob) {
  const dTag = "next-jit-claim-1";
  const about = "https://github.com/example/next";
  const payload = {
    "@context": CONTEXT_URL,
    "@type": "Claim",
    author: { "@id": `nostr:${bob.pk}` },
    datePublished: new Date().toISOString().slice(0, 10),
    about: { "@id": about },
    appearance:
      "next/jit reduces TTI by 30% on the standard benchmark workload (tti_improvement_pct = 30).",
  };
  const content = JSON.stringify(payload);
  return finalizeEvent(
    {
      kind: 30501,
      created_at: nowSec(),
      tags: [
        ["d", dTag],
        ["blake3", blake3ContentTag(content)],
        ["alt", "Claim: next/jit reduces TTI by 30% on the standard benchmark workload."],
        ["fa:context", CONTEXT_URL],
        ["t", "phase-3-example"],
      ],
      content,
    },
    bob.sk,
  );
}

function buildScore(scorer, target, opts) {
  // target = the Nostr event being scored. Score d-tag is target.id (per
  // SPEC stub §2.1: "Stable per-target slug" — the canonical convention is
  // to use the target event id so a (scorer, target) pair has a single
  // canonical address). a-tag points at target's addressable triple.
  const targetId = target.id;
  const targetAddr = addrOf(target, target.pubkey);
  const payload = {
    "@context": CONTEXT_URL,
    "@type": "Score",
    value: opts.value,
    target: { "@id": `nostr:${targetId}` },
  };
  if (opts.tier) payload.tier = opts.tier;
  const content = JSON.stringify(payload);
  return finalizeEvent(
    {
      kind: 30506,
      created_at: nowSec(),
      tags: [
        ["d", targetId],
        ["e", targetId],
        ["a", targetAddr],
        ["blake3", blake3ContentTag(content)],
        ["alt", `score ${opts.value} of ${targetId.slice(0, 8)}…`],
        ["fa:context", CONTEXT_URL],
      ],
      content,
    },
    scorer.sk,
  );
}

function buildRationale(commenter, scoreEvent, opts) {
  // Pairs with a score event per SPEC stub §4.1: same author, e-tag references
  // the score, created_at within 24h of the score. Comment d-tag is namespaced
  // by the score id prefix so a commenter can edit (NIP-33 supersession) by
  // republishing under the same d-tag.
  const scoreId = scoreEvent.id;
  const scoreAddr = addrOf(scoreEvent, commenter.pk);
  const dTag = `justify-${scoreId.slice(0, 8)}`;
  const payload = {
    "@context": CONTEXT_URL,
    "@type": "Comment",
    intent: opts.intent,
    body: opts.body,
    target: { "@id": `nostr:${scoreId}` },
  };
  const content = JSON.stringify(payload);
  return finalizeEvent(
    {
      kind: 30507,
      created_at: nowSec(),
      tags: [
        ["d", dTag],
        ["e", scoreId],
        ["a", scoreAddr],
        ["blake3", blake3ContentTag(content)],
        ["alt", `rationale for score ${opts.value} of ${scoreId.slice(0, 8)}…`],
        ["fa:context", CONTEXT_URL],
      ],
      content,
    },
    commenter.sk,
  );
}

// ─── publish + verify helpers ───────────────────────────────────────────────

async function publishToRelays(pool, label, event) {
  const results = await Promise.allSettled(pool.publish(RELAYS, event));
  const accepted = results.filter((r) => r.status === "fulfilled").length;
  const rejected = results
    .filter((r) => r.status === "rejected")
    .map((r) => String(r.reason).slice(0, 80));
  console.log(
    `  ${label.padEnd(28)} ${accepted}/${RELAYS.length} accepted` +
      (rejected.length ? ` (${rejected.length} rejected: ${rejected.join("; ")})` : ""),
  );
  return accepted;
}

async function verifyViaGateway(label, event) {
  const addr = addrOf(event, event.pubkey);
  const url = `${GATEWAY_URL}/v0/object/${encodeURIComponent(addr)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  ${label.padEnd(28)} FAIL HTTP ${res.status} ${addr}`);
      return false;
    }
    const body = await res.json();
    const ok = body.id === event.id;
    console.log(`  ${label.padEnd(28)} ${ok ? "PASS" : "FAIL"} ${addr}`);
    return ok;
  } catch (err) {
    console.log(`  ${label.padEnd(28)} FAIL ${err.message}`);
    return false;
  }
}

function verifyPairing(label, score, rationale) {
  // SPEC stub §4.1 pairing predicate.
  const sameAuthor = score.pubkey === rationale.pubkey;
  const eTagOk = (rationale.tags.find((t) => t[0] === "e") || [])[1] === score.id;
  const within24h = Math.abs(rationale.created_at - score.created_at) <= 86400;
  const valid =
    rationale.kind === 30507 && rationale.content && rationale.tags.some((t) => t[0] === "blake3");
  const pass = sameAuthor && eTagOk && within24h && valid;
  console.log(
    `  ${label.padEnd(28)} ${pass ? "PASS" : "FAIL"}` +
      ` (sameAuthor=${sameAuthor} eTag=${eTagOk} dt=${rationale.created_at - score.created_at}s)`,
  );
  return pass;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  const alice = makeKeypair("alice", SEEDS.alice);
  const bob = makeKeypair("bob", SEEDS.bob);
  const carol = makeKeypair("carol", SEEDS.carol);

  console.log("--- pubkeys (deterministic from seed) ---");
  for (const k of [alice, bob, carol]) {
    console.log(`  ${k.name.padEnd(6)} hex=${k.pk}  npub=${k.npub}`);
  }

  const bobClaim = buildBobClaim(bob);
  const aliceScore = buildScore(alice, bobClaim, { value: 0.82, tier: "verified" });
  const aliceRationale = buildRationale(alice, aliceScore, {
    intent: "justify",
    value: 0.82,
    body:
      "Reproduced the benchmark on commit 7f3c with identical wall-clock numbers (±2%). " +
      "The claim's confidence interval seems tight but within tolerance for the workload class. " +
      "Marking 0.82 rather than 0.95 because I did not reproduce the cold-start path.",
  });
  const carolScore = buildScore(carol, aliceScore, { value: 0.55 });
  const carolRationale = buildRationale(carol, carolScore, {
    intent: "challenge",
    value: 0.55,
    body:
      "Alice's reproduction is solid but underweights the cold-start regression that ships in " +
      "the same release. The benchmark she ran does not exercise the new constant-pool path. " +
      "Holding her score at 0.55 because the methodology is sound but the scope is incomplete.",
  });

  const events = [
    ["bob claim (30501)", bobClaim],
    ["alice score (30506)", aliceScore],
    ["alice rationale (30507)", aliceRationale],
    ["carol score (30506)", carolScore],
    ["carol rationale (30507)", carolRationale],
  ];

  console.log("\n--- built and signed ---");
  for (const [name, ev] of events) {
    console.log(
      `  ${name.padEnd(28)} id=${ev.id} d=${findTag(ev, "d")?.slice(0, 16) || ""}…`,
    );
  }

  console.log("\n--- publishing to relays ---");
  const pool = new SimplePool();
  let publishOk = true;
  for (const [name, ev] of events) {
    const accepted = await publishToRelays(pool, name, ev);
    if (accepted === 0) publishOk = false;
  }

  console.log(`\nwaiting ${INGEST_WAIT_MS}ms for gateway ingest…`);
  await new Promise((r) => setTimeout(r, INGEST_WAIT_MS));

  console.log("\n--- verifying via gateway /v0/object ---");
  let verifyOk = true;
  for (const [name, ev] of events) {
    const ok = await verifyViaGateway(name, ev);
    if (!ok) verifyOk = false;
  }

  console.log("\n--- pairing checks (§4.1) ---");
  const pairingA = verifyPairing("Example A (alice→bob)", aliceScore, aliceRationale);
  const pairingB = verifyPairing("Example B (carol→alice)", carolScore, carolRationale);

  // ── persist fixtures ──────────────────────────────────────────────────────
  console.log("\n--- writing fixtures ---");
  const fixtures = {
    "bob-claim.json": bobClaim,
    "example-a-score.json": aliceScore,
    "example-a-rationale.json": aliceRationale,
    "example-b-score.json": carolScore,
    "example-b-rationale.json": carolRationale,
  };
  for (const [filename, ev] of Object.entries(fixtures)) {
    const path = join(FIXTURES_DIR, filename);
    writeFileSync(path, JSON.stringify(ev, null, 2) + "\n");
    console.log(`  wrote ${path}`);
  }

  const pubkeysPath = join(FIXTURES_DIR, "pubkeys.md");
  const pubkeysDoc = `# Phase 3 v0 worked-examples test pubkeys

Three deterministic test pubkeys used to publish the SPEC §§8.1, 8.2 worked
examples on the live 4A relay set. Keys are derived as SHA-256(\`<seed>\`) and
treated directly as secp256k1 secret scalars.

| name  | seed (UTF-8 string)                  | pubkey (hex)                                                       | npub                                                          |
| ----- | ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| alice | \`${SEEDS.alice}\` | \`${alice.pk}\` | \`${alice.npub}\` |
| bob   | \`${SEEDS.bob}\`   | \`${bob.pk}\` | \`${bob.npub}\` |
| carol | \`${SEEDS.carol}\` | \`${carol.pk}\` | \`${carol.npub}\` |

## Reproducing

\`\`\`js
import { createHash } from "node:crypto";
import { getPublicKey } from "nostr-tools";

const seed = "${SEEDS.alice}";
const sk = new Uint8Array(createHash("sha256").update(seed).digest());
const pk = getPublicKey(sk);
\`\`\`

Run \`node scripts/phase-3-examples.mjs\` to regenerate (idempotent — relays
deduplicate by event id, gateway addressable triples are replaceable).

## Why deterministic seeds

The 4A CLI's \`keygen\` subcommand is documented in the README but not yet
implemented at v0. Until it is, the worked-example fixtures use deterministic
test keys so anyone can verify the published events came from the documented
identities. Real users get fresh keys via the gateway's custodial OAuth flow
or by signing locally with their own nsec.

## Addressable triples published

- Bob claim:        \`30501:${bob.pk}:next-jit-claim-1\`
- Alice score:      \`30506:${alice.pk}:${bobClaim.id}\`
- Alice rationale:  \`30507:${alice.pk}:justify-${aliceScore.id.slice(0, 8)}\`
- Carol score:      \`30506:${carol.pk}:${aliceScore.id}\`
- Carol rationale:  \`30507:${carol.pk}:justify-${carolScore.id.slice(0, 8)}\`
`;
  writeFileSync(pubkeysPath, pubkeysDoc);
  console.log(`  wrote ${pubkeysPath}`);

  pool.close(RELAYS);

  // ── summary ──────────────────────────────────────────────────────────────
  const overall = publishOk && verifyOk && pairingA && pairingB;
  console.log("");
  console.log("--- summary ---");
  console.log(`  publish to relays:    ${publishOk ? "PASS" : "FAIL"}`);
  console.log(`  gateway verify:       ${verifyOk ? "PASS" : "FAIL"}`);
  console.log(`  pairing example A:    ${pairingA ? "PASS" : "FAIL"}`);
  console.log(`  pairing example B:    ${pairingB ? "PASS" : "FAIL"}`);
  console.log("");
  console.log(`OVERALL: ${overall ? "PASS" : "FAIL"}`);

  // Print compact id+address summary for the dispatcher result.
  console.log("");
  console.log("--- ids ---");
  console.log(`bob_claim_event_id        ${bobClaim.id}`);
  console.log(`alice_score_event_id      ${aliceScore.id}`);
  console.log(`alice_rationale_event_id  ${aliceRationale.id}`);
  console.log(`carol_score_event_id      ${carolScore.id}`);
  console.log(`carol_rationale_event_id  ${carolRationale.id}`);
  console.log("");
  console.log("--- addresses ---");
  console.log(`bob_claim_address         ${addrOf(bobClaim, bob.pk)}`);
  console.log(`alice_score_address       ${addrOf(aliceScore, alice.pk)}`);
  console.log(`alice_rationale_address   ${addrOf(aliceRationale, alice.pk)}`);
  console.log(`carol_score_address       ${addrOf(carolScore, carol.pk)}`);
  console.log(`carol_rationale_address   ${addrOf(carolRationale, carol.pk)}`);

  process.exit(overall ? 0 : 1);
}

main().catch((err) => {
  console.error("phase-3-examples crashed:", err);
  process.exit(1);
});
