// Public Artifacts — storage-layer tests (Task 1 of the public-artifacts plan).
//
// Covers the five new RelayPool DO methods against a real RelayPool instance
// with an in-memory storage stub (the DurableObject base is mocked, the
// @noble crypto is real), plus the Blossom upload no-overwrite hardening
// (plan test-matrix scenario 8).
//
// Plan verification contract:
//   - storeArtifactManifest: supersede newer-wins / reject-older, first-wins
//     `artifactblob:` binding (409 case surfaces as `bound: false`).
//   - storeArtifactRevocation: writes both the e-tag (`artifactrev:`) and
//     a-tag (`artifactrevaddr:`) indexes; latest-created_at wins per address.
//   - getArtifactRevocation: one call returns {revoked, by, at}; the
//     address-level check compares the RENDERING manifest's created_at
//     (NIP-09 — republish after revocation un-revokes the d-tag URL while an
//     older frozen version stays revoked).
//   - blossom upload: re-upload of an existing sha keeps the original
//     uploader_pubkey and does not charge the re-uploader's quota.

import { describe, expect, it } from "vitest";
import { vi } from "vitest";

// relay-pool.ts imports `cloudflare:workers`, which doesn't exist under
// vitest/node. Unlike webhook-receiver.test.ts we instantiate the DO class
// directly, so the stub base must keep the (ctx, env) assignment the real
// DurableObject constructor performs. (Hoisted above the imports below.)
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { signEventWithRawKey } from "../lib/sign";
import {
  RelayPool,
  type ArtifactBlobBinding,
  type NostrEvent,
} from "../relay-pool";
import { handleBlossomRequest, type BlossomEnv } from "../blossom";

// ── Test keys ───────────────────────────────────────────────────────────────

const ALICE_PRIV = hexToBytes(
  "7777777777777777777777777777777777777777777777777777777777777777",
);
const ALICE_PUB = bytesToHex(schnorr.getPublicKey(ALICE_PRIV));

const BOB_PRIV = hexToBytes(
  "8888888888888888888888888888888888888888888888888888888888888888",
);
const BOB_PUB = bytesToHex(schnorr.getPublicKey(BOB_PRIV));

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

// ── DO harness ──────────────────────────────────────────────────────────────

function makeStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get(key: string) {
      return map.get(key);
    },
    async put(key: string, value: unknown) {
      map.set(key, value);
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

function makePool() {
  const storage = makeStorage();
  // The mocked DurableObject base assigns ctx; only ctx.storage is touched
  // by the artifact methods (they never call ensureConnected).
  const pool = new RelayPool({ storage } as never, {} as never);
  return { pool, storage };
}

function signManifest(
  priv: Uint8Array,
  opts: { d: string; blob: string; createdAt: number; title?: string },
): NostrEvent {
  return signEventWithRawKey(
    {
      kind: 30540,
      created_at: opts.createdAt,
      tags: [
        ["d", opts.d],
        ["blob", opts.blob],
        ["type", "text/html"],
        ["title", opts.title ?? "Test artifact"],
        ["alt", `Public artifact: ${opts.title ?? "Test artifact"} (text/html)`],
      ],
      content: "",
    },
    priv,
  ) as NostrEvent;
}

function signRevocation(
  priv: Uint8Array,
  opts: { createdAt: number; eTags?: string[]; aTags?: string[] },
): NostrEvent {
  const tags: string[][] = [];
  for (const id of opts.eTags ?? []) tags.push(["e", id]);
  for (const a of opts.aTags ?? []) tags.push(["a", a]);
  return signEventWithRawKey(
    { kind: 5, created_at: opts.createdAt, tags, content: "revoked" },
    priv,
  ) as NostrEvent;
}

// ── storeArtifactManifest ───────────────────────────────────────────────────

describe("storeArtifactManifest", () => {
  it("stores a valid manifest and writes both indexes", async () => {
    const { pool, storage } = makePool();
    const m = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_A, createdAt: 100 });

    const res = await pool.storeArtifactManifest(m);
    expect(res).toEqual({ ok: true, superseded: false, bound: true });

    const stored = storage.map.get(`event:30540:${ALICE_PUB}:dash`) as NostrEvent;
    expect(stored.id).toBe(m.id);

    const snapshot = storage.map.get(`artifactid:${m.id}`) as NostrEvent;
    expect(snapshot).toEqual(m);

    const binding = storage.map.get(`artifactblob:${SHA_A}`) as ArtifactBlobBinding;
    expect(binding.pubkey).toBe(ALICE_PUB);
    expect(binding.d).toBe("dash");
    expect(binding.eventId).toBe(m.id);
    expect(binding.createdAt).toBe(100);
    expect(typeof binding.boundAtMs).toBe("number");
  });

  it("newer created_at supersedes; older is rejected without overwriting", async () => {
    const { pool, storage } = makePool();
    const v1 = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_A, createdAt: 100 });
    const v2 = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_B, createdAt: 200 });
    const stale = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_B, createdAt: 150 });

    await pool.storeArtifactManifest(v1);
    const up = await pool.storeArtifactManifest(v2);
    expect(up.ok).toBe(true);
    expect(up.superseded).toBe(false);

    const rej = await pool.storeArtifactManifest(stale);
    expect(rej.ok).toBe(true);
    expect(rej.superseded).toBe(true);

    const stored = storage.map.get(`event:30540:${ALICE_PUB}:dash`) as NostrEvent;
    expect(stored.id).toBe(v2.id);
    // The rejected event must leave no trace in the id index.
    expect(storage.map.has(`artifactid:${stale.id}`)).toBe(false);
    // Superseded versions keep their id index (kind:5 e-tags can still target them).
    expect(storage.map.has(`artifactid:${v1.id}`)).toBe(true);
  });

  it("keeps the v1 frozen binding when v2 moves the slug to a different blob", async () => {
    const { pool } = makePool();
    const v1 = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_A, createdAt: 100 });
    const v2 = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_B, createdAt: 200 });
    await pool.storeArtifactManifest(v1);
    await pool.storeArtifactManifest(v2);

    const bindingA = await pool.getArtifactBlobBinding(SHA_A);
    expect(bindingA?.eventId).toBe(v1.id);
    expect(bindingA?.createdAt).toBe(100);
    const bindingB = await pool.getArtifactBlobBinding(SHA_B);
    expect(bindingB?.eventId).toBe(v2.id);
  });

  it("refreshes eventId/createdAt on same-(pubkey,d) republish of the same blob", async () => {
    const { pool } = makePool();
    const v1 = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_A, createdAt: 100 });
    const v2 = signManifest(ALICE_PRIV, {
      d: "dash",
      blob: SHA_A,
      createdAt: 200,
      title: "Retitled",
    });
    await pool.storeArtifactManifest(v1);
    const boundAtMs = (await pool.getArtifactBlobBinding(SHA_A))!.boundAtMs;

    const res = await pool.storeArtifactManifest(v2);
    expect(res.bound).toBe(true);
    const binding = await pool.getArtifactBlobBinding(SHA_A);
    expect(binding?.eventId).toBe(v2.id);
    expect(binding?.createdAt).toBe(200);
    expect(binding?.boundAtMs).toBe(boundAtMs);
  });

  it("first-wins: a second (pubkey, d) claiming a bound blob gets bound=false, manifest still stored", async () => {
    const { pool, storage } = makePool();
    const first = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_A, createdAt: 100 });
    const secondSlug = signManifest(ALICE_PRIV, { d: "copy", blob: SHA_A, createdAt: 110 });
    const otherKey = signManifest(BOB_PRIV, { d: "steal", blob: SHA_A, createdAt: 120 });

    await pool.storeArtifactManifest(first);

    const res2 = await pool.storeArtifactManifest(secondSlug);
    expect(res2).toEqual({ ok: true, superseded: false, bound: false });
    const res3 = await pool.storeArtifactManifest(otherKey);
    expect(res3).toEqual({ ok: true, superseded: false, bound: false });

    // Binding untouched; both later manifests stored at their own addresses.
    const binding = await pool.getArtifactBlobBinding(SHA_A);
    expect(binding?.d).toBe("dash");
    expect(binding?.eventId).toBe(first.id);
    expect(storage.map.has(`event:30540:${ALICE_PUB}:copy`)).toBe(true);
    expect(storage.map.has(`event:30540:${BOB_PUB}:steal`)).toBe(true);
  });

  it("rejects wrong kind, tampered id, bad sig, missing d, malformed blob", async () => {
    const { pool, storage } = makePool();
    const good = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_A, createdAt: 100 });

    const wrongKind = signEventWithRawKey(
      { kind: 30541, created_at: 100, tags: [["d", "x"], ["blob", SHA_A]], content: "" },
      ALICE_PRIV,
    ) as NostrEvent;
    expect((await pool.storeArtifactManifest(wrongKind)).ok).toBe(false);

    const tampered = { ...good, created_at: 999 };
    expect((await pool.storeArtifactManifest(tampered)).reason).toBe("id mismatch");

    const badSig = { ...good, sig: "0".repeat(128) };
    expect((await pool.storeArtifactManifest(badSig)).reason).toBe(
      "signature verification failed",
    );

    const noD = signEventWithRawKey(
      { kind: 30540, created_at: 100, tags: [["blob", SHA_A]], content: "" },
      ALICE_PRIV,
    ) as NostrEvent;
    expect((await pool.storeArtifactManifest(noD)).reason).toBe("missing d tag");

    const badBlob = signEventWithRawKey(
      { kind: 30540, created_at: 100, tags: [["d", "x"], ["blob", "nothex"]], content: "" },
      ALICE_PRIV,
    ) as NostrEvent;
    expect((await pool.storeArtifactManifest(badBlob)).reason).toBe(
      "missing or malformed blob tag",
    );

    expect(storage.map.size).toBe(0);
  });
});

