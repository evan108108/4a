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
import {
  authorizationServerMetadata,
  handleAuthRequest,
  protectedResourceMetadata,
} from "./auth";
import { handleAudienceRequest } from "./audience";
import { handleAudienceByInvitePubRequest } from "./audience-by-invite-pub";
import { handleAudienceRawRequest } from "./audience-raw";
import { handleKanbanTideRequest, KANBAN_TIDE_PATH } from "./kanban-tide-route";
import {
  handleKanbanPlaintextRequest,
  KANBAN_PLAINTEXT_PATH,
} from "./kanban-plaintext-route";
import { handleAudienceStreamRequest } from "./audience-stream";
import { handleBlossomRequest } from "./blossom";
import { handleArtifactsRequest } from "./artifacts";
import { handleHookRequest } from "./webhook-receiver";
import { handleInboxStream } from "./inbox-stream";
import { handleCommentRequest } from "./comment";
import { handleMcpRequest } from "./mcp";
import type { McpHub } from "./mcp";
import { handleBlobRequest } from "./blob";
import { handleProfileApiRequest } from "./profile";
import { handlePublishRequest } from "./publish";
import type { RelayPool } from "./relay-pool";
import { handleScoreRequest } from "./score";
import { handleWellKnownNostrJson } from "./well-known";

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
  NOSTR_DIRECTORY_JSON?: string;
  STORAGE: R2Bucket;
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
      if (url.pathname === "/.well-known/oauth-authorization-server" && method === "GET") {
        return authorizationServerMetadata();
      }
      if (url.pathname.startsWith("/auth/")) {
        return handleAuthRequest(request, env);
      }
      if (url.pathname === "/v0/profile" || url.pathname === "/v0/whoami") {
        return handleProfileApiRequest(request, env);
      }
      // MUST match BEFORE the generic `/v0/publish/` startsWith below —
      // otherwise `/v0/publish/kanban_tide` gets swallowed by the JWT-KMS
      // handler in publish.ts, which returns 404 "unknown publish path".
      // Kanban tide is NIP-98-authed and caller-signed, not JWT + KMS.
      if (url.pathname === KANBAN_TIDE_PATH) {
        return handleKanbanTideRequest(request, env);
      }
      // Same trap as the line above, and the reason kanban plaintext is ONE
      // dispatcher route instead of five: this MUST stay above the generic
      // `/v0/publish/` startsWith or publish.ts swallows it and answers 404
      // "unknown publish path". Caller-signed + NIP-98, not JWT + KMS.
      if (url.pathname === KANBAN_PLAINTEXT_PATH) {
        return handleKanbanPlaintextRequest(request, env);
      }
      if (url.pathname.startsWith("/v0/publish/") || url.pathname === "/v0/attest") {
        return handlePublishRequest(request, env);
      }
      if (url.pathname === "/v0/score") {
        return handleScoreRequest(request, env);
      }
      if (url.pathname === "/v0/comment") {
        return handleCommentRequest(request, env);
      }
      if (url.pathname === "/v0/blob") {
        return handleBlobRequest(request, env);
      }
      if (url.pathname.startsWith("/blossom/")) {
        return handleBlossomRequest(request, env);
      }
      if (url.pathname.startsWith("/v0/audience/raw/")) {
        return handleAudienceRawRequest(request, env);
      }
      // Webhook-relay ingress: POST /v0/hook/:pubkey/:slug — public,
      // unauthenticated by design (third parties can't sign NIP-98);
      // rate-limited + size-capped in the handler.
      const hookMatch = url.pathname.match(
        /^\/v0\/hook\/([0-9a-f]{64})\/([A-Za-z0-9_-]+)$/,
      );
      if (hookMatch) {
        return handleHookRequest(request, hookMatch[1]!, hookMatch[2]!, env);
      }
      // Webhook-relay inbox: GET /v0/inbox/:pubkey/stream — NIP-98-gated
      // pubkey-scoped SSE tail of hook wraps.
      const inboxStreamMatch = url.pathname.match(
        /^\/v0\/inbox\/([0-9a-f]{64})\/stream$/,
      );
      if (inboxStreamMatch) {
        return handleInboxStream(request, inboxStreamMatch[1]!, env);
      }
      // Public read keyed by invite_pub. Must match before the generic
      // /v0/audience/ dispatcher so the slug-shaped path doesn't claim it.
      const byInvitePubMatch = url.pathname.match(
        /^\/v0\/audience\/by-invite-pub\/([0-9a-fA-F]+)$/,
      );
      if (byInvitePubMatch) {
        return handleAudienceByInvitePubRequest(request, byInvitePubMatch[1]!, env);
      }
      // SSE stream: GET /v0/audience/:slug/stream — must match before the
      // generic /v0/audience/ dispatcher so the inbox/JWT path doesn't claim it.
      const streamMatch = url.pathname.match(
        /^\/v0\/audience\/([A-Za-z0-9-]+)\/stream$/,
      );
      if (streamMatch) {
        return handleAudienceStreamRequest(request, streamMatch[1]!, env);
      }
      if (url.pathname.startsWith("/v0/audience/")) {
        return handleAudienceRequest(request, env);
      }
      // Public artifacts: manifest publish / kind:5 revoke / viewer renders.
      if (url.pathname.startsWith("/v0/artifacts/")) {
        return handleArtifactsRequest(request, env);
      }
      return handleApiRequest(request, env);
    }

    if (host === "mcp.4a4.ai") {
      if (url.pathname === "/.well-known/oauth-protected-resource" && method === "GET") {
        return protectedResourceMetadata();
      }
      return handleMcpRequest(request, env);
    }

    // NIP-05 directory + v0.5 fa extension — served from the apex (4a4.ai/.well-known/nostr.json).
    if (url.pathname === "/.well-known/nostr.json") {
      return handleWellKnownNostrJson(request, env);
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
