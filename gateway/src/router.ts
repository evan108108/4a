// 4A gateway — single Worker handling all routes on 4a4.ai and its subdomains.
//
// v0 scope:
//   - GET /ns/v0           → JSON-LD context document (immutable, custom headers)
//   - HEAD /ns/v0          → headers-only variant
//   - OPTIONS /ns/v0       → CORS preflight
//   - api.4a4.ai/v0/*      → public read API (Day 3 / Task 2)
//   - mcp.4a4.ai/*         → 503 placeholder (Day 3 / Task 4)
//   - everything else on   → static site served from env.ASSETS
//     the apex
//
// The static site is built from the repo's markdown by scripts/build-site.mjs
// and lives in gateway/dist/site/. The build runs before every deploy.

import contextV0 from "../../context-v0.json";
import { handleApiRequest } from "./api";
import type { RelayPool } from "./relay-pool";

export { RelayPool } from "./relay-pool";

interface Env {
  ASSETS: Fetcher;
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
}

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const host = url.hostname;

    if (host === "api.4a4.ai") {
      return handleApiRequest(request, env);
    }

    if (host === "mcp.4a4.ai") {
      return new Response(
        JSON.stringify({
          error: "not_yet_implemented",
          message: `${host} is reserved for the 4A MCP/SSE adapter and is not live yet.`,
          docs: "https://4a4.ai/architecture",
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=60",
          },
        },
      );
    }

    // JSON-LD context document — custom headers, served from worker code.
    if (url.pathname === "/ns/v0") {
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CONTEXT_HEADERS });
      }
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

    // Everything else on the apex — serve from the static site.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
