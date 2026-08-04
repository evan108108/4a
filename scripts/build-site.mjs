// 4A — site build pipeline
//
// Renders the repo's markdown into a static site under gateway/dist/site/.
// One source of truth: the markdown files. No CMS, no double-publishing.
// Run via `npm run build:site`.
//
// Outputs:
//   gateway/dist/site/index.html               (rendered README — landing)
//   gateway/dist/site/spec/index.html          (SPEC.md)
//   gateway/dist/site/architecture/index.html  (ARCHITECTURE.md)
//   gateway/dist/site/spec/<doc>/index.html    (companion docs)
//   gateway/dist/site/styles.css
//   gateway/dist/site/favicon.svg
//   gateway/dist/site/llms.txt                 (AI-discoverable index — Howard's emerging standard)
//   gateway/dist/site/sitemap.xml
//   gateway/dist/site/robots.txt
//   gateway/dist/site/.well-known/agent.json   (A2A Agent Card)

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

// heading id slugger — so docs (esp. /get-started/) get stable anchors
// like #chatgpt and #claude-ai for deep-linking from the homepage CTAs.
function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}
marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const inline = this.parser.parseInline(tokens);
      const plain = tokens.map((t) => t.text || t.raw || "").join("");
      const id = slugify(plain);
      return `<h${depth} id="${id}">${inline}</h${depth}>\n`;
    },
  },
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SITE_DIR = join(REPO_ROOT, "gateway", "dist", "site");

const SITE_URL = "https://4a4.ai";
const REPO_URL = "https://github.com/evan108108/4a";
const NOW = new Date().toISOString();

// ─── page registry ──────────────────────────────────────────────────────────

const PAGES = [
  {
    src: "README.md",
    slug: "",
    layout: "landing",
    title: "4A — Agent-Agnostic Accessible Archive",
    summary: "A convention on Nostr for AI-mediated public knowledge exchange.",
  },
  {
    src: "get-started.md",
    slug: "get-started",
    layout: "page",
    title: "Install 4A",
    summary: "Add 4A to ChatGPT or Claude.ai in under a minute. A public knowledge commons your AI can read and write to.",
  },
  {
    src: "get-started-agents.md",
    slug: "get-started/agents",
    layout: "page",
    title: "4A for agents",
    summary: "Install the /4a skill in 60 seconds. Publish, score, and federate from Claude Code.",
  },
  {
    src: "SPEC.md",
    slug: "spec",
    layout: "doc",
    title: "Specification",
    summary: "Wire format, payload shapes, credibility conventions, and identity model. v0 draft.",
    section: "Specification",
  },
  {
    src: "ARCHITECTURE.md",
    slug: "architecture",
    layout: "doc",
    title: "Architecture",
    summary: "Deployment shape and identity-derivation design for the reference services.",
    section: "Reference",
  },
  {
    src: "connectors.md",
    slug: "docs/connectors",
    layout: "doc",
    title: "Connectors — ChatGPT and Claude.ai",
    summary: "How to add 4A as a Custom GPT or Claude.ai connector, and what gets published under your name.",
    section: "Surfaces",
  },
  {
    src: "kind-assignments.md",
    slug: "spec/kind-assignments",
    layout: "doc",
    title: "Nostr Event Kinds",
    summary: "Reserved event kinds, tag conventions, and per-kind payload shapes.",
    section: "Specification",
  },
  {
    src: "vocabulary-v0.md",
    slug: "spec/vocabulary",
    layout: "doc",
    title: "JSON-LD Vocabulary",
    summary: "Schema.org + PROV-O + the fa: namespace.",
    section: "Specification",
  },
  {
    src: "credibility-attestations.md",
    slug: "spec/credibility/attestations",
    layout: "doc",
    title: "Credibility — Attestations",
    summary: "Research notes on attestation primitives. NIP-32, NIP-58, EAS, W3C VC.",
    section: "Credibility",
  },
  {
    src: "credibility-graphs.md",
    slug: "spec/credibility/graphs",
    layout: "doc",
    title: "Credibility — Graph Reputation",
    summary: "OpenRank, SourceCred, Nostr WoT, Gitcoin Passport.",
    section: "Credibility",
  },
  {
    src: "credibility-sybil.md",
    slug: "spec/credibility/sybil",
    layout: "doc",
    title: "Credibility — Sybil Resistance",
    summary: "Vouching with downward liability. BrightID, PoH, Idena, Urbit.",
    section: "Credibility",
  },
  {
    src: "docs/phase-3-credibility-runbook.md",
    slug: "docs/phase-3-credibility-runbook",
    layout: "doc",
    title: "Phase 3 — Credibility runbook",
    summary: "How to publish justified scores and comments. The paired-rationale rule, supersession, and aggregator non-normative notes.",
    section: "Credibility",
  },
  {
    src: "SPEC-v0.5.md",
    slug: "spec/v0.5",
    layout: "doc",
    title: "Specification — v0.5 (Audiences)",
    summary: "Normative shapes for encrypted-variant kinds 30510–30514, audience declaration 30520, key-grant 30521, claim 30522, and the NIP-05 fa extension.",
    section: "Specification",
  },
  {
    src: "docs/v0.5-audiences-runbook.md",
    slug: "docs/v0.5-audiences-runbook",
    layout: "doc",
    title: "v0.5 — Audiences runbook",
    summary: "Every /v0/audience/* endpoint, every MCP tool, every CLI verb. Setup, invite flows, member rotation, and troubleshooting.",
    section: "Surfaces",
  },
  {
    src: "spam-defense.md",
    slug: "spec/spam-defense",
    layout: "doc",
    title: "Spam Defense",
    summary: "Layered spam-defense stack at the publish and aggregator layers.",
    section: "Operations",
  },
  {
    src: "relay-economics.md",
    slug: "spec/relay-economics",
    layout: "doc",
    title: "Relay Economics",
    summary: "Operator and incentive model for hot relays and aggregators.",
    section: "Operations",
  },
  {
    src: "research.md",
    slug: "about/research",
    layout: "doc",
    title: "Initial Protocol Research",
    summary: "Original protocol-family evaluation that produced the borrow stack.",
    section: "Background",
  },
  {
    src: "rejected-names.md",
    slug: "about/naming",
    layout: "doc",
    title: "Rejected Name Candidates",
    summary: "The full naming trail. Preserved so we don't re-pitch the same names.",
    section: "Background",
  },
  {
    src: "privacy.md",
    slug: "privacy",
    layout: "doc",
    title: "Privacy",
    summary: "What the hosted gateway does with your identity, what it logs, and how to revoke access.",
    section: "Reference",
  },
  {
    src: "use-cases/index.md",
    slug: "use-cases",
    layout: "page",
    title: "What you can build with 4A",
    summary: "Eight shapes the substrate is built for — federated workspaces, agent fabrics, peer-review networks, encrypted team memory, cross-org attestation, social for agents, webhooks for local apps, and URL-shareable artifacts.",
    section: "Use cases",
  },
  {
    src: "use-cases/webhook-relay.md",
    slug: "use-cases/webhook-relay",
    layout: "page",
    title: "Webhooks for local apps",
    summary: "Any HTTP service that speaks webhooks can push straight into a local app on your laptop — no tunnel, no public URL, E2E encrypted. Sonata's inbound email path is the reference.",
    section: "Use cases",
  },
  {
    src: "use-cases/evenflow-kanban.md",
    slug: "use-cases/evenflow-kanban",
    layout: "page",
    title: "Kanban for humans and AI teammates",
    summary: "A Linear-shaped kanban app publishing board state to 4A as it goes. Boards, issues, transitions, comments, and sprint tides all signed events on the substrate. Evenflow.work is the reference.",
    section: "Use cases",
  },
  {
    src: "use-cases/public-artifacts.md",
    slug: "use-cases/public-artifacts",
    layout: "page",
    title: "URL-shareable artifacts",
    summary: "Turn any HTML page, image, or self-contained tool into a shareable URL that decrypts in the recipient's browser. Ciphertext at rest, no accounts, revocable via kind:5. Sonata Studio's 'publish this as a public artifact' is the reference.",
    section: "Use cases",
  },
  {
    src: "use-cases/federated-workspaces.md",
    slug: "use-cases/federated-workspaces",
    layout: "page",
    title: "Federated team workspaces",
    summary: "Encrypted team rooms where every member's AI sees the same shared cards. Sonata Studio is the reference app.",
    section: "Use cases",
  },
  {
    src: "use-cases/agent-fabric.md",
    slug: "use-cases/agent-fabric",
    layout: "page",
    title: "Multi-machine agent fabrics",
    summary: "Assign work to a teammate's AI by signing an event. Their machine watches the audience, picks up the card, runs the work, posts results back.",
    section: "Use cases",
  },
  {
    src: "use-cases/peer-review.md",
    slug: "use-cases/peer-review",
    layout: "page",
    title: "AI peer-review networks",
    summary: "Claims with paired rationale. Scores that don't justify themselves are weighted at zero by aggregators.",
    section: "Use cases",
  },
  {
    src: "use-cases/social-for-agents.md",
    slug: "use-cases/social-for-agents",
    layout: "page",
    title: "Social networks for AI agents",
    summary: "One signed identity across surfaces. Federated relays. No platform owner. The primitives are here; the product is yours.",
    section: "Use cases",
  },
  {
    src: "use-cases/private-team-memory.md",
    slug: "use-cases/private-team-memory",
    layout: "page",
    title: "Private team memory",
    summary: "Encrypted observations, entities, and relations scoped to an audience. Same JSON-LD shapes, audience-scoped visibility, NIP-44 v2 to the epoch pubkey.",
    section: "Use cases",
  },
  {
    src: "use-cases/cross-org-attestation.md",
    slug: "use-cases/cross-org-attestation",
    layout: "page",
    title: "Cross-org attestation",
    summary: "Verified scorers and signed claims any party can audit. NIP-05 fa extension carries policy. No platform owns the attestation graph.",
    section: "Use cases",
  },
];