// ── storeArtifactRevocation ─────────────────────────────────────────────────

describe("storeArtifactRevocation", () => {
  it("writes artifactrev per manifest id and artifactrevaddr per address", async () => {
    const { pool, storage } = makePool();
    const rev = signRevocation(ALICE_PRIV, {
      createdAt: 150,
      eTags: ["e1".padEnd(64, "0"), "e2".padEnd(64, "0")],
      aTags: [`30540:${ALICE_PUB}:dash`],
    });

    const res = await pool.storeArtifactRevocation(rev, {
      manifestIds: ["e1".padEnd(64, "0"), "e2".padEnd(64, "0")],
      addresses: [{ pubkey: ALICE_PUB, d: "dash" }],
    });
    expect(res).toEqual({ ok: true });

    expect((storage.map.get(`artifactrev:${"e1".padEnd(64, "0")}`) as NostrEvent).id).toBe(rev.id);
    expect((storage.map.get(`artifactrev:${"e2".padEnd(64, "0")}`) as NostrEvent).id).toBe(rev.id);
    expect(
      (storage.map.get(`artifactrevaddr:${ALICE_PUB}:dash`) as NostrEvent).id,
    ).toBe(rev.id);
  });

  it("keeps the latest-created_at kind:5 per address", async () => {
    const { pool, storage } = makePool();
    const newer = signRevocation(ALICE_PRIV, { createdAt: 200, aTags: [`30540:${ALICE_PUB}:dash`] });
    const older = signRevocation(ALICE_PRIV, { createdAt: 150, aTags: [`30540:${ALICE_PUB}:dash`] });
    const addr = { pubkey: ALICE_PUB, d: "dash" };

    await pool.storeArtifactRevocation(newer, { manifestIds: [], addresses: [addr] });
    await pool.storeArtifactRevocation(older, { manifestIds: [], addresses: [addr] });

    const kept = storage.map.get(`artifactrevaddr:${ALICE_PUB}:dash`) as NostrEvent;
    expect(kept.id).toBe(newer.id);
    expect(kept.created_at).toBe(200);
  });

  it("rejects non-kind-5, tampered, and mis-signed events without writing", async () => {
    const { pool, storage } = makePool();
    const rev = signRevocation(ALICE_PRIV, { createdAt: 150, eTags: ["x".repeat(64)] });
    const resolved = { manifestIds: ["x".repeat(64)], addresses: [] };

    const wrongKind = signEventWithRawKey(
      { kind: 6, created_at: 150, tags: [], content: "" },
      ALICE_PRIV,
    ) as NostrEvent;
    expect((await pool.storeArtifactRevocation(wrongKind, resolved)).ok).toBe(false);

    const tampered = { ...rev, content: "changed" };
    expect((await pool.storeArtifactRevocation(tampered, resolved)).reason).toBe("id mismatch");

    const badSig = { ...rev, sig: "0".repeat(128) };
    expect((await pool.storeArtifactRevocation(badSig, resolved)).reason).toBe(
      "signature verification failed",
    );

    expect(storage.map.size).toBe(0);
  });
});

