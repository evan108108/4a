import { describe, expect, it } from "vitest";
import { validateNostrJson, handleWellKnownNostrJson } from "../well-known";

describe("validateNostrJson (SPEC-v0.5 §7.4 invariants)", () => {
  it("accepts a minimal valid response", () => {
    const r = validateNostrJson({ names: {} });
    expect(r.ok).toBe(true);
  });

  it("accepts the full shape with fa extension", () => {
    const PUB = "a".repeat(64);
    const body = {
      names: { evan: PUB },
      relays: { [PUB]: ["wss://relay.damus.io"] },
      fa: {
        [PUB]: {
          audiences: ["team-design", "evan-and-allison"],
          context: "https://4a4.ai/ns/v0",
        },
      },
    };
    const r = validateNostrJson(body);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fa![PUB]!.audiences).toEqual(["team-design", "evan-and-allison"]);
    }
  });

  it("rejects a fa entry whose pubkey is not in names", () => {
    const r = validateNostrJson({
      names: { evan: "a".repeat(64) },
      fa: {
        ["b".repeat(64)]: { audiences: ["x"], context: "https://4a4.ai/ns/v0" },
      },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a fa.context other than the v0 URL", () => {
    const PUB = "a".repeat(64);
    const r = validateNostrJson({
      names: { evan: PUB },
      fa: { [PUB]: { audiences: ["x"], context: "https://example.com/wrong" } },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed audience slug", () => {
    const PUB = "a".repeat(64);
    const r = validateNostrJson({
      names: { evan: PUB },
      fa: { [PUB]: { audiences: ["has spaces"], context: "https://4a4.ai/ns/v0" } },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects names whose value is not 32-byte hex", () => {
    const r = validateNostrJson({ names: { evan: "abcd" } });
    expect(r.ok).toBe(false);
  });
});

describe("handleWellKnownNostrJson", () => {
  const PUB = "a".repeat(64);
  const env = {
    NOSTR_DIRECTORY_JSON: JSON.stringify({
      names: { evan: PUB, allison: "b".repeat(64) },
      relays: { [PUB]: ["wss://relay.damus.io"] },
      fa: { [PUB]: { audiences: ["team-design"], context: "https://4a4.ai/ns/v0" } },
    }),
  };

  it("serves the full directory on GET /", async () => {
    const r = handleWellKnownNostrJson(
      new Request("https://4a4.ai/.well-known/nostr.json"),
      env,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { names?: Record<string, string>; relays?: Record<string, string[]>; fa?: Record<string, { audiences: string[]; context: string }> };
    expect(Object.keys(body.names ?? {})).toContain("evan");
  });

  it("filters to a single name on ?name=", async () => {
    const r = handleWellKnownNostrJson(
      new Request("https://4a4.ai/.well-known/nostr.json?name=evan"),
      env,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { names?: Record<string, string>; relays?: Record<string, string[]>; fa?: Record<string, { audiences: string[]; context: string }> };
    expect(body.names).toEqual({ evan: PUB });
    expect(body.fa).toEqual({ [PUB]: { audiences: ["team-design"], context: "https://4a4.ai/ns/v0" } });
    expect(body.relays).toEqual({ [PUB]: ["wss://relay.damus.io"] });
  });

  it("returns empty when name is unknown", async () => {
    const r = handleWellKnownNostrJson(
      new Request("https://4a4.ai/.well-known/nostr.json?name=ghost"),
      env,
    );
    const body = (await r.json()) as { names?: Record<string, string>; relays?: Record<string, string[]>; fa?: Record<string, { audiences: string[]; context: string }> };
    expect(body.names).toEqual({});
  });

  it("falls back to empty directory when env override is missing", async () => {
    const r = handleWellKnownNostrJson(
      new Request("https://4a4.ai/.well-known/nostr.json"),
      {},
    );
    const body = (await r.json()) as { names?: Record<string, string>; relays?: Record<string, string[]>; fa?: Record<string, { audiences: string[]; context: string }> };
    expect(body.names).toEqual({});
  });
});
