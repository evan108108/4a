// T2b — `GET /v0/audience/:slug/stream` SSE endpoint.
//
// Covers §2.4 + §13's updated event table:
//   - 401 on missing/invalid NIP-98.
//   - 403 when the caller_pubkey is not in the cached declaration's members.
//   - hello after auth+membership pass on a fresh connection.
//   - since_ts replay of gift-wraps + key-grants + declaration-updated, in
//     chronological order, BEFORE hello.
//   - Live tail: a wrap appearing in the cache after hello arrives within
//     one poll cycle.
//   - Live tail: a key-grant addressed to caller arrives.
//   - Live tail: declaration replaced (new id) → declaration-updated event.
//   - Live tail: declaration epoch advanced → epoch-rotated event.
//   - Keepalive: ":" SSE comment after the configured idle threshold.
//
// We mock the relay-pool stub as a plain object exposing the three methods
// the handler calls — `getObject`, `listGiftWraps`, `listKeyGrants` — so the
// tests don't need a Workers/DO test harness. The router→handler dispatch
// is exercised via a direct call to `handleAudienceStreamRequest`.

import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { signEventWithRawKey } from "../lib/sign";
import {
  buildAudienceDeclaration,
  buildKeyGrant,
} from "../lib/audience-events";
import {
  handleAudienceStreamRequest,
  type StreamConfig,
  type StreamEnv,
} from "../audience-stream";
import type { NostrEvent } from "../relay-pool";
import type { SignedEvent } from "../kms";

// ── Test keys ───────────────────────────────────────────────────────────────

const AUD_ID_PRIV = hexToBytes(
  "1111111111111111111111111111111111111111111111111111111111111111",
);
const AUD_ID_PUB = bytesToHex(schnorr.getPublicKey(AUD_ID_PRIV));

const MEMBER_PRIV = hexToBytes(
  "2222222222222222222222222222222222222222222222222222222222222222",
);
const MEMBER_PUB = bytesToHex(schnorr.getPublicKey(MEMBER_PRIV));

const NON_MEMBER_PRIV = hexToBytes(
  "3333333333333333333333333333333333333333333333333333333333333333",
);
const NON_MEMBER_PUB = bytesToHex(schnorr.getPublicKey(NON_MEMBER_PRIV));

const EPOCH_PRIV = hexToBytes(
  "4444444444444444444444444444444444444444444444444444444444444444",
);
const EPOCH_PUB = bytesToHex(schnorr.getPublicKey(EPOCH_PRIV));

const SLUG = "team-design";

// ── NIP-98 helpers ──────────────────────────────────────────────────────────

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function makeNip98Header(opts: {
  url: string;
  method: string;
  priv: Uint8Array;
}): string {
  const signed = signEventWithRawKey(
    {
      created_at: nowSec(),
      kind: 27235,
      tags: [
        ["u", opts.url],
        ["method", opts.method],
      ],
      content: "",
    },
    opts.priv,
  );
  return "Nostr " + btoa(JSON.stringify(signed));
}

// ── Stub builder ────────────────────────────────────────────────────────────

interface FakeStub {
  declaration: NostrEvent | null;
  giftWraps: NostrEvent[];
  keyGrants: NostrEvent[];
  getObject: (
    kind: number,
    pubkey: string,
    d: string,
  ) => Promise<NostrEvent | null>;
  listGiftWraps: (
    recipient: string,
    sinceUnix?: number,
    limit?: number,
  ) => Promise<NostrEvent[]>;
  listKeyGrants: (
    recipient: string,
    sinceUnix?: number,
    limit?: number,
  ) => Promise<NostrEvent[]>;
}

function makeFakeStub(initial: {
  declaration: NostrEvent | null;
  giftWraps?: NostrEvent[];
  keyGrants?: NostrEvent[];
}): FakeStub {
  const stub: FakeStub = {
    declaration: initial.declaration,
    giftWraps: initial.giftWraps ?? [],
    keyGrants: initial.keyGrants ?? [],
    async getObject(kind, _pubkey, _d) {
      if (kind === 30520) return stub.declaration;
      return null;
    },
    async listGiftWraps(_recipient, sinceUnix, limit = 100) {
      const out = stub.giftWraps
        .filter((w) =>
          sinceUnix === undefined ? true : w.created_at > sinceUnix,
        )
        .sort((a, b) => a.created_at - b.created_at);
      return out.slice(0, limit);
    },
    async listKeyGrants(_recipient, sinceUnix, limit = 100) {
      const out = stub.keyGrants
        .filter((g) =>
          sinceUnix === undefined ? true : g.created_at > sinceUnix,
        )
        .sort((a, b) => a.created_at - b.created_at);
      return out.slice(0, limit);
    },
  };
  return stub;
}