// ── getArtifactRevocation ───────────────────────────────────────────────────

describe("getArtifactRevocation", () => {
  it("returns {revoked:false} when no revocation exists", async () => {
    const { pool } = makePool();
    const res = await pool.getArtifactRevocation("f".repeat(64), ALICE_PUB, "dash", 100);
    expect(res).toEqual({ revoked: false });
  });

  it("e-tag revocation hits unconditionally with attribution", async () => {
    const { pool } = makePool();
    const m = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_A, createdAt: 100 });
    await pool.storeArtifactManifest(m);
    const rev = signRevocation(ALICE_PRIV, { createdAt: 50, eTags: [m.id] });
    await pool.storeArtifactRevocation(rev, { manifestIds: [m.id], addresses: [] });

    // Version-level revocation has no time semantics — even a kind:5 with an
    // older created_at revokes the exact manifest event it names.
    const res = await pool.getArtifactRevocation(m.id, ALICE_PUB, "dash", 100);
    expect(res).toEqual({ revoked: true, by: ALICE_PUB, at: 50 });
  });

  it("address revocation suppresses manifests with created_at <= revocation, by rendering-manifest time", async () => {
    // The dispatcher-specified splitting case: v1(t=100, blob A) → addr
    // revocation (t=150) → v2(t=200, blob B). The frozen URL for blob A
    // renders v1 and must be 410; the d-tag URL renders v2 and must be 200.
    const { pool } = makePool();
    const v1 = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_A, createdAt: 100 });
    const v2 = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_B, createdAt: 200 });
    await pool.storeArtifactManifest(v1);
    await pool.storeArtifactManifest(v2);
    const rev = signRevocation(ALICE_PRIV, { createdAt: 150, aTags: [`30540:${ALICE_PUB}:dash`] });
    await pool.storeArtifactRevocation(rev, {
      manifestIds: [],
      addresses: [{ pubkey: ALICE_PUB, d: "dash" }],
    });

    // Frozen path: manifestCreatedAt comes from the blob binding (v1).
    const bindingA = await pool.getArtifactBlobBinding(SHA_A);
    const frozen = await pool.getArtifactRevocation(
      bindingA!.eventId,
      ALICE_PUB,
      "dash",
      bindingA!.createdAt,
    );
    expect(frozen).toEqual({ revoked: true, by: ALICE_PUB, at: 150 });

    // d-tag path: v2 postdates the revocation → un-revoked (NIP-09).
    const latest = await pool.getArtifactRevocation(v2.id, ALICE_PUB, "dash", v2.created_at);
    expect(latest).toEqual({ revoked: false });

    // Boundary: created_at equal to the revocation's is still suppressed.
    const boundary = await pool.getArtifactRevocation("f".repeat(64), ALICE_PUB, "dash", 150);
    expect(boundary.revoked).toBe(true);
  });
});

