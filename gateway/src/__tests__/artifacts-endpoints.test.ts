// Public Artifacts endpoint tests — /v0/artifacts/* (Task 2).
//
// Plan verification matrix, scenarios 1-7, plus the dispatcher-specified
// supersede-vs-address-revocation case (Alice/Bob):
//   1. round-trip publish (real BUD-01 upload → manifest → both renders)
//   2. wrong-signer rejection (403 not_uploader, nothing stored)
//   3. malformed-manifest rejections (distinct 4xx per failure class)
//   4. replaceable supersede (frozen URL keeps serving v1's own metadata)
//   5. duplicate blob → 409 blob_already_bound, first binding wins
//   6. kind:5 e-tag revocation → 410 with attribution; not_owner skipped
//   7. kind:5 a-tag + republish (NIP-09 time semantics un-revoke)
//   8. Alice/Bob: addr revocation between v1 and v2 → frozen(v1) 410,
//      d-tag(v2) 200
//
// Task 1's DO methods (relay-pool additions) are MOCKED — the fake pool below
// is the dispatcher-confirmed interface contract (manifestIds naming, 4-param
// getArtifactRevocation, artifactid: storing the full manifest event behind
// getArtifactManifest). Same harness conventions as webhook-receiver.test.ts.

import { describe, expect, it } from "vitest";
import { vi } from "vitest";

// artifacts.ts → publish.ts → relay-pool.ts → `cloudflare:workers`, which
// doesn't exist under vitest/node. Only the DurableObject base class is
// touched at module scope — stub it. (Hoisted above the imports below.)
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { signEventWithRawKey } from "../lib/sign";
import { sha256Hex } from "../lib/blossom-auth";
import { blake3ContentTag } from "../lib/blake3-tag";
import { handleBlossomUpload } from "../blossom";
import {
  handleArtifactsRequest,
  ARTIFACT_CSP,
  type ArtifactBlobBinding,
  type ArtifactPool,
  type ArtifactsEnv,
  type ResolvedRevocation,
} from "../artifacts";
import { findTag } from "../artifact-manifest-validator";
import type { NostrEvent } from "../relay-pool";

// ── Test keys ───────────────────────────────────────────────────────────────

function keypair(fill: string): { priv: Uint8Array; pub: string } {
  const priv = hexToBytes(fill.repeat(32));
  return { priv, pub: bytesToHex(schnorr.getPublicKey(priv)) };
}

const ALICE = keypair("11");
const BOB = keypair("22");
const CAROL = keypair("33");
const DAVE = keypair("44");
const ERIN = keypair("55");

// ── Fake pool (Task 1 interface contract) ───────────────────────────────────

interface FakePool extends ArtifactPool {
  events: Map<string, NostrEvent>;
  manifestsById: Map<string, NostrEvent>;
  bindings: Map<string, ArtifactBlobBinding>;
  revById: Map<string, NostrEvent>;
  revByAddr: Map<string, NostrEvent>;
  storeCalls: number;
}

