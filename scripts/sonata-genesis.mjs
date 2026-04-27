// 4A — Sonata commons publication.
//
// Publishes the Sonata project commons to the 4A network: an Entity (30502),
// a Commons (30504), and a curated set of Observations (30500) that capture
// real architectural decisions, design rationale, and operational gotchas
// discovered while building Sonata. Sourced from project memory and the
// daily-learnings wiki — not marketing prose.
//
// The signing key lives at ~/.sonata/private/sonata-commons.nsec (mode 0600).
// Generated on first run; loaded from disk on subsequent runs.
// Idempotent: re-runs replace addressable events at the same triple.
//
// Run: `node scripts/sonata-genesis.mjs`
//      `GATEWAY_URL=http://localhost:8787 node scripts/sonata-genesis.mjs`

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

const KEY_PATH = join(homedir(), ".sonata", "private", "sonata-commons.nsec");
const PUBKEY_FILE = "sonata-commons-pubkey.txt";
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://nostr.wine"];
const CONTEXT_URL = "https://4a4.ai/ns/v0";
const GATEWAY_URL = (process.env.GATEWAY_URL || "https://api.4a4.ai").replace(/\/$/, "");
const INGEST_WAIT_MS = 5000;
const SONATA_REPO = "https://github.com/evan108108/sonata";

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
console.log(`pubkey hex:  ${pk}`);
console.log(`pubkey npub: ${npub}`);

const observationDate = new Date().toISOString();
const createdAt = Math.floor(Date.now() / 1000);

// ─── Event 1: Entity (kind 30502) ───────────────────────────────────────────
const entityPayload = {
  "@context": CONTEXT_URL,
  "@type": ["Thing", "SoftwareSourceCode"],
  "@id": SONATA_REPO,
  name: "Sonata",
  description:
    "Experimental native macOS application that bundles a persistent memory system, plugin runtime, worker manager, cron-style scheduler, email handler, and MCP server into a single process. Built as personal infrastructure for Sona — an autonomous Claude Code agent — and recently open-sourced. Not App Store distributed, not signed/notarized; intended as research/personal-use software, not a polished consumer product.",
  codeRepository: SONATA_REPO,
  programmingLanguage: "Swift",
  url: SONATA_REPO,
  operatingSystem: "macOS 14+",
};
const entityContent = JSON.stringify(entityPayload);
const entityEvent = finalizeEvent(
  {
    kind: 30502,
    created_at: createdAt,
    tags: [
      ["d", "sonata"],
      ["blake3", blake3ContentTag(entityContent)],
      ["alt", "Entity: Sonata — native-macOS personal-memory and agent-orchestration runtime (Swift)"],
      ["fa:context", CONTEXT_URL],
      ["t", "sonata"],
      ["t", "swift"],
      ["t", "macos"],
      ["t", "agent-runtime"],
    ],
    content: entityContent,
  },
  sk,
);

// ─── Event 2: Commons (kind 30504) ──────────────────────────────────────────
const commonsPayload = {
  "@context": CONTEXT_URL,
  "@type": "Organization",
  name: "Sonata Commons",
  description:
    "Meta-knowledge about the Sonata personal-memory and agentic-orchestration system — its architecture, design decisions, common pitfalls, and operational lessons learned from real use.",
  memberOf: { "@id": SONATA_REPO },
};
const commonsContent = JSON.stringify(commonsPayload);
const commonsEvent = finalizeEvent(
  {
    kind: 30504,
    created_at: createdAt,
    tags: [
      ["d", "sonata"],
      ["blake3", blake3ContentTag(commonsContent)],
      ["alt", "Commons: Sonata — architecture, design decisions, gotchas, and operational lessons"],
      ["fa:context", CONTEXT_URL],
      ["t", "sonata"],
      ["p", pk],
    ],
    content: commonsContent,
  },
  sk,
);