// ── Point-read lookups ──────────────────────────────────────────────────────

describe("getArtifactBlobBinding / getArtifactManifest", () => {
  it("returns null for unknown or malformed keys", async () => {
    const { pool } = makePool();
    expect(await pool.getArtifactBlobBinding(SHA_A)).toBeNull();
    expect(await pool.getArtifactBlobBinding("not-a-sha")).toBeNull();
    expect(await pool.getArtifactManifest("f".repeat(64))).toBeNull();
  });

  it("resolves bindings case-insensitively and manifest snapshots by event id", async () => {
    const { pool } = makePool();
    const m = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_A, createdAt: 100 });
    await pool.storeArtifactManifest(m);

    const binding = await pool.getArtifactBlobBinding(SHA_A.toUpperCase());
    expect(binding?.eventId).toBe(m.id);

    expect(await pool.getArtifactManifest(m.id)).toEqual(m);
  });

  it("keeps superseded manifest snapshots readable for the frozen render path", async () => {
    // The full frozen-URL flow at DO level: sha256(A) → artifactblob binding
    // → eventId=v1.id → getArtifactManifest(v1.id) returns v1 with its
    // original metadata even though v2 replaced it at the address key —
    // and v1's created_at (100) ≤ addr revocation (150) → 410, while the
    // d-tag path renders v2 (200 > 150) → 200.
    const { pool } = makePool();
    const v1 = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_A, createdAt: 100, title: "v1" });
    const v2 = signManifest(ALICE_PRIV, { d: "dash", blob: SHA_B, createdAt: 200, title: "v2" });
    await pool.storeArtifactManifest(v1);
    await pool.storeArtifactManifest(v2);
    const rev = signRevocation(ALICE_PRIV, { createdAt: 150, aTags: [`30540:${ALICE_PUB}:dash`] });
    await pool.storeArtifactRevocation(rev, {
      manifestIds: [],
      addresses: [{ pubkey: ALICE_PUB, d: "dash" }],
    });

    const binding = await pool.getArtifactBlobBinding(SHA_A);
    expect(binding?.eventId).toBe(v1.id);

    const historical = await pool.getArtifactManifest(binding!.eventId);
    expect(historical).toEqual(v1);
    expect(historical!.tags).toContainEqual(["title", "v1"]);

    const frozenCheck = await pool.getArtifactRevocation(
      historical!.id,
      historical!.pubkey,
      "dash",
      historical!.created_at,
    );
    expect(frozenCheck).toEqual({ revoked: true, by: ALICE_PUB, at: 150 });

    const latestCheck = await pool.getArtifactRevocation(v2.id, ALICE_PUB, "dash", v2.created_at);
    expect(latestCheck).toEqual({ revoked: false });
  });
});

// ── Blossom upload no-overwrite hardening (plan scenario 8) ─────────────────

interface StoredObject {
  body: Uint8Array;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}

// Mirrors blossom.test.ts's makeR2Stub (incl. the head() this hardening
// introduced there); duplicated because test files in this suite don't share
// helpers.
function makeR2Stub(): R2Bucket {
  const store = new Map<string, StoredObject>();
  const bucket = {
    async put(
      key: string,
      value: Uint8Array | string,
      opts?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
    ) {
      const body = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      store.set(key, { body, customMetadata: opts?.customMetadata, httpMetadata: opts?.httpMetadata });
      return { key, size: body.byteLength };
    },
    async get(key: string) {
      const r = store.get(key);
      if (!r) return null;
      return {
        size: r.body.byteLength,
        body: new Blob([new Uint8Array(r.body)]).stream(),
        customMetadata: r.customMetadata,
        httpMetadata: r.httpMetadata,
        async text() {
          return new TextDecoder().decode(r.body);
        },
      };
    },
    async head(key: string) {
      const r = store.get(key);
      if (!r) return null;
      return { size: r.body.byteLength, customMetadata: r.customMetadata, httpMetadata: r.httpMetadata };
    },
    __store: store,
  } as unknown as R2Bucket;
  return bucket;
}

