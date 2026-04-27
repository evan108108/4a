// 4A gateway — single Worker handling all routes on 4a4.ai and its subdomains.
//
// v0 scope (Day 2):
//   - GET  /ns/v0           → JSON-LD context document (immutable)
//   - HEAD /ns/v0           → headers-only variant
//   - OPTIONS /ns/v0        → CORS preflight
//   - GET  /                → minimal landing page
//   - everything else       → 404 (Day 3+ fills in /api, /mcp)
//
// Subdomains (api., mcp.) currently 404 with a "coming soon" body.

import contextV0 from "../../context-v0.json";

const CONTEXT_HEADERS: HeadersInit = {
  "Content-Type": "application/ld+json; charset=utf-8",
  // The JSON-LD context for /ns/v0 is immutable. Cache aggressively.
  "Cache-Control": "public, max-age=86400, immutable",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Accept",
  "X-4A-Spec-Version": "v0",
};

const CONTEXT_BODY = JSON.stringify(contextV0, null, 2);

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>4A — Agent-Agnostic Accessible Archive</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 42em; margin: 4em auto; padding: 0 1em; color: #111; line-height: 1.5; }
    h1 { font-size: 2.2em; margin-bottom: 0.2em; }
    .tag { color: #666; margin-top: 0; }
    code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.95em; }
    a { color: #0a58ca; }
  </style>
</head>
<body>
  <h1>4A</h1>
  <p class="tag">Agent-Agnostic Accessible Archive — a convention on Nostr for AI-mediated public knowledge exchange.</p>
  <p>This domain currently serves the JSON-LD context document for 4A v0:</p>
  <ul>
    <li><a href="/ns/v0"><code>https://4a4.ai/ns/v0</code></a> — the v0 context (immutable)</li>
  </ul>
  <p>Specification, source, and reference implementation: <a href="https://github.com/evan108108/4a">github.com/evan108108/4a</a></p>
</body>
</html>`;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // CORS preflight for the context endpoint.
    if (method === "OPTIONS" && url.pathname === "/ns/v0") {
      return new Response(null, { status: 204, headers: CONTEXT_HEADERS });
    }

    // JSON-LD context document.
    if (url.pathname === "/ns/v0") {
      if (method === "GET") {
        return new Response(CONTEXT_BODY, { status: 200, headers: CONTEXT_HEADERS });
      }
      if (method === "HEAD") {
        return new Response(null, { status: 200, headers: CONTEXT_HEADERS });
      }
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD, OPTIONS" },
      });
    }

    // Apex landing page.
    if (url.hostname === "4a4.ai" && url.pathname === "/") {
      return new Response(LANDING_HTML, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // api. and mcp. subdomains — placeholder until Day 3+.
    if (url.hostname === "api.4a4.ai" || url.hostname === "mcp.4a4.ai") {
      return new Response(
        JSON.stringify({
          error: "not_yet_implemented",
          message: `${url.hostname} is reserved for the 4A gateway and is not live yet.`,
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Default 404.
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