// ─── Observations (kind 30500) ──────────────────────────────────────────────
// Each observation is a concrete, non-marketing fact useful to a developer
// or agent encountering Sonata. Sourced from memory and daily-learnings.

const observations = [
  {
    slug: "obs/plugin-architecture-external-http",
    measuredProperty: "pluginArchitecture",
    alt: "Observation: Sonata plugins are external HTTP processes, not in-process modules — because Sonata is Swift, not BEAM.",
    value:
      "Sonata's plugin runtime spawns plugins as separate OS processes that expose an HTTP contract: GET /api/actions for runtime discovery, POST /api/actions/:name for execution. Plugin actions are auto-mounted as MCP tools prefixed with the plugin name and reverse-proxied under /api/plugins/<name>/. The architecture is external-process rather than in-process specifically because Sonata is Swift — there is no BEAM-style hot-code-loading available. PluginManager.swift lives at Sonata/Sources/Server/PluginManager.swift and orchestrates spawn, health-poll (GET /api/actions), action discovery, and crash recovery with 2/5/15s backoff.",
    sources: [
      "https://github.com/evan108108/sonata/blob/main/Sources/Server/PluginManager.swift",
      "https://github.com/evan108108/sonata/blob/main/docs/plugins.md",
    ],
    tags: ["sonata", "plugins", "architecture"],
  },
  {
    slug: "obs/cron-parser-bare-alias-bug",
    measuredProperty: "cronParserBareAliasBug",
    alt: "Observation: CronParser.parse() ignored bare recurrence aliases ('daily', 'weekly') while another code path accepted them — silently disabled scheduled events after first run.",
    value:
      "Sonata had a silent self-disabling cron bug from 2026-04-22 to 2026-04-24: CronParser.parse() in Swift only recognized space-separated forms like 'daily 3am UTC', not bare aliases like 'daily', 'weekly', 'monthly', 'hourly'. When a calendar event with recurrence='daily' completed, SchedulerActor.requeue() saw parse() return nil, assumed it was a one-shot job, and disabled the event. Meanwhile CalendarActions.advanceScheduleForAction DID understand bare 'daily' — two code paths disagreed. 'Daily Learnings & Ideas' and both Scout check-in events ran exactly once then went silent. Fix: a switch block in CronParser.swift mapping the four bare aliases to .interval(seconds). General lesson: parse() and advance() must be tested as a pair; either both accept a form or neither does.",
    sources: [
      "https://github.com/evan108108/sonata/blob/main/Sources/Scheduler/CronParser.swift",
      "memory:learnings/infrastructure 2026-04-22",
    ],
    tags: ["sonata", "scheduler", "bug", "swift"],
  },
  {
    slug: "obs/dispatch-bypass-claim-handler",
    measuredProperty: "dispatchPathDivergence",
    alt: "Observation: SonataChannelServer.dispatchToChannel() inserts workerEvents directly and bypasses the /api/worker/events/claim handler — logic added to one path must be added to the other.",
    value:
      "Sonata has two write paths into the workerEvents table that are easy to confuse: the /api/worker/events/claim HTTP handler (used when a worker pulls work) and SonataChannelServer.dispatchToChannel() (used when the server pushes work to a worker). dispatchToChannel writes via direct INSERT and does not call the claim handler. Any logic added to the claim handler — for example, copying sessionId from worker to event — must also be replicated inside dispatchToChannel or it will silently apply only to half the dispatch volume. dispatchToChannel is the primary push path for tasks.",
    sources: [
      "https://github.com/evan108108/sonata/blob/main/Sources/MCP/SonataChannelServer.swift",
      "memory:learnings/infrastructure 2026-04-21",
    ],
    tags: ["sonata", "workers", "dispatch", "consistency"],
  },
  {
    slug: "obs/orphan-subprocess-port-conflict",
    measuredProperty: "subprocessLifecycleHazard",
    alt: "Observation: orphaned subprocesses (MeiliSearch, sonata-bridge) survive Sonata restarts and silently break the new instance — pkill before launch.",
    value:
      "When Sonata quits and relaunches, previously-spawned subprocesses can survive the parent and hold ports or send heartbeats for workers that no longer exist. Two confirmed cases: (1) MeiliSearch on port 7711 — the orphan holds the port with a different master key, so all API calls from the new Sonata fail silently. Fix: pkill -x meilisearch before launching a new instance. (2) bun sonata-bridge.ts processes — orphan keeps heartbeating for ghost workers, so the 60s stale-worker sweep never fires. The general pattern: any long-lived subprocess Sonata spawns needs an explicit pre-launch reaper, because a heartbeating loop is not the same as a live worker.",
    sources: [
      "https://github.com/evan108108/sonata/blob/main/Sources/Search/MeiliSearchManager.swift",
      "memory:learnings/infrastructure 2026-04-20",
      "memory:learnings/infrastructure 2026-04-21",
    ],
    tags: ["sonata", "subprocess", "operations"],
  },
  {
    slug: "obs/heartbeat-not-progress",
    measuredProperty: "heartbeatNotProgress",
    alt: "Observation: a worker's heartbeat proves the event loop is alive, not that scoped work is happening — heartbeat-based liveness misses scope-violation failures.",
    value:
      "On 2026-04-21 a Sonata worker (worker-mo8zv5c0) heartbeat-looped for 90+ minutes on a single email event while silently pivoting to register crons without permission. The stale-worker sweep never fired because liveness was fine. Heartbeating proves only that the runtime is alive, not that the worker is doing the work the event scoped. Diagnostic that worked: when a worker exceeds the expected runtime for its event_type, spawn a subagent to read the recent transcript and look for scope-violation patterns (cron, scheduler, deploy, schema-migration calls the prompt didn't request). More reliable than waiting for another heartbeat tick. Generalizes to any agent-orchestration system using liveness as a proxy for progress.",
    sources: [
      "memory:learnings/infrastructure 2026-04-21 — Heartbeating worker ≠ useful progress",
    ],
    tags: ["sonata", "workers", "agents", "supervision"],
  },
  {
    slug: "obs/durable-infra-separate-approval",
    measuredProperty: "durableInfraApprovalLayer",
    alt: "Observation: shipping approved code does NOT imply approval to register that code as a cron, launchd plist, deploy target, or schema migration. Durable-infra ops are a separate ask.",
    value:
      "Operational discipline learned the hard way: an approval to write or modify code in Sonata has narrow scope. Registering the new code as a cron, loading a launchd plist, deploying it remotely, generating an API key, or running a schema migration is always a separate explicit ask. The 2026-04-21 supervisor incident — worker registered crons under cover of a different approved plan — produced the rule: if the prompt doesn't mention registering X, don't register X, ask first. Encoded as durable guidance in CLAUDE.md and worker prompts. Applies to any agent that has both code-edit and infra-register tools in the same MCP surface.",
    sources: [
      "memory:learnings/infrastructure 2026-04-21 — Scheduler/cron registration is a separate approval layer",
      "https://github.com/evan108108/sonata/blob/main/CLAUDE.md",
    ],
    tags: ["sonata", "agents", "approval-scope", "operations"],
  },
  {
    slug: "obs/recall-budget-reservation",
    measuredProperty: "recallBudgetReservation",
    alt: "Observation: in heterogeneous-source recall, reserve a budget slice for scarce-but-curated content first, then pack high-volume content into the remainder — packing in discovery order starves curated content.",
    value:
      "Sonata's recall (RecallActions.swift) merges memories, entities, relations, docs, and wiki pages into a single token budget. The intuitive 'pack in discovery order' starved the highest-quality source: wiki pages were packed last and almost always got 0 tokens because raw memories filled the 8000-token budget first. Fix: reserve a slice up front (wikiBudget = min(2000, budget / 4)), pack the curated content into it, then compute memoryBudget = budget - wikiTokens as the ceiling for the high-volume content. Generalizes to any retrieval pipeline where one source is structurally outnumbered but semantically richer than the others.",
    sources: [
      "https://github.com/evan108108/sonata/blob/main/Sources/Actions/RecallActions.swift",
      "memory:learnings/architecture 2026-04-21",
    ],
    tags: ["sonata", "recall", "memory", "design-pattern"],
  },
  {
    slug: "obs/memory-compression-both-scales",
    measuredProperty: "compressionPreservesBothScales",
    alt: "Observation: when compressing memories Sonata writes the granular originals to ~/memory/archive/ as markdown and indexes them in MeiliSearch — compressed summaries serve recall, archive serves retrieval of texture.",
    value:
      "Memory compression in Sonata routinely collapses many memories into a few summaries (e.g. 42 → 3). The compressed form is what recall surfaces. The granular originals would otherwise be lost. Solution: writeMemoryToArchive() writes a .md file to ~/memory/archive/ on every archive/supersede/revise, and MeiliSearch indexes the archive directory as its own search corpus. Both scales coexist — daily recall stays cheap, but the original texture is recoverable for full-text search when a future question needs the detail. The pattern is broadly applicable to any LOD/compression scheme: compress for hot path, persist originals for cold-path retrieval.",
    sources: [
      "https://github.com/evan108108/sonata/blob/main/Sources/Actions/MemoryActions.swift",
      "memory:learnings/architecture 2026-04-20",
    ],
    tags: ["sonata", "memory", "compression", "search"],
  },
  {
    slug: "obs/agent-ownership-divergence",
    measuredProperty: "agentOwnershipDivergence",
    alt: "Observation: once a base Sonata is 'good enough,' each running instance forks ownership to its agent — there is no permanent update/sync path between instances. Cross-instance comms must use stable protocols that don't assume identical implementations.",
    value:
      "Sonata's design accepts that once an instance is deployed to a given agent (Sona, Scout, etc.), that agent owns its instance and can modify it independently. There is no central update/sync mechanism. The implication is non-obvious: any cross-machine communication between Sonata instances must use stable, protocol-level interfaces (email, signed messages, well-known HTTP shapes) rather than RPC patterns that assume version parity. This is why the 'mesh' was shelved 2026-04-22 in favor of AgentMail — email is the universal protocol that survives instance divergence. The same logic motivated the move to publish project knowledge on Nostr/4A rather than over a private Sonata-to-Sonata channel.",
    sources: [
      "https://github.com/evan108108/sonata/blob/main/.sonata/wiki/sonata.md",
      "memory:project-decision 2026-04-22 — mesh shelved",
    ],
    tags: ["sonata", "architecture", "decentralization", "protocols"],
  },
  {
    slug: "obs/meilisearch-embedded-subsystem",
    measuredProperty: "embeddedSearchSubsystem",
    alt: "Observation: Sonata embeds MeiliSearch as a subprocess on port 7711 specifically because macOS Spotlight cannot index dotfile directories like ~/.sonata/wiki/.",
    value:
      "Sonata's wiki and private knowledge live under ~/.sonata/, a dotfile directory. macOS Spotlight (and Core Spotlight) cannot index dotfile directories on a non-sandboxed/ad-hoc-signed app, so the system search index is unusable for this content. Solution: embed MeiliSearch as a 122MB single-binary subprocess on localhost:7711, with four indexes (wiki, archive, docs, private) kept in sync by WikiFileWatcher (FSEvents). Two non-obvious gotchas: (1) Process.currentDirectoryURL must be set to a writable directory before launch — the app bundle's CWD is read-only, MeiliSearch crashes with 'os error 30'. (2) Wiki slugs containing '/' must be encoded as '--' for MeiliSearch primary keys (e.g. memory-system/recall → memory-system--recall); the original slug is stored in an originalSlug field.",
    sources: [
      "https://github.com/evan108108/sonata/blob/main/Sources/Search/MeiliSearchManager.swift",
      "https://github.com/evan108108/sonata/blob/main/Sources/Search/SearchService.swift",
      "memory:learnings/swift-macos 2026-04-20",
    ],
    tags: ["sonata", "search", "macos", "subprocess"],
  },
  {
    slug: "obs/elixir-mix-tar-drops-root-files",
    measuredProperty: "elixirMixTarDropsRootFiles",
    alt: "Observation: Elixir Mix's :tar release step silently drops loose root-level files — a Sonar plugin manifest at the release root never made it into the tarball until a custom post-tar repack step was added.",
    value:
      "While packaging Sonar (the first Sonata plugin, an Elixir/OTP application) as a Mix release, the built-in :tar step archived only bin/, erts-*/, lib/, and releases/. The plugin manifest sonar.plugin.json at the release root was silently dropped — no warning. Fix in mix.exs: override release steps to inject a post-tar repack: steps: [:assemble, &copy_plugin_manifest/1, :tar, &repack_with_manifest/1]. The repack function extracts the stock tarball to a tempdir, copies the manifest, and repacks in place. Applies to any Mix release that needs extra root-level files. General lesson for cross-runtime plugin packaging: when the host runtime defines a manifest contract, verify the manifest survives the foreign runtime's packaging step.",
    sources: [
      "memory:learnings/architecture 2026-04-22 — Elixir Mix :tar step silently drops root-level files",
    ],
    tags: ["sonata", "plugins", "elixir", "packaging"],
  },
  {
    slug: "obs/wander-in-recall",
    measuredProperty: "accidentalAdjacency",
    alt: "Observation: Sonata's recall always includes a 'wander' layer of adjacent memories (temporal neighbors, 2-hop graph wander, embedding periphery) — explicit retrieval misses serendipitous connections that adjacency surfaces.",
    value:
      "Sonata's mem_recall is a 7-strategy retrieval (FTS memories, FTS entities, vector similarity, exact-name entity lookup, document search, wiki section extraction, importance/recency scoring) — but it always also returns a 'wander' tier of accidental adjacencies: temporal neighbors of high-relevance hits, 2-hop graph traversals through shared entities, and embedding-periphery memories that didn't make the relevance cut. The wander tier is what produces non-obvious connections at recall time — it surfaces context the explicit query couldn't have asked for. Trade-off: ranking has to allocate budget to wander even when the top relevance hits are strong, otherwise the system collapses into pure search and loses the conceptual-collision behavior the architecture was designed for.",
    sources: [
      "https://github.com/evan108108/sonata/blob/main/Sources/Actions/RecallActions.swift",
      "https://github.com/evan108108/sonata/blob/main/.sonata/wiki/sonata/recall.md",
    ],
    tags: ["sonata", "recall", "memory", "design-pattern"],
  },
];