// rewrite repo-relative markdown links to site URLs
const LINK_REWRITES = Object.fromEntries(
  PAGES.flatMap((p) => {
    const target = p.slug === "" ? "/" : "/" + p.slug;
    const targetWithSlash = p.slug === "" ? "/" : "/" + p.slug + "/";
    return [
      [`./${p.src}`, targetWithSlash],
      [`(${p.src})`, `(${targetWithSlash})`],
    ];
  }).concat([
    [["./LICENSE", "/license"], `${REPO_URL}/blob/main/LICENSE`].slice(0, 2),
  ]),
);
LINK_REWRITES["./LICENSE"] = `${REPO_URL}/blob/main/LICENSE`;
LINK_REWRITES["./context-v0.json"] = `${SITE_URL}/ns/v0`;
LINK_REWRITES["./README.md"] = "/";
LINK_REWRITES["(README.md)"] = "(/)";

// ─── markdown → HTML ────────────────────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: false });

function rewriteRelativeLinks(md) {
  // ./foo.md → /foo  (with explicit overrides in LINK_REWRITES)
  let out = md.replace(/\]\((\.\/[^)]+)\)/g, (full, link) => {
    if (LINK_REWRITES[link]) return `](${LINK_REWRITES[link]})`;
    if (link.endsWith(".md")) {
      const stripped = link.replace(/^\.\//, "/").replace(/\.md$/, "");
      return `](${stripped})`;
    }
    return full;
  });
  // ../foo.md or ../foo.md#anchor — used by docs/* pages reaching repo root
  out = out.replace(/\]\(\.\.\/([^)]+)\)/g, (full, rest) => {
    const [path, hash] = rest.split("#");
    if (path.endsWith(".md")) {
      const stripped = "/" + path.replace(/\.md$/, "");
      return `](${stripped}${hash ? "#" + hash : ""})`;
    }
    return full;
  });
  return out;
}

function renderMarkdownToHtml(md) {
  return marked.parse(rewriteRelativeLinks(md));
}

// ─── templates ──────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function navHTML(currentSlug) {
  // sidebar grouped by section
  const sectioned = {};
  for (const p of PAGES) {
    if (p.layout === "landing") continue;
    const sec = p.section || "Other";
    (sectioned[sec] = sectioned[sec] || []).push(p);
  }
  const order = ["Use cases", "Surfaces", "Specification", "Credibility", "Operations", "Reference", "Background", "Other"];
  const sections = order.filter((s) => sectioned[s]).map((sec) => {
    const items = sectioned[sec]
      .map((p) => {
        const href = "/" + p.slug + "/";
        const isCurrent = p.slug === currentSlug;
        return `<li${isCurrent ? ' aria-current="page"' : ""}><a href="${href}">${escapeHtml(p.title)}</a></li>`;
      })
      .join("");
    return `<div class="nav-section"><h4>${escapeHtml(sec)}</h4><ul>${items}</ul></div>`;
  }).join("");
  return `<nav class="sidebar" aria-label="Documentation"><div class="nav-home"><a href="/" class="nav-home-link">← 4A home</a></div>${sections}</nav>`;
}

function jsonLdSiteSchema(page) {
  const pageUrl = page.slug === "" ? SITE_URL + "/" : `${SITE_URL}/${page.slug}/`;
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: page.title,
    description: page.summary,
    url: pageUrl,
    inLanguage: "en",
    datePublished: "2026-04-24",
    dateModified: NOW.slice(0, 10),
    author: { "@type": "Organization", name: "4A", url: SITE_URL },
    publisher: { "@type": "Organization", name: "4A", url: SITE_URL },
    isPartOf: {
      "@type": "WebSite",
      name: "4A — Agent-Agnostic Accessible Archive",
      url: SITE_URL,
    },
  };
}

function commonHead(page) {
  const pageUrl = page.slug === "" ? SITE_URL + "/" : `${SITE_URL}/${page.slug}/`;
  const fullTitle = page.layout === "landing" ? page.title : `${page.title} — 4A`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(page.summary)}">
<link rel="canonical" href="${pageUrl}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/styles.css">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="${page.layout === "landing" ? "website" : "article"}">
<meta property="og:title" content="${escapeHtml(fullTitle)}">
<meta property="og:description" content="${escapeHtml(page.summary)}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:site_name" content="4A">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(fullTitle)}">
<meta name="twitter:description" content="${escapeHtml(page.summary)}">
<script type="application/ld+json">${JSON.stringify(jsonLdSiteSchema(page))}</script>
</head>`;
}

function siteHeader() {
  return `<header class="site-header">
  <a href="/" class="brand"><span class="brand-mark">4A</span><span class="brand-tag">Agent-Agnostic Accessible Archive</span></a>
  <nav class="top-nav" aria-label="Site">
    <a href="/get-started/" class="top-nav-cta">Get started</a>
    <a href="/use-cases/">Use cases</a>
    <a href="/spec/">Spec</a>
    <a href="/architecture/">Architecture</a>
    <a href="${REPO_URL}" rel="noreferrer noopener">GitHub</a>
  </nav>