function makeFakePool(): FakePool {
  const pool: FakePool = {
    events: new Map(),
    manifestsById: new Map(),
    bindings: new Map(),
    revById: new Map(),
    revByAddr: new Map(),
    storeCalls: 0,

    async getObject(kind, pubkey, d) {
      return pool.events.get(`${kind}:${pubkey}:${d}`) ?? null;
    },

    async storeArtifactManifest(event) {
      pool.storeCalls++;
      const d = findTag(event.tags, "d")!;
      const sha = findTag(event.tags, "blob")!.toLowerCase();
      const key = `30540:${event.pubkey}:${d}`;
      const existing = pool.events.get(key);
      if (existing && existing.created_at >= event.created_at) {
        return { ok: true, superseded: true, bound: true };
      }
      pool.events.set(key, event);
      // artifactid: full historical snapshot (dispatcher-confirmed).
      pool.manifestsById.set(event.id, event);
      const binding = pool.bindings.get(sha);
      if (!binding) {
        pool.bindings.set(sha, { pubkey: event.pubkey, d, eventId: event.id, boundAtMs: 1 });
        return { ok: true, superseded: false, bound: true };
      }
      if (binding.pubkey === event.pubkey && binding.d === d) {
        binding.eventId = event.id; // refresh on same-(pubkey,d) republish
        return { ok: true, superseded: false, bound: true };
      }
      return { ok: true, superseded: false, bound: false };
    },

    async getArtifactBlobBinding(sha) {
      return pool.bindings.get(sha) ?? null;
    },

    async getArtifactManifest(eventId) {
      return pool.manifestsById.get(eventId) ?? null;
    },

    async storeArtifactRevocation(event, resolved: ResolvedRevocation) {
      for (const id of resolved.manifestIds) pool.revById.set(id, event);
      for (const { pubkey, d } of resolved.addresses) {
        const key = `${pubkey}:${d}`;
        const current = pool.revByAddr.get(key);
        if (!current || current.created_at <= event.created_at) pool.revByAddr.set(key, event);
      }
      return { ok: true };
    },

    async getArtifactRevocation(manifestEventId, pubkey, d, manifestCreatedAt) {
      const byId = pool.revById.get(manifestEventId);
      if (byId) return { revoked: true, by: byId.pubkey, at: byId.created_at };
      const byAddr = pool.revByAddr.get(`${pubkey}:${d}`);
      if (byAddr && manifestCreatedAt <= byAddr.created_at) {
        return { revoked: true, by: byAddr.pubkey, at: byAddr.created_at };
      }
      return { revoked: false };
    },
  };
  return pool;
}

// ── Fake R2 ─────────────────────────────────────────────────────────────────

interface FakeR2 {
  objects: Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>;
  seedBlob(sha: string, uploaderPubkey: string): void;
  head(key: string): Promise<unknown>;
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown, opts?: { customMetadata?: Record<string, string> }): Promise<void>;
}

function makeFakeR2(): FakeR2 {
  const r2: FakeR2 = {
    objects: new Map(),
    seedBlob(sha, uploaderPubkey) {
      r2.objects.set(`blob/${sha}`, {
        bytes: new Uint8Array([1, 2, 3]),
        customMetadata: { uploader_pubkey: uploaderPubkey },
      });
    },
    async head(key: string) {
      const obj = r2.objects.get(key);
      if (!obj) return null;
      return { size: obj.bytes.length, customMetadata: obj.customMetadata };
    },
    async get(key: string) {
      const obj = r2.objects.get(key);
      if (!obj) return null;
      return {
        size: obj.bytes.length,
        customMetadata: obj.customMetadata,
        body: obj.bytes,
        async text() {
          return new TextDecoder().decode(obj.bytes);
        },
      };
    },
    async put(key: string, value: unknown, opts?: { customMetadata?: Record<string, string> }) {
      const bytes =
        value instanceof Uint8Array
          ? value
          : new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
      r2.objects.set(key, { bytes, customMetadata: opts?.customMetadata });
    },
  };
  return r2;
}

function makeEnv(pool: FakePool, r2: FakeR2): ArtifactsEnv {
  return {
    RELAY_POOL: { idFromName: () => "main", get: () => pool },
    STORAGE: r2,
  } as unknown as ArtifactsEnv;
}

// ── Event + request builders ────────────────────────────────────────────────

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

interface ManifestOpts {
  d?: string;
  blob?: string;
  type?: string;
  title?: string;
  alt?: string;
  blake3?: string;
  content?: string;
  created_at?: number;
  omit?: ("d" | "blob" | "type" | "alt" | "blake3")[];
}

function manifestEvent(priv: Uint8Array, opts: ManifestOpts = {}): NostrEvent {
  const content = opts.content ?? "";
  const omit = new Set(opts.omit ?? []);
  const tags: string[][] = [];
  if (!omit.has("d")) tags.push(["d", opts.d ?? "my-artifact"]);
  if (!omit.has("blob")) tags.push(["blob", opts.blob ?? "ab".repeat(32)]);
  if (!omit.has("type")) tags.push(["type", opts.type ?? "text/html"]);
  if (opts.title !== undefined) tags.push(["title", opts.title]);
  if (!omit.has("alt")) tags.push(["alt", opts.alt ?? "Public artifact"]);
  if (!omit.has("blake3")) tags.push(["blake3", opts.blake3 ?? blake3ContentTag(content)]);
  return signEventWithRawKey(
    { kind: 30540, created_at: opts.created_at ?? nowSec(), tags, content },
    priv,
  ) as NostrEvent;
}

