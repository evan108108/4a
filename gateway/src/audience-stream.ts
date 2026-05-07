// 4A v0.5 / Studio v0 SSE stream endpoint — `GET /v0/audience/:slug/stream`.
//
// Phase 2 §2.4 + §13 updated event table. Delivers, over a single long-lived
// text/event-stream connection authenticated with NIP-98:
//
//   hello                — emitted once after auth + membership + replay.
//   gift-wrap            — kind:1059 wrap addressed to caller (#p:caller).
//   key-grant            — kind:30521 grant addressed to caller (d-suffix).
//   declaration-updated  — kind:30520 changes for the subscribed audience.
//   epoch-rotated        — synthetic, when fa:epoch on the cached decl moves.
//   error                — recoverable warnings; fatal errors close the stream.
//   keepalive            — ":" SSE comment every 25s (under all proxy idles).
//
// Membership is checked at connect time only. If the caller is removed during
// the stream's lifetime, they continue to receive events until they
// disconnect — the next-epoch grants/wraps simply won't address them.
//
// Live tail strategy (v0): poll the relay-pool DO's local cache for new
// gift-wraps and key-grants. The gateway's /audience/publish + /raw/* writes
// land directly in the cache via storeGiftWrap/storeAudienceEvent, so a
// same-instance publisher → subscriber pair sees events within one poll
// cycle. Cross-instance reads (external relay subscriptions for kind:1059
// #p:caller) are tracked as a t15 follow-up — when added, the live-tail loop
// gains a second source but the SSE shape is unchanged.
//
// Cloudflare Workers SSE: a TransformStream pumped by a detached async
// iterator. The Worker returns the readable end as the response body; the
// pump catches writer-closed errors when the client disconnects and exits.

import { verifyNip98 } from "./lib/nip98";
import {
  parseAudienceDeclaration,
  type AudienceDeclaration,
} from "./audience-validator";
import type { NostrEvent, RelayPool } from "./relay-pool";

const HEX64 = /^[0-9a-f]{64}$/i;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const SSE_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  Connection: "keep-alive",
  // Disable upstream proxy buffering (nginx/CF). Keepalives stay below the
  // 25s default idle; this header makes the path explicit for any proxy that
  // honors it.
  "X-Accel-Buffering": "no",
};

const JSON_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function jsonError(
  code: string,
  message: string,
  status: number,
): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: JSON_HEADERS,
  });
}

export type StreamEnv = {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
};

export interface StreamConfig {
  /** Live-tail poll interval (ms). */
  livePollMs: number;
  /** Keepalive comment interval (ms). Must be < proxy idle threshold. */
  keepaliveMs: number;
  /** Declaration re-poll interval (ms) for epoch-rotated detection. */
  epochPollMs: number;
  /** Max events drained per live-tail cycle (per source). */
  livePollLimit: number;
}

export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  livePollMs: 2_000,
  keepaliveMs: 25_000,
  epochPollMs: 5 * 60 * 1000,
  livePollLimit: 100,
};

const REPLAY_LIMIT_DEFAULT = 200;
const REPLAY_LIMIT_MAX = 1000;

type StubLike = {
  getObject(kind: number, pubkey: string, d: string): Promise<NostrEvent | null>;
  listGiftWraps(
    recipient: string,
    sinceUnix?: number,
    limit?: number,
  ): Promise<NostrEvent[]>;
  listKeyGrants(
    recipient: string,
    sinceUnix?: number,
    limit?: number,
  ): Promise<NostrEvent[]>;
};

function getStub(env: StreamEnv): StubLike {
  const id = env.RELAY_POOL.idFromName("main");
  return env.RELAY_POOL.get(id) as unknown as StubLike;
}

interface ReplayItem {
  kind: "gift-wrap" | "key-grant" | "declaration-updated";
  event: NostrEvent;
}

function buildItemData(item: ReplayItem): Record<string, unknown> {
  const receivedAtMs = item.event.created_at * 1000;
  if (item.kind === "gift-wrap") {
    return { wrap_event: item.event, received_at_ms: receivedAtMs };
  }
  if (item.kind === "key-grant") {
    return { grant_event: item.event, received_at_ms: receivedAtMs };
  }
  return { declaration_event: item.event, received_at_ms: receivedAtMs };
}