function buildUploadAuthHeader(priv: Uint8Array, sha: string): string {
  const now = Math.floor(Date.now() / 1000);
  const signed = signEventWithRawKey(
    {
      kind: 24242,
      created_at: now,
      tags: [
        ["t", "upload"],
        ["x", sha],
        ["expiration", String(now + 600)],
      ],
      content: "Upload",
    },
    priv,
  );
  return `Nostr ${btoa(JSON.stringify(signed))}`;
}

function uploadRequest(body: Uint8Array, authHeader: string): Request {
  return new Request("https://api.4a4.ai/blossom/upload", {
    method: "PUT",
    headers: { "Content-Type": "text/html", Authorization: authHeader },
    body,
  });
}

describe("Blossom upload no-overwrite hardening", () => {
  it("re-upload of an existing sha keeps the original uploader and charges no quota", async () => {
    const env: BlossomEnv = { STORAGE: makeR2Stub() };
    const store = (env.STORAGE as unknown as { __store: Map<string, StoredObject> }).__store;
    const body = new TextEncoder().encode("<html>artifact ciphertext stand-in</html>");
    const sha = bytesToHex(sha256(body));

    const first = await handleBlossomRequest(uploadRequest(body, buildUploadAuthHeader(ALICE_PRIV, sha)), env);
    expect(first.status).toBe(200);
    expect(store.get(`blob/${sha}`)!.customMetadata?.uploader_pubkey).toBe(ALICE_PUB);
    const aliceQuota = JSON.parse(new TextDecoder().decode(store.get(`quota/${ALICE_PUB}`)!.body)) as {
      bytes_used: number;
    };
    expect(aliceQuota.bytes_used).toBe(body.byteLength);

    // Bob re-uploads the identical (publicly fetchable) bytes.
    const second = await handleBlossomRequest(uploadRequest(body, buildUploadAuthHeader(BOB_PRIV, sha)), env);
    expect(second.status).toBe(200);
    const payload = (await second.json()) as { sha256: string; size: number; type: string };
    expect(payload.sha256).toBe(sha);
    expect(payload.size).toBe(body.byteLength);
    expect(payload.type).toBe("text/html");

    // First-upload-wins: attribution intact, Bob's quota never created,
    // Alice's quota not double-charged.
    expect(store.get(`blob/${sha}`)!.customMetadata?.uploader_pubkey).toBe(ALICE_PUB);
    expect(store.get(`quota/${BOB_PUB}`)).toBeUndefined();
    const aliceQuotaAfter = JSON.parse(
      new TextDecoder().decode(store.get(`quota/${ALICE_PUB}`)!.body),
    ) as { bytes_used: number };
    expect(aliceQuotaAfter.bytes_used).toBe(body.byteLength);
  });

  it("fresh shas still store normally with uploader attribution", async () => {
    const env: BlossomEnv = { STORAGE: makeR2Stub() };
    const store = (env.STORAGE as unknown as { __store: Map<string, StoredObject> }).__store;
    const body = randomBytes(64);
    const sha = bytesToHex(sha256(body));

    const res = await handleBlossomRequest(uploadRequest(body, buildUploadAuthHeader(BOB_PRIV, sha)), env);
    expect(res.status).toBe(200);
    expect(store.get(`blob/${sha}`)!.customMetadata?.uploader_pubkey).toBe(BOB_PUB);
  });
});
