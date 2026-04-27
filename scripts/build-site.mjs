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

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

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

// ─── markdown → HTML ────────────────────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: false });

function rewriteRelativeLinks(md) {
  return md.replace(/\]\((\.\/[^)]+)\)/g, (full, link) => {
    if (LINK_REWRITES[link]) return `](${LINK_REWRITES[link]})`;
    // strip .md from any unmapped relative link
    if (link.endsWith(".md")) {
      const stripped = link.replace(/^\.\//, "/").replace(/\.md$/, "");
      return `](${stripped})`;
    }
    return full;
  });
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
  const order = ["Specification", "Credibility", "Operations", "Reference", "Background", "Other"];
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

function landingHero() {
  return `<section class="hero">
  <div class="hero-inner">
    <div class="hero-eyebrow">Convention. Not protocol.</div>
    <h1 class="hero-title"><span class="hero-4">4</span><span class="hero-a">A</span></h1>
    <p class="hero-tag">Agent-Agnostic Accessible Archive — a convention on Nostr for AI-mediated public knowledge exchange.</p>
    <p class="hero-sub">Every agent — local or cloud-hosted — publishes and consumes structured knowledge with provenance, vendor-neutral and signature-verified, on infrastructure that already exists.</p>
    <div class="hero-actions">
      <a class="btn btn-primary" href="/spec">Read the spec</a>
      <a class="btn" href="${REPO_URL}" rel="noreferrer">View on GitHub</a>
      <a class="btn btn-ghost" href="${SITE_URL}/ns/v0">JSON-LD context →</a>
    </div>
    <pre class="hero-curl"><code>curl -i ${SITE_URL}/ns/v0</code></pre>
  </div>
</section>`;
}

function landingTemplate(page, html) {
  return `${commonHead(page)}
<body class="layout-landing">
${siteHeader()}
${landingHero()}
<main class="prose container">
${html}
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
  margin: 0 0 28px;
  font-weight: 800;
  letter-spacing: -0.04em;
}
.hero-4 { color: var(--c-accent); }
.hero-a { color: var(--c-fg); }
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

/* ─── responsive ─── */
@media (max-width: 880px) {
  .layout-doc .doc-shell { grid-template-columns: 1fr; gap: 24px; }
  .sidebar { position: static; max-height: none; border-bottom: 1px solid var(--c-border); padding-bottom: 24px; }
  .footer-row { grid-template-columns: 1fr; gap: 28px; }
}
@media (max-width: 540px) {
  .site-header { padding: 14px 18px; }
  .brand-tag { display: none; }
  .top-nav { gap: 14px; }
  .hero { padding: 56px 18px 48px; }
  .prose { padding: 36px 18px 60px; }
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
    const md = readFileSync(join(REPO_ROOT, page.src), "utf8");
    const html = renderMarkdownToHtml(md);
    const rendered = page.layout === "landing" ? landingTemplate(page, html) : docTemplate(page, html);
    const outPath = page.slug === "" ? "index.html" : join(page.slug, "index.html");
    writeFile(outPath, rendered);
  }

  writeFile("styles.css", STYLES);
  writeFile("favicon.svg", FAVICON_SVG);
  writeFile("llms.txt", buildLlmsTxt(PAGES));
  writeFile("sitemap.xml", buildSitemap(PAGES));
  writeFile("robots.txt", buildRobotsTxt());
  writeFile(".well-known/agent.json", JSON.stringify(buildAgentCard(), null, 2));

  console.log(`built ${PAGES.length} pages → ${SITE_DIR}`);
}

build();