export async function handleAudienceStreamRequest(
  request: Request,
  slug: string,
  env: StreamEnv,
  config: StreamConfig = DEFAULT_STREAM_CONFIG,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }

  // 1. NIP-98 auth (GET → no body).
  const auth = await verifyNip98(request, undefined);
  if (!auth.ok) {
    return jsonError(auth.error, "NIP-98 auth failed", 401);
  }

  const url = new URL(request.url);
  const audIdPub = url.searchParams.get("aud_id_pub");
  if (!audIdPub || !HEX64.test(audIdPub)) {
    return jsonError(
      "bad_request",
      "aud_id_pub query param required (32-byte hex)",
      400,
    );
  }

  const sinceTsRaw = url.searchParams.get("since_ts");
  let sinceUnix: number | undefined;
  if (sinceTsRaw !== null) {
    const ms = Number(sinceTsRaw);
    if (!Number.isFinite(ms) || ms < 0) {
      return jsonError("bad_request", "since_ts must be a non-negative integer (unix ms)", 400);
    }
    sinceUnix = Math.floor(ms / 1000);
  }

  const replayLimitRaw = url.searchParams.get("replay_limit");
  let replayLimit = REPLAY_LIMIT_DEFAULT;
  if (replayLimitRaw !== null) {
    const n = Number(replayLimitRaw);
    if (!Number.isFinite(n) || n <= 0) {
      return jsonError("bad_request", "replay_limit must be a positive integer", 400);
    }
    replayLimit = Math.min(Math.floor(n), REPLAY_LIMIT_MAX);
  }

  // 2. Membership gate — read declaration from local cache.
  const stub = getStub(env);
  const declEvent = await stub.getObject(30520, audIdPub.toLowerCase(), slug);
  if (!declEvent) {
    return jsonError("not_found", "audience declaration not found in relay cache", 404);
  }
  const declParsed = parseAudienceDeclaration(declEvent);
  if (!declParsed.ok) {
    return jsonError("internal_error", `cached declaration invalid: ${declParsed.error}`, 500);
  }
  const decl = declParsed.value;
  const callerLower = auth.pubkey.toLowerCase();
  if (!decl.members.some((m) => m.toLowerCase() === callerLower)) {
    return jsonError("forbidden", "caller is not a current member of the audience", 403);
  }

  // 3. SSE pump.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;

  async function safeWrite(chunk: string): Promise<boolean> {
    if (closed) return false;
    try {
      await writer.write(encoder.encode(chunk));
      return true;
    } catch {
      closed = true;
      return false;
    }
  }

  function formatEvent(eventName: string, data: unknown, sseId?: string): string {
    let s = "";
    if (sseId !== undefined) s += `id: ${sseId}\n`;
    s += `event: ${eventName}\n`;
    s += `data: ${JSON.stringify(data)}\n\n`;
    return s;
  }

  function emit(eventName: string, data: unknown, sseId?: string): Promise<boolean> {
    return safeWrite(formatEvent(eventName, data, sseId));
  }

  function emitComment(comment: string): Promise<boolean> {
    return safeWrite(`:${comment}\n\n`);
  }

  // Pump runs detached from the response — Workers keeps the stream open
  // until the client disconnects, at which point writer.write() rejects and
  // we exit cleanly.
  (async () => {
    try {
      // ── Replay ────────────────────────────────────────────────────────
      // Per plan: emit replay events with created_at > since_ts in
      // chronological order, BEFORE hello.
      if (sinceUnix !== undefined) {
        const items: ReplayItem[] = [];

        const wraps = await stub.listGiftWraps(auth.pubkey, sinceUnix, replayLimit);
        for (const w of wraps) {
          if (w.created_at > sinceUnix) {
            items.push({ kind: "gift-wrap", event: w });
          }
        }

        const grants = await stub.listKeyGrants(auth.pubkey, sinceUnix, replayLimit);
        for (const g of grants) {
          if (g.created_at > sinceUnix) {
            items.push({ kind: "key-grant", event: g });
          }
        }

        // Declarations are replaceable — at most one current entry. Replay
        // it if its created_at exceeds since_ts (i.e. it changed after the
        // caller's last seen cursor).
        if (declEvent.created_at > sinceUnix) {
          items.push({ kind: "declaration-updated", event: declEvent });
        }

        items.sort((a, b) => a.event.created_at - b.event.created_at);

        for (const item of items.slice(0, replayLimit)) {
          if (closed) return;
          const ok = await emit(item.kind, buildItemData(item), item.event.id);
          if (!ok) return;
        }
      }

      // ── Hello ─────────────────────────────────────────────────────────
      if (closed) return;
      const helloOk = await emit("hello", {
        audience_slug: slug,
        epoch: decl.epoch,
        server_ts_ms: Date.now(),
      });
      if (!helloOk) return;

      // ── Live tail ─────────────────────────────────────────────────────
      let cursorUnix = Math.floor(Date.now() / 1000);
      const seenIds = new Set<string>();
      let lastEpoch = decl.epoch;
      let lastDeclId = declEvent.id;
      let lastKeepalive = Date.now();
      let lastEpochPoll = Date.now();

      while (!closed) {
        const newWraps = await stub.listGiftWraps(
          auth.pubkey,
          cursorUnix,
          config.livePollLimit,
        );
        for (const w of newWraps) {
          if (closed) return;
          if (w.created_at <= cursorUnix) continue;
          if (seenIds.has(w.id)) continue;
          seenIds.add(w.id);
          const ok = await emit(
            "gift-wrap",
            { wrap_event: w, received_at_ms: w.created_at * 1000 },
            w.id,
          );
          if (!ok) return;
        }

        const newGrants = await stub.listKeyGrants(
          auth.pubkey,
          cursorUnix,
          config.livePollLimit,
        );
        for (const g of newGrants) {
          if (closed) return;
          if (g.created_at <= cursorUnix) continue;
          if (seenIds.has(g.id)) continue;
          seenIds.add(g.id);
          const ok = await emit(
            "key-grant",
            { grant_event: g, received_at_ms: g.created_at * 1000 },
            g.id,
          );
          if (!ok) return;
        }

        // Re-poll the declaration on a slower cadence — most cycles skip.
        if (Date.now() - lastEpochPoll >= config.epochPollMs) {
          const cur = await stub.getObject(30520, audIdPub.toLowerCase(), slug);
          if (cur) {
            const parsed = parseAudienceDeclaration(cur);
            if (parsed.ok) {
              if (cur.id !== lastDeclId) {
                if (closed) return;
                const ok = await emit(
                  "declaration-updated",
                  { declaration_event: cur, received_at_ms: cur.created_at * 1000 },
                  cur.id,
                );
                if (!ok) return;
                lastDeclId = cur.id;
              }
              if (parsed.value.epoch !== lastEpoch) {
                if (closed) return;
                const ok = await emit("epoch-rotated", {
                  new_epoch: parsed.value.epoch,
                  members: parsed.value.members,
                });
                if (!ok) return;
                lastEpoch = parsed.value.epoch;
              }
            }
          }
          lastEpochPoll = Date.now();
        }

        // Keepalive comment.
        if (Date.now() - lastKeepalive >= config.keepaliveMs) {
          if (closed) return;
          const ok = await emitComment("");
          if (!ok) return;
          lastKeepalive = Date.now();
        }

        // Bump cursor only AFTER all writes for this batch succeed, so a
        // dropped write doesn't silently advance past unseen events.
        // (The seenIds set is the dedup belt — cursor is the suspenders.)
        cursorUnix = Math.floor(Date.now() / 1000);

        await new Promise((r) => setTimeout(r, config.livePollMs));
      }
    } catch (err) {
      // Best-effort error event before closing. If the writer is already
      // dead, this no-ops silently.
      try {
        await emit("error", {
          error: "stream_error",
          message: err instanceof Error ? err.message : "stream pump failed",
        });
      } catch {
        // ignore
      }
    } finally {
      closed = true;
      try {
        await writer.close();
      } catch {
        // ignore
      }
    }
  })().catch(() => {
    // Detached — nothing to surface.
  });

  return new Response(readable, { status: 200, headers: SSE_HEADERS });
}

// Re-exports for tests.
export { CORS_HEADERS as __streamCorsHeaders };