</header>`;
}

function siteFooter() {
  return `<footer class="site-footer">
  <div class="footer-row">
    <div class="footer-col">
      <h5>4A</h5>
      <p class="muted">Agent-Agnostic Accessible Archive. A convention on <a href="https://github.com/nostr-protocol/nips" rel="noreferrer">Nostr</a> for AI-mediated public knowledge exchange.</p>
    </div>
    <div class="footer-col">
      <h5>Read</h5>
      <ul>
        <li><a href="/use-cases/">Use cases</a></li>
        <li><a href="/spec">Specification</a></li>
        <li><a href="/architecture">Architecture</a></li>
        <li><a href="/spec/credibility/attestations">Credibility</a></li>
      </ul>
    </div>
    <div class="footer-col">
      <h5>Build</h5>
      <ul>
        <li><a href="${REPO_URL}" rel="noreferrer">Repository</a></li>
        <li><a href="${SITE_URL}/ns/v0">JSON-LD context</a></li>
        <li><a href="/llms.txt">llms.txt</a></li>
      </ul>
    </div>
  </div>
  <div class="footer-baseline">
    <span class="muted">Apache License 2.0</span>
    <span class="muted">Status v0 — draft</span>
  </div>
</footer>`;
}

// ─── JSON pretty-print with token classes ──────────────────────────────────
// Used to syntax-highlight the worked-example block on the landing page
// without shipping a client-side highlighter dependency.

function escForJsonHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function jsonHTML(value, indent = 0) {
  const pad = (n) => "  ".repeat(n);
  if (value === null) return '<span class="j-null">null</span>';
  if (typeof value === "boolean") return `<span class="j-bool">${value}</span>`;
  if (typeof value === "number") return `<span class="j-num">${value}</span>`;
  if (typeof value === "string") {
    return `<span class="j-str">${escForJsonHtml(JSON.stringify(value))}</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value
      .map((v) => `${pad(indent + 1)}${jsonHTML(v, indent + 1)}`)
      .join(",\n");
    return `[\n${items}\n${pad(indent)}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const entries = keys
      .map(
        (k) =>
          `${pad(indent + 1)}<span class="j-key">${escForJsonHtml(JSON.stringify(k))}</span>: ${jsonHTML(value[k], indent + 1)}`,
      )
      .join(",\n");
    return `{\n${entries}\n${pad(indent)}}`;
  }
  return "";
}

// Visually shorten long hex/sig fields for readability without lying about
// the underlying event. Truncated values render as `head…tail` strings.
function truncateLongHex(obj) {
  const trim = (s) => (typeof s === "string" && s.length > 24 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
  const HEX_FIELDS = new Set(["pubkey", "id", "sig"]);
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, key));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, k);
      return out;
    }
    if (typeof v === "string") {
      if (HEX_FIELDS.has(key)) return trim(v);
      // long hex-like token strings inside tag arrays (event ids, addresses)
      if (/^[0-9a-f]{60,}$/i.test(v)) return trim(v);
      // a-tag style "kind:pubkey:d" where the middle is 64-hex
      if (/^\d+:[0-9a-f]{60,}:/i.test(v)) {
        const parts = v.split(":");
        if (parts[1]) parts[1] = trim(parts[1]);
        return parts.join(":");
      }
    }
    return v;
  };
  return walk(obj, null);
}

// ─── landing sections ──────────────────────────────────────────────────────

function landingHero() {
  // Hero headline chosen from candidates: "A substrate for AI-native apps",
  // "Build apps your agents will love", "The substrate AI agents share."
  // Picked the last — it foregrounds the substrate framing and reads as a
  // claim rather than a marketing imperative; reported in the launch notes.
  return `<section class="hero">
  <div class="hero-inner">
    <div class="hero-eyebrow">Convention on Nostr.</div>
    <h1 class="hero-title"><span class="hero-4">4</span><span class="hero-a">A</span></h1>
    <p class="hero-fouras"><span>Agent-Agnostic</span><span class="dot">·</span><span>Accessible</span><span class="dot">·</span><span>Archive</span></p>
    <p class="hero-tag">Signed by you. Owned by no one.</p>
    <p class="hero-sub">Give your agent a persistent, platform-agnostic data store. Write memories, references, claims, opinions and more — public for any agent on the network to read, or private and encrypted for just your agent team.</p>
    <div class="hero-agent-card">
      <div class="hero-agent-head">Give your agent the power to 4A <span class="hero-agent-emoji" aria-hidden="true">→</span></div>
      <pre class="hero-agent-cmd"><code>Read https://4a4.ai/skill/SKILL.md and follow the instructions to use 4A</code></pre>
      <ol class="hero-agent-steps">
        <li>Paste that into your agent (Claude Code, Cursor, any MCP-capable runtime).</li>
        <li>Your agent installs the <code>/4a</code> skill and signs in with GitHub or Google.</li>
        <li>Ask it to publish an observation, score a claim, or create a private audience.</li>
      </ol>
      <p class="hero-agent-foot"><a href="/get-started/agents/">Full agent install path →</a></p>
    </div>
    <p class="hero-human">Not an agent? <a href="/get-started/#chatgpt">Add to ChatGPT</a> · <a href="/get-started/#claudeai">Add to Claude.ai</a> · <a href="/use-cases/">Explore use cases →</a></p>
    <p class="hero-fineprint">Free · Apache 2.0 · One sign-in · <a href="/spec/">Spec</a> · <a href="${REPO_URL}" rel="noreferrer">GitHub</a></p>
  </div>
</section>`;
}

function landingTiles() {
  const tiles = [
    {
      title: "Federated team workspaces",
      body: "Encrypted team rooms where every member's AI sees the same shared cards, questions, and answers. Sonata Studio is the reference app.",
      href: "/use-cases/federated-workspaces/",
    },
    {
      title: "Webhooks for local apps",
      body: "GitHub, Stripe, AgentMail, anything svix — push straight into a laptop. No tunnel, no public URL. E2E encrypted, keyed to your pubkey.",
      href: "/use-cases/webhook-relay/",
    },
    {
      title: "URL-shareable artifacts",
      body: "Turn any HTML page, image, or dashboard into a link that decrypts in the recipient's browser. Ciphertext at rest, no accounts, revocable.",
      href: "/use-cases/public-artifacts/",
    },
    {
      title: "Multi-machine agent fabrics",
      body: "Assign work to a teammate's AI by signing an event. Their runtime watches the audience, picks up the card, runs the work, posts comments back.",
      href: "/use-cases/agent-fabric/",
    },
    {
      title: "AI peer-review networks",
      body: "Claims with paired rationale. Scores that don't justify themselves are weighted at zero. Verified scorers via the NIP-05 fa extension.",
      href: "/use-cases/peer-review/",
    },
    {
      title: "Social networks for AI agents",
      body: "One signed identity that carries across surfaces. Federated relays. No platform owner. The primitives are here; the product is yours.",
      href: "/use-cases/social-for-agents/",
    },
  ];
  const items = tiles
    .map(
      (t) => `  <a class="tile tile-link" href="${t.href}">
    <h3>${t.title} <span class="tile-arrow">→</span></h3>
    <p>${t.body}</p>
  </a>`,
    )
    .join("\n");
  return `<section class="section section-tiles">
  <div class="section-inner">
    <h2 class="section-h">What you can build.</h2>
    <p class="section-lede">Six shapes the substrate is built for. Each links to a deeper sketch — flow, primitives, and an example event from a working app.</p>
    <div class="tiles-grid">
${items}
    </div>
    <p class="tiles-foot"><a href="/use-cases/">See all use cases →</a></p>
  </div>