function kind5Event(priv: Uint8Array, tags: string[][], createdAt?: number): NostrEvent {
  return signEventWithRawKey(
    { kind: 5, created_at: createdAt ?? nowSec(), tags, content: "" },
    priv,
  ) as NostrEvent;
}

function postEvent(path: string, event: unknown): Request {
  return new Request(`https://api.4a4.ai${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event }),
  });
}

function getPath(path: string): Request {
  return new Request(`https://api.4a4.ai${path}`);
}

async function publishManifest(env: ArtifactsEnv, event: NostrEvent): Promise<Response> {
  return handleArtifactsRequest(postEvent("/v0/artifacts/manifest", event), env);
}

async function revoke(env: ArtifactsEnv, event: NostrEvent): Promise<Response> {
  return handleArtifactsRequest(postEvent("/v0/artifacts/revoke", event), env);
}

async function render(env: ArtifactsEnv, path: string): Promise<Response> {
  return handleArtifactsRequest(getPath(path), env);
}

// Extract and parse the manifest-metadata JSON island out of the shell HTML.
async function islandOf(res: Response): Promise<Record<string, unknown>> {
  const html = await res.text();
  const m = /<script type="application\/json" id="m">(.*?)<\/script>/s.exec(html);
  expect(m, "shell HTML must contain the JSON metadata island").toBeTruthy();
  return JSON.parse(m![1]!) as Record<string, unknown>;
}

// Distinct lowercase fake blob hashes (endpoints treat sha as an opaque key;
// scenario 1 exercises the real upload path with a real sha256).
const SHA_1 = "a1".repeat(32);
const SHA_2 = "b2".repeat(32);
const SHA_3 = "c3".repeat(32);
const SHA_4 = "d4".repeat(32);
const SHA_A = "e5".repeat(32);
const SHA_B = "f6".repeat(32);

// ── Scenario 1: round-trip publish ──────────────────────────────────────────

describe("scenario 1 — round-trip publish", () => {
  it("BUD-01 upload → manifest publish → frozen + d-tag renders with CSP", async () => {
    const pool = makeFakePool();
    const r2 = makeFakeR2();
    const env = makeEnv(pool, r2);

    // Real BUD-01 upload through the shipped handler.
    const body = new TextEncoder().encode("iv||ciphertext-bytes");
    const sha = await sha256Hex(body);
    const auth = signEventWithRawKey(
      {
        kind: 24242,
        created_at: nowSec(),
        tags: [
          ["t", "upload"],
          ["x", sha],
          ["expiration", String(nowSec() + 300)],
        ],
        content: "",
      },
      ALICE.priv,
    );
    const uploadRes = await handleBlossomUpload(
      new Request("https://api.4a4.ai/blossom/upload", {
        method: "PUT",
        headers: { authorization: "Nostr " + btoa(JSON.stringify(auth)) },
        body,
      }),
      { STORAGE: r2 } as unknown as { STORAGE: R2Bucket },
    );
    expect(uploadRes.status).toBe(200);

    const manifest = manifestEvent(ALICE.priv, {
      d: "q3-dashboard",
      blob: sha,
      title: "Q3 Pipeline Dashboard",
    });
    const pubRes = await publishManifest(env, manifest);
    expect(pubRes.status).toBe(200);
    const pubBody = (await pubRes.json()) as Record<string, unknown>;
    expect(pubBody.ok).toBe(true);
    expect(pubBody.superseded).toBe(false);
    expect(pubBody.frozen_url).toBe(`https://api.4a4.ai/v0/artifacts/${sha}`);
    expect(pubBody.latest_url).toBe(`https://api.4a4.ai/v0/artifacts/${ALICE.pub}/q3-dashboard`);

    for (const [path, mode] of [
      [`/v0/artifacts/${sha}`, "frozen"],
      [`/v0/artifacts/${ALICE.pub}/q3-dashboard`, "latest"],
    ] as const) {
      const res = await render(env, path);
      expect(res.status, path).toBe(200);
      // CSP exact-match, on every render response.
      expect(res.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
      expect(res.headers.get("cache-control")).toBe("public, max-age=30");
      const meta = await islandOf(res);
      expect(meta.sha256).toBe(sha);
      expect(meta.title).toBe("Q3 Pipeline Dashboard");
      expect(meta.pubkey).toBe(ALICE.pub);
      expect(meta.d).toBe("q3-dashboard");
      expect(meta.mode).toBe(mode);
      expect(meta.event_id).toBe(manifest.id);
    }
  });

  it("answers OPTIONS preflight with 204 and serves viewer.js immutable", async () => {
    const env = makeEnv(makeFakePool(), makeFakeR2());
    const preflight = await handleArtifactsRequest(
      new Request("https://api.4a4.ai/v0/artifacts/manifest", { method: "OPTIONS" }),
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");

    const js = await render(env, "/v0/artifacts/viewer.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});

// ── Scenario 2: wrong-signer rejection ──────────────────────────────────────

describe("scenario 2 — wrong signer", () => {
  it("403 not_uploader when the manifest signer is not the blob uploader; nothing stored", async () => {
    const pool = makeFakePool();
    const r2 = makeFakeR2();
    r2.seedBlob(SHA_1, ALICE.pub);
    const env = makeEnv(pool, r2);

    const res = await publishManifest(env, manifestEvent(BOB.priv, { blob: SHA_1 }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_uploader");
    expect(pool.storeCalls).toBe(0);
    expect(pool.events.size).toBe(0);
    expect(pool.bindings.size).toBe(0);
  });
});

// ── Scenario 3: malformed-manifest rejections ───────────────────────────────

describe("scenario 3 — malformed manifests", () => {
  it("rejects each failure class with its own 4xx code and stores nothing", async () => {
    const pool = makeFakePool();
    const r2 = makeFakeR2();
    r2.seedBlob(SHA_1, CAROL.pub);
    const env = makeEnv(pool, r2);
    const good = () => manifestEvent(CAROL.priv, { blob: SHA_1 });

    const cases: { name: string; event: unknown; status: number; code: string }[] = [
      {
        name: "bad signature",
        event: { ...good(), sig: "ab".repeat(64) },
        status: 400,
        code: "bad_signature",
      },
      {
        name: "id mismatch",
        event: { ...good(), id: "cd".repeat(32) },
        status: 400,
        code: "id_mismatch",
      },
      {
        name: "wrong kind",
        event: signEventWithRawKey(
          { kind: 30541, created_at: nowSec(), tags: [], content: "" },
          CAROL.priv,
        ),
        status: 400,
        code: "wrong_kind",
      },
      {
        name: "missing d",
        event: manifestEvent(CAROL.priv, { blob: SHA_1, omit: ["d"] }),
        status: 400,
        code: "bad_d_tag",
      },
      {
        name: "missing blob",
        event: manifestEvent(CAROL.priv, { omit: ["blob"] }),
        status: 400,
        code: "bad_blob_tag",
      },
      {
        name: "non-hex blob",
        event: manifestEvent(CAROL.priv, { blob: "zz".repeat(32) }),
        status: 400,
        code: "bad_blob_tag",
      },
      {
        name: "missing type",
        event: manifestEvent(CAROL.priv, { blob: SHA_1, omit: ["type"] }),
        status: 400,
        code: "bad_type_tag",
      },
      {
        name: "bad MIME",
        event: manifestEvent(CAROL.priv, { blob: SHA_1, type: "NotAMime" }),
        status: 400,
        code: "bad_type_tag",
      },
      {
        name: "missing alt",
        event: manifestEvent(CAROL.priv, { blob: SHA_1, omit: ["alt"] }),
        status: 400,
        code: "missing_alt",
      },
      {
        name: "overlong title",
        event: manifestEvent(CAROL.priv, { blob: SHA_1, title: "x".repeat(201) }),
        status: 400,
        code: "bad_title",
      },
      {
        name: "blake3 mismatch",
        event: manifestEvent(CAROL.priv, { blob: SHA_1, blake3: "bk-wrong" }),
        status: 400,
        code: "blake3_mismatch",
      },
      {
        name: "content not JSON object",
        event: manifestEvent(CAROL.priv, {
          blob: SHA_1,
          content: "[1,2,3]",
          blake3: blake3ContentTag("[1,2,3]"),
        }),
        status: 400,
        code: "bad_content",
      },
      {
        name: "future created_at",
        event: manifestEvent(CAROL.priv, { blob: SHA_1, created_at: nowSec() + 16 * 60 }),
        status: 400,
        code: "future_created_at",
      },
      {
        name: "nonexistent blob",
        event: manifestEvent(CAROL.priv, { blob: SHA_4 }),
        status: 404,
        code: "blob_not_found",
      },
      {
        name: "not an event",
        event: { hello: "world" },
        status: 400,
        code: "invalid_event",
      },
    ];

    for (const c of cases) {
      const res = await publishManifest(env, c.event as NostrEvent);
      expect(res.status, c.name).toBe(c.status);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error, c.name).toBe(c.code);
    }
    expect(pool.storeCalls).toBe(0);
    expect(pool.events.size).toBe(0);
  });
});

// ── Scenario 4: replaceable supersede ───────────────────────────────────────

describe("scenario 4 — replaceable supersede", () => {
  it("d-tag serves v2, frozen v1 URL keeps serving v1's own metadata, older publish is superseded", async () => {
    const pool = makeFakePool();
    const r2 = makeFakeR2();
    r2.seedBlob(SHA_1, DAVE.pub);
    r2.seedBlob(SHA_2, DAVE.pub);
    const env = makeEnv(pool, r2);
    const t = nowSec();

    const v1 = manifestEvent(DAVE.priv, { d: "dash", blob: SHA_1, title: "v1", created_at: t });
    expect((await publishManifest(env, v1)).status).toBe(200);
    const v2 = manifestEvent(DAVE.priv, { d: "dash", blob: SHA_2, title: "v2", created_at: t + 10 });
    expect((await publishManifest(env, v2)).status).toBe(200);

    const latest = await render(env, `/v0/artifacts/${DAVE.pub}/dash`);
    expect(latest.status).toBe(200);
    const latestMeta = await islandOf(latest);
    expect(latestMeta.sha256).toBe(SHA_2);
    expect(latestMeta.title).toBe("v2");

    // Frozen URL for v1's sha: v1's OWN historical metadata, not v2's.
    const frozen = await render(env, `/v0/artifacts/${SHA_1}`);
    expect(frozen.status).toBe(200);
    const frozenMeta = await islandOf(frozen);
    expect(frozenMeta.sha256).toBe(SHA_1);
    expect(frozenMeta.title).toBe("v1");
    expect(frozenMeta.event_id).toBe(v1.id);
    expect(frozenMeta.mode).toBe("frozen");

    // Publishing with an OLDER created_at reports superseded and changes nothing.
    const stale = manifestEvent(DAVE.priv, {
      d: "dash",
      blob: SHA_1,
      title: "stale",
      created_at: t - 10,
    });
    const staleRes = await publishManifest(env, stale);
    expect(staleRes.status).toBe(200);
    expect(((await staleRes.json()) as Record<string, unknown>).superseded).toBe(true);
    const still = await islandOf(await render(env, `/v0/artifacts/${DAVE.pub}/dash`));
    expect(still.title).toBe("v2");
  });
});

// ── Scenario 5: duplicate blob, single-manifest-wins ────────────────────────

describe("scenario 5 — duplicate blob", () => {
  it("second d manifesting an already-bound blob gets 409; first binding intact; second d-tag URL renders", async () => {
    const pool = makeFakePool();
    const r2 = makeFakeR2();
    r2.seedBlob(SHA_3, ERIN.pub);
    const env = makeEnv(pool, r2);

    expect((await publishManifest(env, manifestEvent(ERIN.priv, { d: "first", blob: SHA_3 }))).status).toBe(200);

    const second = await publishManifest(env, manifestEvent(ERIN.priv, { d: "second", blob: SHA_3 }));
    expect(second.status).toBe(409);
    const body = (await second.json()) as Record<string, unknown>;
    expect(body.error).toBe("blob_already_bound");
    expect(body.latest_url).toBe(`https://api.4a4.ai/v0/artifacts/${ERIN.pub}/second`);

    // Frozen URL still belongs to the first d.
    const frozenMeta = await islandOf(await render(env, `/v0/artifacts/${SHA_3}`));
    expect(frozenMeta.d).toBe("first");
    // The second manifest itself stored fine — its d-tag URL renders.
    const secondRender = await render(env, `/v0/artifacts/${ERIN.pub}/second`);
    expect(secondRender.status).toBe(200);
    expect((await islandOf(secondRender)).d).toBe("second");
  });
});

// ── Scenario 6: kind:5 e-tag revocation ─────────────────────────────────────

describe("scenario 6 — e-tag revocation", () => {
  it("revoking a manifest event id 410s both URL shapes with attribution; unrelated artifacts unaffected; foreign kind:5 skipped", async () => {
    const pool = makeFakePool();
    const r2 = makeFakeR2();
    r2.seedBlob(SHA_1, ALICE.pub);
    r2.seedBlob(SHA_2, ALICE.pub);
    const env = makeEnv(pool, r2);

    const target = manifestEvent(ALICE.priv, { d: "rev-e", blob: SHA_1 });
    const bystander = manifestEvent(ALICE.priv, { d: "keep", blob: SHA_2 });
    expect((await publishManifest(env, target)).status).toBe(200);
    expect((await publishManifest(env, bystander)).status).toBe(200);

    // Foreign kind:5 first: same e-tag, wrong signer → skipped, still 200.
    const foreign = await revoke(env, kind5Event(BOB.priv, [["e", target.id]]));
    expect(foreign.status).toBe(200);
    const foreignBody = (await foreign.json()) as { revoked: unknown[]; skipped: { reason: string }[] };
    expect(foreignBody.revoked).toEqual([]);
    expect(foreignBody.skipped[0]!.reason).toBe("not_owner");
    expect((await render(env, `/v0/artifacts/${SHA_1}`)).status).toBe(200);

    // Owner revocation, with an unknown e-tag alongside → per-tag reporting.
    const res = await revoke(
      env,
      kind5Event(ALICE.priv, [
        ["e", target.id],
        ["e", "09".repeat(32)],
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: string[][]; skipped: { tag: string[]; reason: string }[] };
    expect(body.revoked).toEqual([["e", target.id]]);
    expect(body.skipped).toEqual([{ tag: ["e", "09".repeat(32)], reason: "unknown_manifest" }]);

    for (const path of [`/v0/artifacts/${SHA_1}`, `/v0/artifacts/${ALICE.pub}/rev-e`]) {
      const r = await render(env, path);
      expect(r.status, path).toBe(410);
      expect(r.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
      const html = await r.text();
      expect(html).toContain(ALICE.pub); // attribution
    }
    // Unrelated artifact unaffected.
    expect((await render(env, `/v0/artifacts/${ALICE.pub}/keep`)).status).toBe(200);
    expect((await render(env, `/v0/artifacts/${SHA_2}`)).status).toBe(200);
  });
});

// ── Scenario 7: kind:5 a-tag + republish ────────────────────────────────────

describe("scenario 7 — a-tag revocation and republish", () => {
  it("address revocation 410s; a newer republish un-revokes (NIP-09 time semantics)", async () => {
    const pool = makeFakePool();
    const r2 = makeFakeR2();
    r2.seedBlob(SHA_1, CAROL.pub);
    r2.seedBlob(SHA_2, CAROL.pub);
    const env = makeEnv(pool, r2);
    const t = nowSec();

    const v1 = manifestEvent(CAROL.priv, { d: "rev-a", blob: SHA_1, created_at: t });
    expect((await publishManifest(env, v1)).status).toBe(200);

    const res = await revoke(
      env,
      kind5Event(CAROL.priv, [["a", `30540:${CAROL.pub}:rev-a`]], t + 5),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revoked: string[][] }).revoked).toEqual([
      ["a", `30540:${CAROL.pub}:rev-a`],
    ]);
    expect((await render(env, `/v0/artifacts/${CAROL.pub}/rev-a`)).status).toBe(410);
    expect((await render(env, `/v0/artifacts/${SHA_1}`)).status).toBe(410);

    // Republish with newer created_at supersedes the revocation.
    const v2 = manifestEvent(CAROL.priv, { d: "rev-a", blob: SHA_2, created_at: t + 10 });
    expect((await publishManifest(env, v2)).status).toBe(200);
    const back = await render(env, `/v0/artifacts/${CAROL.pub}/rev-a`);
    expect(back.status).toBe(200);
    expect((await islandOf(back)).sha256).toBe(SHA_2);
  });

  it("a-tag for an unknown address or malformed value is skipped per-tag", async () => {
    const pool = makeFakePool();
    const env = makeEnv(pool, makeFakeR2());
    const res = await revoke(
      env,
      kind5Event(CAROL.priv, [
        ["a", `30540:${CAROL.pub}:never-published`],
        ["a", "not-an-address"],
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: unknown[]; skipped: { reason: string }[] };
    expect(body.revoked).toEqual([]);
    expect(body.skipped.map((s) => s.reason).sort()).toEqual(["malformed_tag", "unknown_manifest"]);
  });
});

// ── Scenario 8: Alice/Bob — addr revocation between v1 and v2 ───────────────

describe("scenario 8 — address revocation between supersedes (Alice/Bob)", () => {
  it("frozen v1 URL is 410, d-tag URL serves v2, frozen v2 URL is 200", async () => {
    const pool = makeFakePool();
    const r2 = makeFakeR2();
    r2.seedBlob(SHA_A, ALICE.pub);
    r2.seedBlob(SHA_B, ALICE.pub);
    const env = makeEnv(pool, r2);

    // v1 at t=100, v2 at t=200, address revocation at t=150.
    const v1 = manifestEvent(ALICE.priv, { d: "dashboard", blob: SHA_A, created_at: 100 });
    expect((await publishManifest(env, v1)).status).toBe(200);
    const v2 = manifestEvent(ALICE.priv, { d: "dashboard", blob: SHA_B, created_at: 200 });
    expect((await publishManifest(env, v2)).status).toBe(200);
    const res = await revoke(
      env,
      kind5Event(ALICE.priv, [["a", `30540:${ALICE.pub}:dashboard`]], 150),
    );
    expect(res.status).toBe(200);

    // Frozen v1: v1.created_at=100 ≤ 150 → 410.
    expect((await render(env, `/v0/artifacts/${SHA_A}`)).status).toBe(410);
    // d-tag: v2.created_at=200 > 150 → 200 with v2.
    const latest = await render(env, `/v0/artifacts/${ALICE.pub}/dashboard`);
    expect(latest.status).toBe(200);
    expect((await islandOf(latest)).sha256).toBe(SHA_B);
    // Frozen v2: also newer than the revocation → 200.
    expect((await render(env, `/v0/artifacts/${SHA_B}`)).status).toBe(200);
  });
});

// ── Render-path 404s ────────────────────────────────────────────────────────

describe("render 404s", () => {
  it("404s unbound hashes, unknown addresses, and deleted blobs — all carrying the CSP", async () => {
    const pool = makeFakePool();
    const r2 = makeFakeR2();
    r2.seedBlob(SHA_1, DAVE.pub);
    const env = makeEnv(pool, r2);

    const unbound = await render(env, `/v0/artifacts/${SHA_4}`);
    expect(unbound.status).toBe(404);
    expect(unbound.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
    expect((await render(env, `/v0/artifacts/${DAVE.pub}/nope`)).status).toBe(404);

    // Blob deleted after publish → 404 on render.
    expect((await publishManifest(env, manifestEvent(DAVE.priv, { d: "gone", blob: SHA_1 }))).status).toBe(200);
    r2.objects.delete(`blob/${SHA_1}`);
    expect((await render(env, `/v0/artifacts/${SHA_1}`)).status).toBe(404);
    expect((await render(env, `/v0/artifacts/${DAVE.pub}/gone`)).status).toBe(404);
  });
});