function makeEnv(stub: FakeStub): StreamEnv {
  return {
    RELAY_POOL: {
      idFromName: () => "main",
      get: () => stub,
    } as unknown as DurableObjectNamespace,
  } as StreamEnv;
}

// ── Event fixtures ──────────────────────────────────────────────────────────

function makeDeclaration(opts: {
  members: string[];
  epoch?: number;
  createdAt?: number;
  epochPub?: string;
}): SignedEvent {
  const tpl = buildAudienceDeclaration({
    audIdPub: AUD_ID_PUB,
    slug: SLUG,
    name: "Team Design",
    epoch: opts.epoch ?? 1,
    epochPub: opts.epochPub ?? EPOCH_PUB,
    members: opts.members,
    createdAt: opts.createdAt ?? nowSec(),
  });
  return signEventWithRawKey(tpl, AUD_ID_PRIV);
}

let wrapCounter = 0;
function makeGiftWrap(opts: {
  createdAt: number;
  recipient?: string;
}): NostrEvent {
  // The stream handler doesn't validate gift-wrap envelopes — it just relays
  // them. We synthesize a plausible kind:1059 NostrEvent shape with a unique
  // id; sig is opaque to the handler.
  wrapCounter++;
  const recipient = opts.recipient ?? MEMBER_PUB;
  // Sign with the recipient priv just to produce a real id+sig for shape.
  const tpl = {
    kind: 1059,
    created_at: opts.createdAt,
    tags: [["p", recipient]],
    content: `wrap-content-${wrapCounter}`,
  };
  return signEventWithRawKey(tpl, NON_MEMBER_PRIV);
}

function makeFakeKeyGrant(opts: {
  recipient: string;
  epoch: number;
  createdAt: number;
}): SignedEvent {
  const tpl = buildKeyGrant({
    audIdPub: AUD_ID_PUB,
    slug: SLUG,
    epoch: opts.epoch,
    recipientPub: opts.recipient,
    ciphertext: "ciphertext-stub",
    createdAt: opts.createdAt,
  });
  return signEventWithRawKey(tpl, AUD_ID_PRIV);
}

// ── SSE reader ──────────────────────────────────────────────────────────────

interface SseFrame {
  id?: string;
  event?: string;
  data?: unknown;
  comment?: string;
  raw: string;
}

function parseSseFrame(block: string): SseFrame {
  const frame: SseFrame = { raw: block };
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      frame.comment = line.slice(1);
      continue;
    }
    if (line.startsWith("id: ")) frame.id = line.slice(4);
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("data: ")) {
      const raw = line.slice(6);
      try {
        frame.data = JSON.parse(raw);
      } catch {
        frame.data = raw;
      }
    }
  }
  return frame;
}

async function readSseFrames(
  res: Response,
  opts: {
    until: (frames: SseFrame[]) => boolean;
    timeoutMs?: number;
  },
): Promise<SseFrame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>(
      (resolve) => setTimeout(() => resolve({ done: true, value: undefined }), remaining),
    );
    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (block.length === 0) continue;
      frames.push(parseSseFrame(block));
    }
    if (opts.until(frames)) break;
  }

  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  return frames;
}

const FAST_CONFIG: StreamConfig = {
  livePollMs: 30,
  keepaliveMs: 200,
  epochPollMs: 60,
  livePollLimit: 100,
};

const URL_BASE = `https://api.4a4.ai/v0/audience/${SLUG}/stream?aud_id_pub=${AUD_ID_PUB}`;

// ── Tests ───────────────────────────────────────────────────────────────────

describe("audience stream — auth gate", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const stub = makeFakeStub({
      declaration: makeDeclaration({ members: [MEMBER_PUB] }),
    });
    const req = new Request(URL_BASE, { method: "GET" });
    const res = await handleAudienceStreamRequest(req, SLUG, makeEnv(stub));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_authorization_header");
  });

  it("returns 401 when NIP-98 event is malformed", async () => {
    const stub = makeFakeStub({
      declaration: makeDeclaration({ members: [MEMBER_PUB] }),
    });
    const req = new Request(URL_BASE, {
      method: "GET",
      headers: { Authorization: "Nostr not-base64-or-event" },
    });
    const res = await handleAudienceStreamRequest(req, SLUG, makeEnv(stub));
    expect(res.status).toBe(401);
  });
});