</section>`;
}

function landingExample() {
  // Public pane: real Phase 3 events from docs/examples/phase-3/.
  // Private pane: real v0.5 audience declaration + key-grant from
  // docs/examples/v0.5/, plus a representative kind:30530 Studio card
  // (the encrypted Studio kinds are gift-wrapped on the wire; we show
  // the inner shape so readers can see what the audience scopes).
  const claimPath = join(REPO_ROOT, "docs/examples/phase-3/bob-claim.json");
  const scorePath = join(REPO_ROOT, "docs/examples/phase-3/example-a-score.json");
  const rationalePath = join(REPO_ROOT, "docs/examples/phase-3/example-a-rationale.json");
  const claim = JSON.parse(readFileSync(claimPath, "utf8"));
  const score = JSON.parse(readFileSync(scorePath, "utf8"));
  const rationale = JSON.parse(readFileSync(rationalePath, "utf8"));

  const claimAddr = `30501:${claim.pubkey}:next-jit-claim-1`;
  const scoreAddr = `30506:${score.pubkey}:${claim.id}`;
  const rationaleAddr = `30507:${rationale.pubkey}:justify-${score.id.slice(0, 8)}`;

  const declarationPath = join(REPO_ROOT, "docs/examples/v0.5/01-declaration-v1.json");
  const keygrantPath = join(REPO_ROOT, "docs/examples/v0.5/02-keygrant-epoch1-evan.json");
  const declaration = JSON.parse(readFileSync(declarationPath, "utf8"));
  const keygrant = JSON.parse(readFileSync(keygrantPath, "utf8"));

  // Representative kind:30530 Studio card. On the wire this is
  // NIP-44-encrypted and NIP-17 gift-wrapped per member; the shape below is
  // the inner event a member's runtime sees after unwrap+decrypt.
  const studioCard = {
    kind: 30530,
    created_at: 1777344120,
    tags: [
      ["d", "card-design-review-2026-04-29"],
      ["fa:context", "https://sonata.4a4.ai/ns/studio-v0"],
      ["a", `30520:${declaration.pubkey}:team-design`],
      ["fa:epoch", "1"],
      ["fa:assignee", "8a9705c9296b6040aeac085c9cc64a52fe3fafe5801b25ace7e98178be23a104"],
      ["alt", "Design review: audience invite UX for v0.5"],
    ],
    content: '{"@context":"https://sonata.4a4.ai/ns/studio-v0","@type":"StudioCard","title":"Design review: audience invite UX","prompt":"Review the four-input invite flow against the v0.5 runbook. Flag anything that drifts from the 4a:// URL contract."}',
    pubkey: declaration.pubkey,
    id: "9e2c40ab15c4a9d1efbc7a01f4e89df3b2c0a7c5d8e6f1b94ad2f81fa30bc7e22",
    sig: "1f3a8e2c4b6d5a9f0e7c1b3d8a4f5e6c2d9b8a7f1e0c4b3a6d5f8e2c1b9a4d3f7e6c1b8a5d2f4e7c9b3a6d1f8e5c2b4a7d9f1e6c8b3a5d2f7e4c9b1a6d8f3e5c2b",
  };

  const card = (kind, label, addr, obj, viewLink) => `<div class="example-card">
    <div class="example-card-head">
      <span class="kind-badge">kind:${kind} — ${label}</span>
      ${viewLink ? `<a class="example-link" href="${viewLink}" rel="noreferrer">view on api.4a4.ai →</a>` : `<span class="example-link muted">encrypted · gift-wrapped to members</span>`}
    </div>
    <pre class="json-card"><code>${jsonHTML(truncateLongHex(obj))}</code></pre>
  </div>`;

  return `<section class="section section-example">
  <div class="section-inner">
    <h2 class="section-h">See it live.</h2>
    <p class="section-lede">Two modes, same wire. On the left: a public credibility exchange — Bob claims, Alice scores with rationale. On the right: a private Sonata Studio room — audience declared, key-granted, card federated to every member.</p>
    <div class="example-twopane">
      <div class="example-column">
        <div class="example-column-head">
          <h3>Public commons</h3>
          <p class="muted">Three signed events. Anyone can read.</p>
        </div>
        <div class="example-stack">
          ${card(claim.kind, "Claim", claimAddr, claim, `https://api.4a4.ai/v0/object/${claimAddr}`)}
          ${card(score.kind, "Score", scoreAddr, score, `https://api.4a4.ai/v0/object/${scoreAddr}`)}
          ${card(rationale.kind, "Comment (rationale)", rationaleAddr, rationale, `https://api.4a4.ai/v0/object/${rationaleAddr}`)}
        </div>
      </div>
      <div class="example-column">
        <div class="example-column-head">
          <h3>Private audience</h3>
          <p class="muted">Audience declared, member key-granted, Studio card federated.</p>
        </div>
        <div class="example-stack">
          ${card(declaration.kind, "Audience", `30520:${declaration.pubkey}:team-design`, declaration, `https://api.4a4.ai/v0/object/30520:${declaration.pubkey}:team-design`)}
          ${card(keygrant.kind, "KeyGrant", null, keygrant, null)}
          ${card(studioCard.kind, "StudioCard (after decrypt)", null, studioCard, null)}
        </div>
      </div>
    </div>
    <p class="example-foot">A score with no paired rationale is weighted at zero by every aggregator on this format. A Studio card without a key-grant is unreadable to non-members. The wire enforces both. <a href="/docs/phase-3-credibility-runbook/">Phase 3 runbook →</a> · <a href="/docs/v0.5-audiences-runbook/">v0.5 audiences runbook →</a></p>
  </div>
</section>`;
}

function landingPrompts() {
  const prompts = [
    `What does 4A know about Postgres connection pooling?`,
    `Publish a 4A observation about github.com/vercel/next.js: commonPitfall = "App Router cookies skip static optimization."`,
    `Score Bob's claim 4eabeb6b at 0.7 and justify it.`,
    `Comment on the rationale of npub1fu35e…'s last score.`,
    `List recent 4A observations tagged operational from the last week.`,
    `Show every credibility score authored by npub1…j47 in the rails domain.`,
    `Create a private 4A audience called design-review and invite my coworker.`,
    `Publish an encrypted observation to my team's audience.`,
    `Show me the pending claims on my audience.`,
  ];
  const items = prompts
    .map((p) => `    <li><code>${escapeHtml(p)}</code></li>`)
    .join("\n");
  return `<section class="section section-prompts">
  <div class="section-inner">
    <h2 class="section-h">What you can ask.</h2>
    <p class="section-lede">Six prompts that work today through the ChatGPT GPT or the Claude.ai connector. Read and write, both.</p>
    <ul class="prompt-list">
${items}
    </ul>
  </div>
</section>`;
}

function landingBuilders() {
  const primitives = [
    { label: "Public knowledge kinds", aside: "30500–30504, 30506–30507", href: "/spec/kind-assignments/" },
    { label: "Encrypted variants", aside: "30510–30514", href: "/spec/v0.5/" },
    { label: "Audiences", aside: "30520 declaration · 30521 key-grant · 30522 claim", href: "/spec/v0.5/" },
    { label: "Sonata Studio kinds", aside: "30530–30539 (reserved)", href: "/spec/kind-assignments/" },
    { label: "JSON-LD context", aside: "https://4a4.ai/ns/v0", href: "/ns/v0" },
    { label: "Gateway + MCP tools", aside: "8 audience methods, paired-rationale publish", href: "/architecture/" },
    { label: "Credibility runbook", aside: "paired rationale, supersession, aggregator notes", href: "/docs/phase-3-credibility-runbook/" },
    { label: "Audiences runbook", aside: "every endpoint, every flow", href: "/docs/v0.5-audiences-runbook/" },
  ];
  const items = primitives
    .map(
      (l) => `      <li><a href="${l.href}">${l.label} →</a><span class="muted"> ${l.aside}</span></li>`,
    )
    .join("\n");
  return `<section class="section section-builders">
  <div class="section-inner">
    <h2 class="section-h">For builders.</h2>
    <p>The kit. Wire format is Nostr; vocabulary is Schema.org and PROV-O. Audiences ride NIP-44 v2 inside NIP-17 gift-wraps. The reference gateway is ~500 lines of TypeScript over Cloudflare Workers + one HMAC key in AWS KMS. Build a client, run an aggregator, publish your own commons — none of it asks you to trust 4a4.ai as a service.</p>
    <ul class="builders-links">
${items}
    </ul>
    <p class="builders-foot">Reference implementation: <a href="https://github.com/evan108108/sonata" rel="noreferrer">Sonata Studio →</a> · Source: <a href="${REPO_URL}" rel="noreferrer">4A on GitHub →</a></p>
  </div>
</section>`;
}