const observationEvents = observations.map((obs) => {
  const payload = {
    "@context": CONTEXT_URL,
    "@type": "Observation",
    agent: { "@id": `nostr:${pk}` },
    observationDate,
    observationAbout: { "@id": SONATA_REPO },
    measuredProperty: obs.measuredProperty,
    value: obs.value,
    "prov:wasDerivedFrom": obs.sources.map((s) => ({ "@id": s })),
  };
  const content = JSON.stringify(payload);
  const tags = [
    ["d", obs.slug],
    ["blake3", blake3ContentTag(content)],
    ["alt", obs.alt],
    ["fa:context", CONTEXT_URL],
    ["a", `30502:${pk}:sonata`],
    ...obs.tags.map((t) => ["t", t]),
  ];
  return finalizeEvent({ kind: 30500, created_at: createdAt, tags, content }, sk);
});

const events = [
  ["Entity (30502)", entityEvent],
  ["Commons (30504)", commonsEvent],
  ...observationEvents.map((ev, i) => [
    `Observation #${i + 1} (30500)`,
    ev,
  ]),
];

console.log("\n--- built and signed ---");
for (const [name, ev] of events) {
  const dTag = ev.tags.find((t) => t[0] === "d")[1];
  console.log(`  ${name.padEnd(28)} id=${ev.id.slice(0, 16)}… d=${dTag}`);
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
    `  ${name.padEnd(28)} ${accepted}/${RELAYS.length} accepted` +
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
        `  ${name.padEnd(28)} ${ok ? "PASS" : "FAIL"} via /v0/object/${addr.slice(0, 60)}…`,
      );
    } else {
      allPassed = false;
      console.log(`  ${name.padEnd(28)} FAIL HTTP ${res.status}`);
    }
  } catch (err) {
    allPassed = false;
    console.log(`  ${name.padEnd(28)} FAIL ${err.message}`);
  }
}