describe("audience stream — membership gate", () => {
  it("returns 403 when caller pubkey is not in the declaration's member set", async () => {
    const stub = makeFakeStub({
      declaration: makeDeclaration({ members: [MEMBER_PUB] }),
    });
    const req = new Request(URL_BASE, {
      method: "GET",
      headers: {
        Authorization: makeNip98Header({
          url: URL_BASE,
          method: "GET",
          priv: NON_MEMBER_PRIV,
        }),
      },
    });
    const res = await handleAudienceStreamRequest(req, SLUG, makeEnv(stub));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  it("returns 404 when the audience declaration is not in the cache", async () => {
    const stub = makeFakeStub({ declaration: null });
    const req = new Request(URL_BASE, {
      method: "GET",
      headers: {
        Authorization: makeNip98Header({
          url: URL_BASE,
          method: "GET",
          priv: MEMBER_PRIV,
        }),
      },
    });
    const res = await handleAudienceStreamRequest(req, SLUG, makeEnv(stub));
    expect(res.status).toBe(404);
  });

  it("returns 400 when aud_id_pub query param is missing", async () => {
    const url = `https://api.4a4.ai/v0/audience/${SLUG}/stream`;
    const stub = makeFakeStub({
      declaration: makeDeclaration({ members: [MEMBER_PUB] }),
    });
    const req = new Request(url, {
      method: "GET",
      headers: {
        Authorization: makeNip98Header({
          url,
          method: "GET",
          priv: MEMBER_PRIV,
        }),
      },
    });
    const res = await handleAudienceStreamRequest(req, SLUG, makeEnv(stub));
    expect(res.status).toBe(400);
  });
});

describe("audience stream — connection lifecycle", () => {
  it("emits hello immediately after auth+membership pass", async () => {
    const stub = makeFakeStub({
      declaration: makeDeclaration({ members: [MEMBER_PUB], epoch: 7 }),
    });
    const req = new Request(URL_BASE, {
      method: "GET",
      headers: {
        Authorization: makeNip98Header({
          url: URL_BASE,
          method: "GET",
          priv: MEMBER_PRIV,
        }),
      },
    });
    const res = await handleAudienceStreamRequest(
      req,
      SLUG,
      makeEnv(stub),
      FAST_CONFIG,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const frames = await readSseFrames(res, {
      until: (fs) => fs.some((f) => f.event === "hello"),
      timeoutMs: 1000,
    });
    const hello = frames.find((f) => f.event === "hello")!;
    expect(hello).toBeDefined();
    const data = hello.data as {
      audience_slug: string;
      epoch: number;
      server_ts_ms: number;
    };
    expect(data.audience_slug).toBe(SLUG);
    expect(data.epoch).toBe(7);
    expect(typeof data.server_ts_ms).toBe("number");
  });

  it("connect → hello → live gift-wrap appears → disconnect", async () => {
    const stub = makeFakeStub({
      declaration: makeDeclaration({ members: [MEMBER_PUB] }),
    });
    const req = new Request(URL_BASE, {
      method: "GET",
      headers: {
        Authorization: makeNip98Header({
          url: URL_BASE,
          method: "GET",
          priv: MEMBER_PRIV,
        }),
      },
    });
    const res = await handleAudienceStreamRequest(
      req,
      SLUG,
      makeEnv(stub),
      FAST_CONFIG,
    );

    // Inject a wrap shortly after hello, then read until we see it.
    setTimeout(() => {
      stub.giftWraps.push(makeGiftWrap({ createdAt: nowSec() + 10 }));
    }, 100);

    const frames = await readSseFrames(res, {
      until: (fs) =>
        fs.some((f) => f.event === "hello") &&
        fs.some((f) => f.event === "gift-wrap"),
      timeoutMs: 2000,
    });

    const events = frames.map((f) => f.event);
    const helloIdx = events.indexOf("hello");
    const wrapIdx = events.indexOf("gift-wrap");
    expect(helloIdx).toBeGreaterThanOrEqual(0);
    expect(wrapIdx).toBeGreaterThan(helloIdx);

    const wrap = frames[wrapIdx]!;
    const data = wrap.data as { wrap_event: NostrEvent; received_at_ms: number };
    expect(data.wrap_event.kind).toBe(1059);
    expect(typeof data.received_at_ms).toBe("number");
    expect(wrap.id).toBe(data.wrap_event.id);
  });
});

describe("audience stream — replay", () => {
  it("?since_ts replay returns 3 pre-seeded wraps in chronological order, then hello", async () => {
    const base = nowSec() - 1000;
    const sinceTsMs = (base - 10) * 1000;
    const wraps = [
      makeGiftWrap({ createdAt: base + 1 }),
      makeGiftWrap({ createdAt: base + 5 }),
      makeGiftWrap({ createdAt: base + 3 }),
    ];
    const stub = makeFakeStub({
      declaration: makeDeclaration({ members: [MEMBER_PUB] }),
      giftWraps: wraps,
    });
    const url = `${URL_BASE}&since_ts=${sinceTsMs}`;
    const req = new Request(url, {
      method: "GET",
      headers: {
        Authorization: makeNip98Header({
          url,
          method: "GET",
          priv: MEMBER_PRIV,
        }),
      },
    });
    const res = await handleAudienceStreamRequest(
      req,
      SLUG,
      makeEnv(stub),
      FAST_CONFIG,
    );
    const frames = await readSseFrames(res, {
      until: (fs) => fs.some((f) => f.event === "hello"),
      timeoutMs: 1000,
    });

    const replayed = frames.filter((f) => f.event === "gift-wrap");
    expect(replayed).toHaveLength(3);
    const tsList = replayed.map(
      (f) => (f.data as { wrap_event: NostrEvent }).wrap_event.created_at,
    );
    expect(tsList).toEqual([base + 1, base + 3, base + 5]);

    // hello must be after all replay events.
    const helloIdx = frames.findIndex((f) => f.event === "hello");
    let lastReplayIdx = -1;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i]!.event === "gift-wrap") {
        lastReplayIdx = i;
        break;
      }
    }
    expect(helloIdx).toBeGreaterThan(lastReplayIdx);
  });

  it("replay also covers key-grants and declaration-updated", async () => {
    const base = nowSec() - 1000;
    const sinceTsMs = (base - 10) * 1000;
    const decl = makeDeclaration({
      members: [MEMBER_PUB],
      createdAt: base + 2,
    });
    const wrap = makeGiftWrap({ createdAt: base + 1 });
    const grant = makeFakeKeyGrant({
      recipient: MEMBER_PUB,
      epoch: 1,
      createdAt: base + 4,
    });
    const stub = makeFakeStub({
      declaration: decl,
      giftWraps: [wrap],
      keyGrants: [grant],
    });
    const url = `${URL_BASE}&since_ts=${sinceTsMs}`;
    const req = new Request(url, {
      method: "GET",
      headers: {
        Authorization: makeNip98Header({
          url,
          method: "GET",
          priv: MEMBER_PRIV,
        }),
      },
    });
    const res = await handleAudienceStreamRequest(
      req,
      SLUG,
      makeEnv(stub),
      FAST_CONFIG,
    );
    const frames = await readSseFrames(res, {
      until: (fs) => fs.some((f) => f.event === "hello"),
      timeoutMs: 1000,
    });

    const events = frames
      .filter((f) => f.event && f.event !== "hello")
      .map((f) => f.event);
    expect(events).toEqual([
      "gift-wrap",
      "declaration-updated",
      "key-grant",
    ]);

    const grantFrame = frames.find((f) => f.event === "key-grant")!;
    const grantData = grantFrame.data as {
      grant_event: NostrEvent;
      received_at_ms: number;
    };
    expect(grantData.grant_event.kind).toBe(30521);
    expect(grantData.received_at_ms).toBe(grant.created_at * 1000);

    const declFrame = frames.find((f) => f.event === "declaration-updated")!;
    const declData = declFrame.data as { declaration_event: NostrEvent };
    expect(declData.declaration_event.kind).toBe(30520);
  });

  it("rejects since_ts in the past with replay_limit 0 → 400", async () => {
    const stub = makeFakeStub({
      declaration: makeDeclaration({ members: [MEMBER_PUB] }),
    });
    const url = `${URL_BASE}&since_ts=1000&replay_limit=0`;
    const req = new Request(url, {
      method: "GET",
      headers: {
        Authorization: makeNip98Header({
          url,
          method: "GET",
          priv: MEMBER_PRIV,
        }),
      },
    });
    const res = await handleAudienceStreamRequest(req, SLUG, makeEnv(stub));
    expect(res.status).toBe(400);
  });
});