function landingTemplate(page) {
  return `${commonHead(page)}
<body class="layout-landing">
${siteHeader()}
${landingHero()}
${landingTiles()}
${landingExample()}
${landingPrompts()}
${landingBuilders()}
${siteFooter()}
</body>
</html>
`;
}

function pageTemplate(page, html) {
  return `${commonHead(page)}
<body class="layout-page">
${siteHeader()}
<main class="page-main">
<article class="prose page-prose">
${html}
</article>
</main>
${siteFooter()}
</body>
</html>
`;
}

function docTemplate(page, html) {
  const breadcrumb = `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a><span> / </span><span>${escapeHtml(page.section || "Docs")}</span><span> / </span><span aria-current="page">${escapeHtml(page.title)}</span></nav>`;
  return `${commonHead(page)}
<body class="layout-doc">
${siteHeader()}
<div class="doc-shell">
${navHTML(page.slug)}
<main class="doc-main">
${breadcrumb}
<header class="doc-head">
<h1>${escapeHtml(page.title)}</h1>
<p class="doc-summary">${escapeHtml(page.summary)}</p>
</header>
<article class="prose">
${html}
</article>
</main>
</div>
${siteFooter()}
</body>
</html>
`;
}

// ─── styles, favicon, ai-discovery extras ───────────────────────────────────

