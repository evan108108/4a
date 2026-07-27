// Webhook-relay inbox stream — `GET /v0/inbox/:pubkey/stream` on api.4a4.ai.
//
// Pubkey-scoped SSE tail of hook wraps (webhook deliveries wrapped by
// webhook-receiver.ts). Mirrors audience-stream.ts's pump mechanics —
// replay-then-hello-then-live-tail over a 2s DO-cache poll — but with none of
// the audience machinery: no kind-30520 declaration lookup, no membership
// check, no key-grants, no epoch tracking. Authorization is simply "the
// caller IS the recipient": NIP-98 auth where auth.pubkey === path pubkey.
//
// Reads ONLY the hook-wrap prefix (relay-pool listHookWraps), so audience
// traffic addressed to the same pubkey never flows here and the subscribing
// plugin doesn't unwrap wraps it would discard.
//
// Events:
//   hello      — emitted once after auth + replay.
//   gift-wrap  — kind:1059 hook wrap addressed to the caller.
//   error      — recoverable warnings; fatal errors close the stream.
//   keepalive  — ":" SSE comment every 25s.
//
// Reconnect cursor: `?since=<unixSeconds>` replays wraps with server-receive
// time >= since (server-receive, NOT the NIP-59-jittered created_at).

import { verifyNip98 } from "./lib/nip98";
import type { NostrEvent, RelayPool } from "./relay-pool";

const HEX64 = /^[0-9a-f]{64}$/i;

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const REPLAY_LIMIT_DEFAULT = 200;
const REPLAY_LIMIT_MAX = 1000;

// Same self-termination caps as audience-stream: whichever hits first exits
// the pump even when a TCP-dropped client never faults writer.write().
const PUMP_MAX_ITERATIONS = 1800;
const PUMP_MAX_DURATION_MS = 60 * 60 * 1000;

export type InboxStreamEnv = {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
};

export interface InboxStreamConfig {
  /** Live-tail poll interval (ms). */
  livePollMs: number;
  /** Keepalive comment interval (ms). */
  keepaliveMs: number;
  /** Max wraps fetched per live poll. */
  livePollLimit: number;
}

const DEFAULT_CONFIG: InboxStreamConfig = {
  livePollMs: 2_000,
  keepaliveMs: 25_000,
  livePollLimit: 100,
};

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: JSON_HEADERS,
  });
}

export async function handleInboxStream(
  request: Request,
  pathPubkey: string,
  env: InboxStreamEnv,
  config: InboxStreamConfig = DEFAULT_CONFIG,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }
  if (!HEX64.test(pathPubkey)) {
    return jsonError("bad_request", "pubkey must be 32-byte hex", 400);
  }

  // NIP-98 auth (GET → no body). The caller must BE the inbox owner.
  const auth = await verifyNip98(request, undefined);
  if (!auth.ok) {
    return jsonError(auth.error, "NIP-98 auth failed", 401);
  }
  const caller = auth.pubkey.toLowerCase();
  if (caller !== pathPubkey.toLowerCase()) {
    return jsonError("forbidden", "authenticated pubkey does not match path pubkey", 403);
  }

  const url = new URL(request.url);
  const sinceRaw = url.searchParams.get("since");
  let sinceUnix: number | undefined;
  if (sinceRaw !== null) {
    const s = Number(sinceRaw);
    if (!Number.isFinite(s) || s < 0) {
      return jsonError("bad_request", "since must be a non-negative integer (unix seconds)", 400);
    }
    sinceUnix = Math.floor(s);
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

  const id = env.RELAY_POOL.idFromName("main");
  const stub = env.RELAY_POOL.get(id);

  // SSE pump — same TransformStream + detached-iterator shape as
  // audience-stream.ts, including the abort-listener disconnect detection.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;

  if (request.signal) {
    request.signal.addEventListener(
      "abort",
      () => {
        if (!closed) {
          console.log("[inbox-stream] abort-detected", { caller: caller.slice(0, 12) });
          closed = true;
        }
      },
      { once: true },
    );
  }

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

  function emit(eventName: string, data: unknown, sseId?: string): Promise<boolean> {
    let s = "";
    if (sseId !== undefined) s += `id: ${sseId}\n`;
    s += `event: ${eventName}\n`;
    s += `data: ${JSON.stringify(data)}\n\n`;
    return safeWrite(s);
  }

  function emitWrap(w: NostrEvent): Promise<boolean> {
    return emit("gift-wrap", { wrap_event: w, received_at_ms: w.created_at * 1000 }, w.id);
  }

  (async () => {
    try {
      // ── Replay ────────────────────────────────────────────────────────
      if (sinceUnix !== undefined) {
        const wraps = await stub.listHookWraps(caller, sinceUnix, replayLimit);
        for (const w of wraps) {
          if (closed) return;
          const ok = await emitWrap(w);
          if (!ok) return;
        }
      }

      // ── Hello ─────────────────────────────────────────────────────────
      if (closed) return;
      const helloOk = await emit("hello", { pubkey: caller, server_ts_ms: Date.now() });
      if (!helloOk) return;

      // ── Live tail ─────────────────────────────────────────────────────
      // Cursor sits OVERLAP_SECONDS behind wall-clock so a wrap stored the
      // same second as a poll gets re-polled; seenIds dedupes the overlap.
      // (Same T4b boundary reasoning as audience-stream.)
      const OVERLAP_SECONDS = 10;
      let cursorUnix = Math.floor(Date.now() / 1000) - OVERLAP_SECONDS;
      const seenIds = new Set<string>();
      let lastKeepalive = Date.now();
      const pumpStartedAt = Date.now();
      let iterations = 0;

      while (!closed) {
        if (iterations >= PUMP_MAX_ITERATIONS) {
          console.log("[inbox-stream] max-iteration-hit", { caller: caller.slice(0, 12), iterations });
          closed = true;
          break;
        }
        if (Date.now() - pumpStartedAt >= PUMP_MAX_DURATION_MS) {
          console.log("[inbox-stream] max-duration-hit", { caller: caller.slice(0, 12) });
          closed = true;
          break;
        }
        iterations++;

        const newWraps = await stub.listHookWraps(caller, cursorUnix, config.livePollLimit);
        for (const w of newWraps) {
          if (closed) return;
          if (seenIds.has(w.id)) continue;
          seenIds.add(w.id);
          const ok = await emitWrap(w);
          if (!ok) return;
        }

        if (Date.now() - lastKeepalive >= config.keepaliveMs) {
          if (closed) return;
          const ok = await safeWrite(":\n\n");
          if (!ok) return;
          lastKeepalive = Date.now();
        }

        // Advance only after all writes for the batch succeeded.
        cursorUnix = Math.floor(Date.now() / 1000) - OVERLAP_SECONDS;

        await new Promise((r) => setTimeout(r, config.livePollMs));
      }
    } catch (err) {
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