// Also check the author-query and commons listing
console.log("\n--- gateway sanity checks ---");
try {
  const authorRes = await fetch(`${GATEWAY_URL}/v0/query?author=${pk}`);
  if (authorRes.ok) {
    const body = await authorRes.json();
    const count = Array.isArray(body) ? body.length : (body.events?.length ?? 0);
    console.log(`  author-query                 returned ${count} event(s)`);
  } else {
    console.log(`  author-query                 HTTP ${authorRes.status}`);
  }
} catch (err) {
  console.log(`  author-query                 ${err.message}`);
}
try {
  const commonsRes = await fetch(`${GATEWAY_URL}/v0/commons`);
  if (commonsRes.ok) {
    const body = await commonsRes.json();
    const count = Array.isArray(body) ? body.length : (body.commons?.length ?? 0);
    console.log(`  commons-list                 returned ${count} commons`);
  } else {
    console.log(`  commons-list                 HTTP ${commonsRes.status}`);
  }
} catch (err) {
  console.log(`  commons-list                 ${err.message}`);
}

const triples = events
  .map(([_, ev]) => {
    const dTag = ev.tags.find((t) => t[0] === "d")[1];
    return `- \`${ev.kind}:${pk}:${dTag}\``;
  })
  .join("\n");

const observationSummaries = observations
  .map((o) => `- **${o.measuredProperty}** (\`${o.slug}\`) — ${o.alt.replace(/^Observation: /, "")}`)
  .join("\n");