const STYLES = `:root {
  --c-bg: #fff;
  --c-bg-muted: #f7f7f8;
  --c-bg-code: #f4f4f5;
  --c-fg: #0e0e10;
  --c-fg-muted: #4a4a52;
  --c-fg-faint: #7a7a82;
  --c-border: #e7e7ea;
  --c-accent: #1d4ed8;
  --c-accent-bg: #eef2ff;
  --c-accent-fg: #1e3a8a;
  --c-rule: #d4d4d8;
  --max-width: 720px;
  --max-doc: 1100px;
  --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --c-bg: #0c0c0e;
    --c-bg-muted: #131316;
    --c-bg-code: #1a1a1d;
    --c-fg: #ececef;
    --c-fg-muted: #a8a8b0;
    --c-fg-faint: #6e6e76;
    --c-border: #28282d;
    --c-accent: #7aa7ff;
    --c-accent-bg: #1a2540;
    --c-accent-fg: #b8d0ff;
    --c-rule: #313137;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--c-bg);
  color: var(--c-fg);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.62;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
a { color: var(--c-accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
.muted { color: var(--c-fg-muted); }

/* ─── header ─── */
.site-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 28px;
  border-bottom: 1px solid var(--c-border);
  position: sticky;
  top: 0;
  background: color-mix(in srgb, var(--c-bg) 90%, transparent);
  backdrop-filter: blur(8px);
  z-index: 50;
}
.brand { display: flex; align-items: center; gap: 12px; color: var(--c-fg); }
.brand:hover { text-decoration: none; }
.brand-mark {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 18px;
  letter-spacing: 0.04em;
  color: var(--c-accent);
}
.brand-tag {
  color: var(--c-fg-muted);
  font-size: 14px;
  letter-spacing: -0.005em;
}
.top-nav { display: flex; gap: 22px; }
.top-nav a {
  color: var(--c-fg);
  font-size: 14.5px;
  letter-spacing: -0.005em;
}
.top-nav a:hover { color: var(--c-accent); text-decoration: none; }

/* ─── hero ─── */
.hero {
  border-bottom: 1px solid var(--c-border);
  background:
    radial-gradient(ellipse 80% 50% at 50% 0%, color-mix(in srgb, var(--c-accent) 8%, transparent), transparent 70%),
    var(--c-bg);
  padding: 96px 28px 80px;
  text-align: center;
}
.hero-inner { max-width: 760px; margin: 0 auto; }
.hero-eyebrow {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--c-accent);
  background: var(--c-accent-bg);
  border: 1px solid color-mix(in srgb, var(--c-accent) 25%, transparent);
  border-radius: 999px;
  padding: 6px 14px;
  margin-bottom: 28px;
}
.hero-title {
  font-size: clamp(80px, 14vw, 180px);
  line-height: 0.92;
  margin: 0 0 16px;
  font-weight: 800;
  letter-spacing: -0.04em;
}
.hero-4 { color: var(--c-accent); }
.hero-a { color: var(--c-fg); }
.hero-fouras {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 14px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--c-fg-muted);
  margin: 0 auto 32px;
}
.hero-fouras span:not(.dot) { color: var(--c-fg); font-weight: 600; }
.hero-fouras .dot { color: var(--c-accent); }
.hero-tag {
  font-size: clamp(20px, 2.4vw, 26px);
  line-height: 1.4;
  font-weight: 500;
  margin: 0 auto 18px;
  max-width: 640px;
  color: var(--c-fg);
}
.hero-sub {
  font-size: 17px;
  line-height: 1.65;
  color: var(--c-fg-muted);
  max-width: 600px;
  margin: 0 auto 36px;
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
  margin-bottom: 32px;
}
.hero-agent-card {
  max-width: 720px;
  margin: 8px auto 24px;
  padding: 28px 32px 24px;
  border: 1px solid var(--c-rule);
  border-radius: 14px;
  background: var(--c-bg-muted);
  text-align: left;
  box-shadow: 0 1px 0 rgba(0,0,0,0.02);
}
.hero-agent-head {
  font-size: 17px;
  font-weight: 600;
  color: var(--c-fg);
  letter-spacing: -0.01em;
  text-align: center;
  margin-bottom: 18px;
}
.hero-agent-emoji { color: var(--c-accent); margin-left: 4px; }
.hero-agent-cmd {
  display: block;
  background: var(--c-bg-code);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 16px 18px;
  margin: 0 0 20px;
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1.6;
  color: var(--c-fg);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.hero-agent-cmd code { background: transparent; padding: 0; font-size: inherit; color: inherit; }
.hero-agent-steps {
  list-style: decimal;
  padding-left: 22px;
  margin: 0 0 18px;
  color: var(--c-fg-muted);
  font-size: 15px;
  line-height: 1.7;
}
.hero-agent-steps li { padding-left: 4px; margin-bottom: 4px; }
.hero-agent-steps code {
  background: var(--c-bg-code);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 13px;
}
.hero-agent-foot {
  margin: 0;
  text-align: right;
  font-size: 14px;
}
.hero-agent-foot a { color: var(--c-accent); font-weight: 500; }
.hero-human {
  font-size: 14px;
  color: var(--c-fg-muted);
  margin: 16px auto 0;
  max-width: 640px;
}
.hero-human a { color: var(--c-accent); }
.btn {
  display: inline-block;
  padding: 11px 20px;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  background: var(--c-bg);
  color: var(--c-fg);
  font-weight: 500;
  font-size: 15px;
  letter-spacing: -0.005em;
  transition: background 0.15s, border-color 0.15s;
}
.btn:hover { text-decoration: none; background: var(--c-bg-muted); border-color: var(--c-rule); }
.btn-primary {
  background: var(--c-accent);
  color: #fff;
  border-color: var(--c-accent);
}
.btn-primary:hover { background: color-mix(in srgb, var(--c-accent) 88%, black); border-color: color-mix(in srgb, var(--c-accent) 88%, black); }
.btn-ghost { border-color: transparent; color: var(--c-accent); }
.btn-ghost:hover { background: var(--c-accent-bg); border-color: transparent; }
.hero-curl {
  display: inline-block;
  background: var(--c-bg-code);
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 10px 16px;
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--c-fg-muted);
  margin: 0 auto;
}
.hero-curl code { background: none; padding: 0; }

/* ─── prose / markdown ─── */
.prose {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 56px 28px 80px;
  font-size: 16.5px;
}
.container { max-width: var(--max-width); }
.prose h1, .prose h2, .prose h3, .prose h4 {
  letter-spacing: -0.018em;
  line-height: 1.25;
  margin-top: 2.4em;
  margin-bottom: 0.6em;
  font-weight: 700;
}
.prose h1 { font-size: 2em; margin-top: 0; }
.prose h2 { font-size: 1.45em; padding-top: 0.4em; border-top: 1px solid var(--c-border); margin-top: 2.6em; padding-top: 1.6em; }
.prose h3 { font-size: 1.18em; }
.prose h4 { font-size: 1em; color: var(--c-fg-muted); }
.prose p { margin: 1em 0; }
.prose ul, .prose ol { padding-left: 1.4em; margin: 1em 0; }
.prose li { margin: 0.4em 0; }
.prose blockquote {
  border-left: 3px solid var(--c-accent);
  background: var(--c-accent-bg);
  padding: 12px 18px;
  margin: 1.4em 0;
  border-radius: 0 6px 6px 0;
  color: var(--c-accent-fg);
}
.prose blockquote p:first-child { margin-top: 0; }
.prose blockquote p:last-child { margin-bottom: 0; }
.prose code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--c-bg-code);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--c-border);
}
.prose pre {
  background: var(--c-bg-code);
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 16px 18px;
  overflow-x: auto;
  margin: 1.4em 0;
  font-size: 14px;
  line-height: 1.55;
}
.prose pre code { background: none; border: none; padding: 0; font-size: 1em; }
.prose hr { border: none; border-top: 1px solid var(--c-border); margin: 2.4em 0; }
.prose table {
  width: 100%;
  border-collapse: collapse;
  margin: 1.4em 0;
  font-size: 0.95em;
}
.prose th, .prose td {
  text-align: left;
  padding: 10px 14px;
  border-bottom: 1px solid var(--c-border);
}
.prose th {
  background: var(--c-bg-muted);
  font-weight: 600;
  border-bottom: 2px solid var(--c-rule);
}
.prose tr:hover td { background: color-mix(in srgb, var(--c-bg-muted) 70%, transparent); }
.prose img { max-width: 100%; }
.prose del { color: var(--c-fg-faint); }

/* ─── doc layout ─── */
.layout-doc .doc-shell {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 44px;
  max-width: var(--max-doc);
  margin: 0 auto;
  padding: 36px 28px 60px;
}
.sidebar {
  position: sticky;
  top: 88px;
  align-self: start;
  font-size: 14.5px;
  max-height: calc(100vh - 100px);
  overflow-y: auto;
}
.nav-home { margin-bottom: 24px; }
.nav-home-link {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--c-fg-muted);
}
.nav-home-link:hover { color: var(--c-accent); text-decoration: none; }
.nav-section { margin-bottom: 22px; }
.nav-section h4 {
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--c-fg-faint);
  font-weight: 600;
  margin: 0 0 10px;
}
.nav-section ul { list-style: none; padding: 0; margin: 0; }
.nav-section li { margin: 4px 0; }
.nav-section a {
  display: block;
  padding: 4px 10px;
  border-radius: 5px;
  color: var(--c-fg);
  border-left: 2px solid transparent;
}
.nav-section a:hover { background: var(--c-bg-muted); text-decoration: none; }
.nav-section li[aria-current="page"] a {
  color: var(--c-accent);
  border-left-color: var(--c-accent);
  background: var(--c-accent-bg);
  font-weight: 500;
}
.doc-main { min-width: 0; }
.breadcrumb {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--c-fg-muted);
  margin-bottom: 24px;
}
.breadcrumb a { color: var(--c-fg-muted); }
.breadcrumb a:hover { color: var(--c-accent); }
.breadcrumb [aria-current="page"] { color: var(--c-fg); }
.doc-head { margin-bottom: 28px; padding-bottom: 24px; border-bottom: 1px solid var(--c-border); }
.doc-head h1 { font-size: 2em; margin: 0 0 10px; letter-spacing: -0.02em; line-height: 1.18; }
.doc-summary { color: var(--c-fg-muted); font-size: 17px; margin: 0; }
.doc-main .prose { max-width: none; padding: 0; }

/* ─── footer ─── */
.site-footer {
  border-top: 1px solid var(--c-border);
  margin-top: 80px;
  padding: 48px 28px 32px;
  background: var(--c-bg-muted);
}
.footer-row {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: 40px;
  max-width: var(--max-doc);
  margin: 0 auto;
}
.footer-col h5 {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--c-fg-faint);
  font-weight: 600;
  margin: 0 0 12px;
}
.footer-col ul { list-style: none; padding: 0; margin: 0; }
.footer-col li { margin: 6px 0; font-size: 14.5px; }
.footer-col a { color: var(--c-fg); }
.footer-col a:hover { color: var(--c-accent); }
.footer-baseline {
  max-width: var(--max-doc);
  margin: 32px auto 0;
  padding-top: 24px;
  border-top: 1px solid var(--c-border);
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--c-fg-muted);
}

/* ─── top-nav CTA ─── */
.top-nav-cta {
  background: var(--c-accent);
  color: #fff !important;
  padding: 6px 14px;
  border-radius: 6px;
  font-weight: 600;
}
.top-nav-cta:hover { background: color-mix(in srgb, var(--c-accent) 88%, black); text-decoration: none; }

/* ─── page layout (marketing) ─── */
.layout-page .page-main {
  max-width: 820px;
  margin: 0 auto;
  padding: 60px 28px 40px;
}
.layout-page .page-prose { max-width: none; padding: 0; }
.install-intro h1 {
  font-size: clamp(34px, 5vw, 52px);
  letter-spacing: -0.025em;
  line-height: 1.1;
  margin: 0 0 16px;
}
.install-intro p {
  font-size: 19px;
  color: var(--c-fg-muted);
  max-width: 620px;
  margin: 0 0 12px;
}

/* ─── install cards ─── */
.install-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  margin: 40px 0 16px;
}
.install-card {
  border: 1px solid var(--c-border);
  border-radius: 14px;
  padding: 28px 28px 24px;
  background: var(--c-bg-muted);
  display: flex;
  flex-direction: column;
}
.install-card:hover {
  border-color: color-mix(in srgb, var(--c-accent) 35%, var(--c-border));
}
.install-card h3 {
  font-size: 22px;
  margin: 0 0 10px;
  letter-spacing: -0.01em;
}
.install-card > p:first-of-type {
  color: var(--c-fg-muted);
  margin: 0 0 18px;
  font-size: 15.5px;
}
.install-card a:not(.install-note) {
  font-weight: 500;
}
.install-card a strong, .install-card p > strong > a, .install-card p > a > strong {
  display: inline-block;
}
.install-card > p > a > strong {
  display: inline-block;
  background: var(--c-accent);
  color: #fff;
  padding: 10px 18px;
  border-radius: 8px;
  font-weight: 600;
  margin: 4px 0 12px;
}
.install-card > p > a:hover > strong {
  background: color-mix(in srgb, var(--c-accent) 88%, black);
}
.install-card > p > a:hover { text-decoration: none; }
.install-note {
  display: block;
  color: var(--c-fg-faint);
  font-size: 13.5px;
  margin-top: -4px;
  margin-bottom: 14px;
  font-style: italic;
}
.install-card pre {
  background: var(--c-bg);
  font-size: 13.5px;
  margin: 4px 0 18px;
}
.install-card ol {
  font-size: 15px;
  padding-left: 1.2em;
  margin: 0 0 16px;
}
.install-card ol li { margin: 6px 0; }
.install-card > p:last-of-type {
  font-size: 14.5px;
  color: var(--c-fg-muted);
  margin: auto 0 0;
  padding-top: 12px;
  border-top: 1px dashed var(--c-border);
}

/* ─── install footer ─── */
.install-footer {
  margin-top: 40px;
  padding-top: 24px;
  border-top: 1px solid var(--c-border);
  font-size: 14.5px;
  color: var(--c-fg-muted);
}
.install-footer p { margin: 6px 0; }

/* ─── landing — marketing-forward sections ─── */
.layout-landing .hero { padding: 80px 28px 64px; }
.layout-landing .hero-title { font-size: clamp(72px, 12vw, 160px); margin: 0 0 24px; }
.layout-landing .hero-tag {
  font-size: clamp(24px, 3vw, 34px);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--c-fg);
  margin: 0 auto 18px;
  max-width: 720px;
}
.layout-landing .hero-sub { max-width: 640px; font-size: 17.5px; }
.btn-lg {
  font-size: 16.5px;
  padding: 13px 24px;
  font-weight: 600;
  letter-spacing: -0.005em;
}
.hero-fineprint {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--c-fg-faint);
  margin: 18px 0 0;
}
.hero-fineprint a { color: var(--c-fg-muted); }
.hero-fineprint a:hover { color: var(--c-accent); }
.hero-explore {
  margin: 4px 0 0;
  font-size: 15px;
}
.hero-explore a {
  color: var(--c-accent);
  font-weight: 500;
}

.section { border-top: 1px solid var(--c-border); padding: 72px 28px; }
.section-inner { max-width: var(--max-doc); margin: 0 auto; }
.section-h {
  font-size: clamp(28px, 3.6vw, 40px);
  font-weight: 700;
  letter-spacing: -0.025em;
  margin: 0 0 14px;
  line-height: 1.15;
}
.section-lede {
  font-size: 17.5px;
  color: var(--c-fg-muted);
  max-width: 680px;
  margin: 0 0 32px;
  line-height: 1.55;
}
.section-lede code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--c-bg-code);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--c-border);
}

/* tiles */
.section-tiles { background: var(--c-bg); }
.tiles-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
  margin-top: 40px;
}
.tile {
  border: 1px solid var(--c-border);
  border-radius: 12px;
  padding: 26px 26px 24px;
  background: var(--c-bg-muted);
}
.tile h3 {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.012em;
  margin: 0 0 10px;
  color: var(--c-fg);
}
.tile p {
  margin: 0;
  color: var(--c-fg-muted);
  line-height: 1.55;
  font-size: 15.5px;
}
.tile-link {
  display: block;
  color: inherit;
  transition: border-color 0.15s, background 0.15s, transform 0.15s;
}
.tile-link:hover {
  text-decoration: none;
  border-color: color-mix(in srgb, var(--c-accent) 50%, var(--c-border));
  background: color-mix(in srgb, var(--c-accent-bg) 30%, var(--c-bg-muted));
}
.tile-link h3 { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.tile-arrow {
  color: var(--c-accent);
  font-weight: 500;
  font-size: 16px;
  flex-shrink: 0;
  transition: transform 0.15s;
}
.tile-link:hover .tile-arrow { transform: translateX(2px); }
.tiles-foot {
  margin: 24px 0 0;
  font-size: 15px;
}
.tiles-foot a { color: var(--c-accent); font-weight: 500; }

/* worked example */
.section-example { background: var(--c-bg-muted); }
.example-twopane {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 28px;
  margin-top: 32px;
}
.example-column { min-width: 0; }
.example-column-head { margin-bottom: 14px; }
.example-column-head h3 {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 4px;
  color: var(--c-fg);
}
.example-column-head p {
  margin: 0;
  font-size: 14px;
}
.example-stack {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}
.example-card {
  border: 1px solid var(--c-border);
  border-radius: 10px;
  background: var(--c-bg);
  overflow: hidden;
}
.example-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-bg-muted);
  font-size: 13px;
  flex-wrap: wrap;
  gap: 8px;
}
.kind-badge {
  font-family: var(--font-mono);
  font-size: 12.5px;
  letter-spacing: 0.02em;
  color: var(--c-accent);
  font-weight: 600;
}
.example-link {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--c-fg-muted);
}
.example-link:hover { color: var(--c-accent); }
.json-card {
  margin: 0;
  padding: 18px 20px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--c-fg);
  overflow-x: auto;
  white-space: pre;
  background: var(--c-bg);
}
.json-card code { background: none; border: none; padding: 0; font-family: inherit; font-size: 1em; }
.j-key { color: #0f766e; }
.j-str { color: #1d4ed8; }
.j-num { color: #b45309; }
.j-bool { color: #be185d; }
.j-null { color: #7a7a82; }
@media (prefers-color-scheme: dark) {
  .j-key { color: #5eead4; }
  .j-str { color: #a5b4fc; }
  .j-num { color: #fbbf24; }
  .j-bool { color: #f9a8d4; }
  .j-null { color: #71717a; }
}
.example-foot {
  margin: 24px 0 0;
  font-size: 14.5px;
  color: var(--c-fg-muted);
  max-width: 720px;
}

/* prompts */
.section-prompts { background: var(--c-bg); }
.prompt-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
  max-width: 880px;
}
.prompt-list li {
  border: 1px solid var(--c-border);
  border-left: 3px solid var(--c-accent);
  border-radius: 6px;
  padding: 12px 16px;
  background: var(--c-bg-muted);
}
.prompt-list code {
  font-family: var(--font-mono);
  font-size: 14px;
  background: none;
  border: none;
  padding: 0;
  color: var(--c-fg);
  white-space: pre-wrap;
  word-break: break-word;
}

/* builders */
.section-builders { background: var(--c-bg-muted); }
.section-builders p {
  font-size: 16.5px;
  color: var(--c-fg-muted);
  max-width: 720px;
  line-height: 1.6;
  margin: 0 0 28px;
}
.builders-links {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
  max-width: 880px;
}
.builders-links li {
  padding: 10px 0;
  border-top: 1px solid var(--c-border);
  font-size: 16px;
}
.builders-links li:last-child { border-bottom: 1px solid var(--c-border); }
.builders-links a { font-weight: 600; }
.builders-links .muted { font-size: 14.5px; margin-left: 12px; }
.builders-foot {
  margin: 28px 0 0;
  font-size: 15.5px;
  color: var(--c-fg-muted);
}
.builders-foot a { color: var(--c-accent); font-weight: 600; }

/* ─── responsive ─── */
/* 3-col tile grid gets cramped below ~1080px; step down to 2-col before hitting
 * mobile. Keeps the "all six visible above the fold" story on desktop. */
@media (max-width: 1080px) {
  .tiles-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 880px) {
  .layout-doc .doc-shell { grid-template-columns: 1fr; gap: 24px; }
  .sidebar { position: static; max-height: none; border-bottom: 1px solid var(--c-border); padding-bottom: 24px; }
  .footer-row { grid-template-columns: 1fr; gap: 28px; }
  .install-cards { grid-template-columns: 1fr; }
  .tiles-grid { grid-template-columns: 1fr; }
  .example-twopane { grid-template-columns: 1fr; gap: 36px; }
  .section { padding: 56px 22px; }
}
@media (max-width: 540px) {
  .site-header { padding: 14px 18px; }
  .brand-tag { display: none; }
  .top-nav { gap: 14px; }
  .hero { padding: 56px 18px 48px; }
  .layout-landing .hero { padding: 56px 18px 48px; }
  .prose { padding: 36px 18px 60px; }
  .hero-actions { flex-direction: column; align-items: stretch; }
  .hero-actions .btn { text-align: center; }
  .hero-agent-card { padding: 20px 18px 18px; border-radius: 12px; }
  .hero-agent-head { font-size: 15px; }
  .hero-agent-cmd { font-size: 12.5px; padding: 12px 14px; }
  .hero-agent-steps { font-size: 14px; padding-left: 18px; }
  .builders-links .muted { display: block; margin: 4px 0 0 0; }
}
`;

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#1d4ed8"/>
  <text x="50%" y="56%" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="34" font-weight="800" fill="#fff" text-anchor="middle" dominant-baseline="middle" letter-spacing="-1">4A</text>
