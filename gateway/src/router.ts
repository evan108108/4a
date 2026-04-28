// 4A gateway — single Worker handling all routes on 4a4.ai and its subdomains.
//
// v0 scope:
//   - GET /ns/v0           → JSON-LD context document (immutable, custom headers)
//   - HEAD /ns/v0          → headers-only variant
//   - OPTIONS /ns/v0       → CORS preflight
//   - api.4a4.ai/v0/*      → public read API (Day 3 / Task 2)
//   - mcp.4a4.ai/*         → MCP/SSE adapter (Day 3 / Task 4)
//   - everything else on   → static site served from env.ASSETS
//     the apex
//
// The static site is built from the repo's markdown by scripts/build-site.mjs
// and lives in gateway/dist/site/. The build runs before every deploy.

import contextV0 from "../../context-v0.json";
import { handleApiRequest } from "./api";
import { handleAuthRequest } from "./auth";
import { handleMcpRequest } from "./mcp";
import type { McpHub } from "./mcp";
import { handlePublishRequest } from "./publish";
import type { RelayPool } from "./relay-pool";
import { handleScoreRequest } from "./score";

export { RelayPool } from "./relay-pool";
export { McpHub } from "./mcp";

interface Env {
  ASSETS: Fetcher;
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
  MCP_HUB: DurableObjectNamespace<McpHub>;
  JWT_SIGNING_KEY?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  KMS_DERIVATION_KEY_ID: string;
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
      if (url.pathname.startsWith("/auth/")) {
        return handleAuthRequest(request, env);
      }
      if (url.pathname.startsWith("/v0/publish/") || url.pathname === "/v0/attest") {
        return handlePublishRequest(request, env);
      }
      if (url.pathname === "/v0/score") {
        return handleScoreRequest(request, env);
      }
      return handleApiRequest(request, env);
    }

    if (host === "mcp.4a4.ai") {
      return handleMcpRequest(request, env);
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

  // Cron-triggered backstop for relay ingestion. Fires every 5 minutes per
  // wrangler.toml [triggers].crons. Calls RelayPool.sweepFromRelays() which
  // (1) reopens any dropped subscriptions and (2) replays the last 15 minutes
  // of events from each relay so anything missed by a silently-dead live WS
  // gets recovered.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.RELAY_POOL.idFromName("main");
    const stub = env.RELAY_POOL.get(id);
    ctx.waitUntil(stub.sweepFromRelays().then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