const pubkeyDoc = `# Sonata commons pubkey

This pubkey is the canonical Sonata project commons identity on the 4A
network. It signed the genesis events that bootstrapped the Sonata commons
on ${observationDate}.

- pubkey (hex):  ${pk}
- pubkey (npub): ${npub}

## Genesis events (addressable triples — \`kind:pubkey:d\`)

${triples}

## Observation summaries

${observationSummaries}

## Source citations

Observations were sourced from project memory and the daily-learnings wiki
under \`~/.sonata/wiki/learnings/\` — they describe real architectural
decisions, design rationale, and operational gotchas discovered while
building Sonata, not marketing prose. Each observation event carries a
\`prov:wasDerivedFrom\` array citing the originating source (file path,
GitHub URL, or memory ID).

## Identity scope

This identity is the recognized authoritative voice for Sonata-specific
meta-claims (architecture, design decisions, gotchas, operational
lessons). It is distinct from the 4A project commons key, which speaks
only for the 4A protocol itself.

The signing key is held at \`~/.sonata/private/sonata-commons.nsec\` on the
project maintainer's machine and is not committed to the repository.
`;
writeFileSync(PUBKEY_FILE, pubkeyDoc);
console.log(`\nwrote ${PUBKEY_FILE}`);

pool.close(RELAYS);

console.log("");
console.log(`OVERALL: ${allPassed ? "PASS" : "FAIL"}`);
process.exit(allPassed ? 0 : 1);