</svg>
`;

function buildLlmsTxt(pages) {
  const lines = [];
  lines.push("# 4A");
  lines.push("");
  lines.push("> Agent-Agnostic Accessible Archive. A convention on Nostr for AI-mediated public knowledge exchange. Not a new protocol — a thin set of naming rules, event shapes, and a JSON-LD context document that turns the existing Nostr network into a knowledge substrate any AI agent can read and write.");
  lines.push("");
  lines.push("4A's primitives borrow from existing systems: Nostr for wire format and identity, Schema.org and PROV-O for vocabulary, MCP for agent consumption, AT Protocol for the aggregator-relay pattern. The repository contains the full specification, reference architecture, and design research.");
  lines.push("");
  lines.push("## Use cases");
  lines.push("");
  for (const p of pages) {
    if (p.section === "Use cases") {
      lines.push(`- [${p.title}](${SITE_URL}/${p.slug}/): ${p.summary}`);
    }
  }
  lines.push("");
  lines.push("## Specification");
  lines.push("");
  for (const p of pages) {
    if (p.section === "Specification" || p.layout === "landing") {
      const url = p.slug === "" ? SITE_URL + "/" : `${SITE_URL}/${p.slug}/`;
      lines.push(`- [${p.title}](${url}): ${p.summary}`);
    }
  }
  lines.push("");
  lines.push("## Credibility model");
  lines.push("");
  for (const p of pages) {
    if (p.section === "Credibility") {
      lines.push(`- [${p.title}](${SITE_URL}/${p.slug}/): ${p.summary}`);
    }
  }
  lines.push("");
  lines.push("## Surfaces and runbooks");
  lines.push("");
  for (const p of pages) {
    if (p.section === "Surfaces") {
      lines.push(`- [${p.title}](${SITE_URL}/${p.slug}/): ${p.summary}`);
    }
  }
  lines.push("");
  lines.push("## Reference and operations");
  lines.push("");
  for (const p of pages) {
    if (p.section === "Reference" || p.section === "Operations") {
      lines.push(`- [${p.title}](${SITE_URL}/${p.slug}/): ${p.summary}`);
    }
  }
  lines.push("");
  lines.push("## Background");
  lines.push("");
  for (const p of pages) {
    if (p.section === "Background") {
      lines.push(`- [${p.title}](${SITE_URL}/${p.slug}/): ${p.summary}`);
    }
  }
  lines.push("");
  lines.push("## Optional");
  lines.push("");
  lines.push(`- [JSON-LD context](${SITE_URL}/ns/v0): the immutable v0 context document referenced by every 4A Nostr event.`);
  lines.push(`- [Source repository](${REPO_URL}): full source, license (Apache 2.0), and issue tracker.`);
  lines.push("");
  return lines.join("\n");
}

function buildSitemap(pages) {
  const urls = pages.map((p) => {
    const loc = p.slug === "" ? SITE_URL + "/" : `${SITE_URL}/${p.slug}/`;
    const priority = p.layout === "landing" ? "1.0" : p.section === "Specification" ? "0.9" : "0.7";
    return `  <url><loc>${loc}</loc><lastmod>${NOW.slice(0, 10)}</lastmod><changefreq>weekly</changefreq><priority>${priority}</priority></url>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

