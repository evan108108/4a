// Unit tests for the closed-room guard (audience-closed-guard.ts).
//
// The guard is the gateway-side enforcement of the "closed room" state per
// sonata-studio-room-lifecycle.md §5: kind:30520 with ["fa:status","closed"]
// freezes the audience to mutating operations.

import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

import { buildAudienceDeclaration } from "../lib/audience-events";
import { signEventWithRawKey } from "../lib/sign";
import {
  loadAudienceStatus,
  readAudienceStatus,
  rejectIfClosed,
  type AudienceRawEnvLike,
} from "../audience-closed-guard";
import type { NostrEvent } from "../relay-pool";
import type { SignedEvent } from "../kms";

function makeKeypair(): { priv: Uint8Array; pub: string } {
  const priv = randomBytes(32);
  const pub = bytesToHex(schnorr.getPublicKey(priv));
  return { priv, pub };
}

interface StubDO {
  events: Map<string, NostrEvent>;
  getObject(kind: number, pubkey: string, d: string): Promise<NostrEvent | null>;
  storeAudienceEvent(event: NostrEvent): Promise<{ ok: boolean }>;
}

function makeStubEnv(): { env: AudienceRawEnvLike; stub: StubDO } {
  const stub: StubDO = {
    events: new Map(),
    async getObject(kind, pubkey, d) {
      return stub.events.get(`${kind}:${pubkey.toLowerCase()}:${d}`) ?? null;
    },
    async storeAudienceEvent(event) {
      const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
      stub.events.set(`${event.kind}:${event.pubkey.toLowerCase()}:${dTag}`, event);
      return { ok: true };
    },
  };
  const namespace = {
    idFromName: (_: string) => ({ name: "main" }),
    get: (_id: unknown) => stub,
  } as unknown as DurableObjectNamespace;
  const env = { RELAY_POOL: namespace } as unknown as AudienceRawEnvLike;
  return { env, stub };
}

/** Sign an active or closed declaration for the room and return the event. */
function signDeclaration(
  slug: string,
  status: "active" | "closed",
  audId: { priv: Uint8Array; pub: string },
  founderPub: string,
): SignedEvent {
  const epoch = makeKeypair();
  const tpl = buildAudienceDeclaration({
    audIdPub: audId.pub,
    slug,
    name: slug,
    epoch: 1,
    epochPub: epoch.pub,
    members: [founderPub],
  });
  if (status === "closed") {
    tpl.tags.push(["fa:status", "closed"]);
    tpl.tags.push(["fa:closed-at", String(Math.floor(Date.now() / 1000))]);
  }
  return signEventWithRawKey(tpl, audId.priv);
}

describe("readAudienceStatus", () => {
  it("returns active when no fa:status tag is present (back-compat)", () => {
    const founder = makeKeypair();
    const audId = makeKeypair();
    const decl = signDeclaration("room-a", "active", audId, founder.pub);
    const out = readAudienceStatus(decl);
    expect(out.status).toBe("active");
    expect(out.closedAt).toBeUndefined();
  });

  it("returns closed + closedAt when the tags carry them", () => {
    const founder = makeKeypair();
    const audId = makeKeypair();
    const decl = signDeclaration("room-b", "closed", audId, founder.pub);
    const out = readAudienceStatus(decl);
    expect(out.status).toBe("closed");
    expect(out.closedAt).toBeGreaterThan(0);
  });

  it("treats unknown fa:status values as active (permissive default)", () => {
    const founder = makeKeypair();
    const audId = makeKeypair();
    const decl = signDeclaration("room-c", "active", audId, founder.pub);
    decl.tags = [...decl.tags, ["fa:status", "frozen"]];
    const out = readAudienceStatus(decl);
    expect(out.status).toBe("active");
  });
});

describe("loadAudienceStatus", () => {
  it("returns null when the audience has never been declared", async () => {
    const { env } = makeStubEnv();
    const audId = makeKeypair();
    const out = await loadAudienceStatus(audId.pub, "missing", env);
    expect(out).toBeNull();
  });

  it("returns a snapshot reflecting the cached declaration's status", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const audId = makeKeypair();
    const decl = signDeclaration("room-d", "closed", audId, founder.pub);
    await stub.storeAudienceEvent(decl);
    const out = await loadAudienceStatus(audId.pub, "room-d", env);
    expect(out).not.toBeNull();
    expect(out!.status).toBe("closed");
    expect(out!.declaration.slug).toBe("room-d");
    expect(out!.event.id).toBe(decl.id);
    expect(out!.closedAt).toBeGreaterThan(0);
  });

  it("returns null when the cached declaration fails parse (corrupt cache)", async () => {
    const { env, stub } = makeStubEnv();
    const audId = makeKeypair();
    // Plant a malformed kind:30520 directly.
    const corrupt: NostrEvent = {
      id: "0".repeat(64),
      pubkey: audId.pub,
      created_at: Math.floor(Date.now() / 1000),
      kind: 30520,
      tags: [["d", "broken"]],
      content: "not-json",
      sig: "0".repeat(128),
    };
    stub.events.set(`30520:${audId.pub.toLowerCase()}:broken`, corrupt);
    const out = await loadAudienceStatus(audId.pub, "broken", env);
    expect(out).toBeNull();
  });
});

describe("rejectIfClosed", () => {
  it("passes (returns null) when snapshot is null", () => {
    expect(rejectIfClosed(null, "grant")).toBeNull();
  });

  it("passes when the snapshot status is active", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const audId = makeKeypair();
    const decl = signDeclaration("room-act", "active", audId, founder.pub);
    await stub.storeAudienceEvent(decl);
    const snap = await loadAudienceStatus(audId.pub, "room-act", env);
    expect(rejectIfClosed(snap, "grant")).toBeNull();
  });

  it("returns a 403 closed_room Response when status is closed", async () => {
    const { env, stub } = makeStubEnv();
    const founder = makeKeypair();
    const audId = makeKeypair();
    const decl = signDeclaration("room-closed", "closed", audId, founder.pub);
    await stub.storeAudienceEvent(decl);
    const snap = await loadAudienceStatus(audId.pub, "room-closed", env);
    const res = rejectIfClosed(snap, "publish-wraps");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as {
      error: string;
      operation: string;
      closed_at?: number;
    };
    expect(body.error).toBe("closed_room");
    expect(body.operation).toBe("publish-wraps");
    expect(body.closed_at).toBeGreaterThan(0);
  });
});