describe("audience stream — live tail", () => {
  it("delivers a live key-grant as a key-grant SSE event", async () => {
    const stub = makeFakeStub({
      declaration: makeDeclaration({ members: [MEMBER_PUB] }),
    });
    const req = new Request(URL_BASE, {
      method: "GET",
      headers: {
        Authorization: makeNip98Header({
          url: URL_BASE,
          method: "GET",
          priv: MEMBER_PRIV,
        }),
      },
    });
    const res = await handleAudienceStreamRequest(
      req,
      SLUG,
      makeEnv(stub),
      FAST_CONFIG,
    );

    setTimeout(() => {
      stub.keyGrants.push(
        makeFakeKeyGrant({
          recipient: MEMBER_PUB,
          epoch: 2,
          createdAt: nowSec() + 30,
        }),
      );
    }, 100);

    const frames = await readSseFrames(res, {
      until: (fs) => fs.some((f) => f.event === "key-grant"),
      timeoutMs: 2000,
    });
    const grant = frames.find((f) => f.event === "key-grant")!;
    expect(grant).toBeDefined();
    const data = grant.data as { grant_event: NostrEvent };
    expect(data.grant_event.kind).toBe(30521);
  });

  it("emits epoch-rotated + declaration-updated when the cached declaration advances epoch", async () => {
    const stub = makeFakeStub({
      declaration: makeDeclaration({
        members: [MEMBER_PUB],
        epoch: 1,
        createdAt: nowSec() - 100,
      }),
    });
    const req = new Request(URL_BASE, {
      method: "GET",
      headers: {
        Authorization: makeNip98Header({
          url: URL_BASE,
          method: "GET",
          priv: MEMBER_PRIV,
        }),
      },
    });
    const res = await handleAudienceStreamRequest(
      req,
      SLUG,
      makeEnv(stub),
      FAST_CONFIG,
    );

    // Replace the cached declaration with one carrying a new epoch + new
    // member after hello. The live-tail loop's epochPollMs (60ms) will
    // pick it up on the next cycle.
    setTimeout(() => {
      stub.declaration = makeDeclaration({
        members: [MEMBER_PUB, NON_MEMBER_PUB],
        epoch: 2,
        createdAt: nowSec() + 5,
        epochPub: bytesToHex(
          schnorr.getPublicKey(
            hexToBytes(
              "5555555555555555555555555555555555555555555555555555555555555555",
            ),
          ),
        ),
      });
    }, 100);

    const frames = await readSseFrames(res, {
      until: (fs) =>
        fs.some((f) => f.event === "epoch-rotated") &&
        fs.some((f) => f.event === "declaration-updated"),
      timeoutMs: 2000,
    });
    const rotated = frames.find((f) => f.event === "epoch-rotated")!;
    const data = rotated.data as { new_epoch: number; members: string[] };
    expect(data.new_epoch).toBe(2);
    expect(data.members).toContain(MEMBER_PUB);
    expect(data.members).toContain(NON_MEMBER_PUB);

    const declUpdated = frames.find((f) => f.event === "declaration-updated")!;
    const declData = declUpdated.data as { declaration_event: NostrEvent };
    expect(declData.declaration_event.kind).toBe(30520);
  });
});

describe("audience stream — keepalive", () => {
  it("emits a `:` SSE comment after the configured idle threshold", async () => {
    const stub = makeFakeStub({
      declaration: makeDeclaration({ members: [MEMBER_PUB] }),
    });
    const req = new Request(URL_BASE, {
      method: "GET",
      headers: {
        Authorization: makeNip98Header({
          url: URL_BASE,
          method: "GET",
          priv: MEMBER_PRIV,
        }),
      },
    });
    const config: StreamConfig = {
      ...FAST_CONFIG,
      keepaliveMs: 80,
      epochPollMs: 10_000, // suppress epoch polling during the window
    };
    const res = await handleAudienceStreamRequest(
      req,
      SLUG,
      makeEnv(stub),
      config,
    );
    const frames = await readSseFrames(res, {
      until: (fs) => fs.some((f) => f.comment !== undefined),
      timeoutMs: 1500,
    });
    const keepalive = frames.find((f) => f.comment !== undefined);
    expect(keepalive).toBeDefined();
  });
});