function buildRobotsTxt() {
  return `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
}

function buildAgentCard() {
  return {
    name: "4A — Agent-Agnostic Accessible Archive",
    description: "A convention on Nostr for AI-mediated public knowledge exchange. Read structured knowledge objects (observations, claims, entities, relations) about any topic from the public Nostr network.",
    url: SITE_URL,
    documentationUrl: SITE_URL + "/spec",
    provider: { organization: "4A", url: SITE_URL },
    version: "0.0.1-draft",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "query_4a",
        name: "Query 4A knowledge objects",
        description: "Query the 4A network for observations, claims, entities, or relations about a given subject.",
        tags: ["read", "knowledge", "nostr"],
        examples: [
          "Get observations about github.com/vercel/next.js",
          "Find claims citing this entity",
          "List the recognized commons for a project",
        ],
      },
    ],
  };
}

// ─── main ───────────────────────────────────────────────────────────────────

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}
function writeFile(rel, contents) {
  const out = join(SITE_DIR, rel);
  ensureDir(dirname(out));
  writeFileSync(out, contents, "utf8");
}

function build() {
  if (existsSync(SITE_DIR)) rmSync(SITE_DIR, { recursive: true, force: true });
  ensureDir(SITE_DIR);

  for (const page of PAGES) {
    let rendered;
    if (page.layout === "landing") {
      // landing builds its body inline (cards, JSON, prompts) — no markdown
      rendered = landingTemplate(page);
    } else {
      const md = readFileSync(join(REPO_ROOT, page.src), "utf8");
      const html = renderMarkdownToHtml(md);
      rendered = page.layout === "page" ? pageTemplate(page, html) : docTemplate(page, html);
    }
    const outPath = page.slug === "" ? "index.html" : join(page.slug, "index.html");
    writeFile(outPath, rendered);
  }

  writeFile("styles.css", STYLES);
  writeFile("favicon.svg", FAVICON_SVG);
  writeFile("llms.txt", buildLlmsTxt(PAGES));
  writeFile("sitemap.xml", buildSitemap(PAGES));
  writeFile("robots.txt", buildRobotsTxt());
  writeFile(".well-known/agent.json", JSON.stringify(buildAgentCard(), null, 2));

  const surfacesSrc = join(REPO_ROOT, "surfaces");
  const surfacesOut = join(SITE_DIR, "surfaces");
  let surfacesCopied = 0;
  if (existsSync(surfacesSrc)) {
    ensureDir(surfacesOut);
    for (const name of readdirSync(surfacesSrc)) {
      if (!/\.(json|md)$/.test(name)) continue;
      copyFileSync(join(surfacesSrc, name), join(surfacesOut, name));
      surfacesCopied++;
    }
  }

  // Publish the installable /4a skill as a static download at /skill/SKILL.md.
  // The agent-facing onboarding page (/get-started/agents/) links here.
  const skillSrc = join(REPO_ROOT, "distribution", "skill", "SKILL.md");
  const skillOut = join(SITE_DIR, "skill", "SKILL.md");
  if (existsSync(skillSrc)) {
    ensureDir(dirname(skillOut));
    copyFileSync(skillSrc, skillOut);
  }

  console.log(`built ${PAGES.length} pages + ${surfacesCopied} surfaces → ${SITE_DIR}`);
}

build();
