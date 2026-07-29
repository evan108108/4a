// Unit tests for the org / key-grant builders behind
// POST /v0/publish/{org,grant,grant_revoke} (Evenflow phase 16).

import { describe, expect, it } from "vitest";
import {
  KIND_GRANT,
  KIND_ORG,
  buildGrant,
  buildGrantRevoke,
  buildOrg,
} from "../org-builder";

const tag = (tags: string[][], name: string): string | undefined =>
  tags.find((t) => t[0] === name)?.[1];

const HEX = "a".repeat(64);

describe("buildOrg", () => {
  it("builds a kind-30520 org declaration: spec tags + JSON content, addressable on slug", () => {
    const built = buildOrg({
      slug: "acme",
      display_name: "Acme Industries",
      kind: "team",
      avatar_url: "https://cdn.example/acme.png",
      bio: "We make anvils.",
      admins: [HEX],
    });
    expect(built.template.kind).toBe(KIND_ORG);
    expect(built.addressable).toBe(true);
    expect(built.dTag).toBe("acme");
    expect(tag(built.template.tags, "d")).toBe("acme");
    expect(tag(built.template.tags, "type")).toBe("org");
    expect(tag(built.template.tags, "slug")).toBe("acme");
    expect(tag(built.template.tags, "kind")).toBe("team");
    expect(tag(built.template.tags, "name")).toBe("Acme Industries");
    expect(JSON.parse(built.template.content)).toEqual({
      avatar_url: "https://cdn.example/acme.png",
      bio: "We make anvils.",
      admins: [HEX],
    });
  });

  it("accepts a minimal personal org and defaults admins to []", () => {
    const built = buildOrg({ slug: "evan108108", display_name: "Evan", kind: "personal" });
    expect(tag(built.template.tags, "kind")).toBe("personal");
    expect(JSON.parse(built.template.content)).toEqual({ admins: [] });
  });

  it("rejects bad slugs, unknown kinds, and non-https avatars", () => {
    expect(() => buildOrg({ slug: "Bad Slug", display_name: "x", kind: "team" })).toThrow(/slug/);
    expect(() => buildOrg({ slug: "-lead", display_name: "x", kind: "team" })).toThrow(/slug/);
    expect(() => buildOrg({ slug: "ok", display_name: "x", kind: "empire" })).toThrow(/kind/);
    expect(() =>
      buildOrg({ slug: "ok", display_name: "x", kind: "team", avatar_url: "http://x/a.png" }),
    ).toThrow(/https/);
  });

  it("rejects over-cap fields instead of truncating", () => {
    expect(() =>
      buildOrg({ slug: "s".repeat(65), display_name: "x", kind: "team" }),
    ).toThrow(/exceeds 64/);
    expect(() =>
      buildOrg({ slug: "ok", display_name: "x".repeat(129), kind: "team" }),
    ).toThrow(/exceeds 128/);
    expect(() =>
      buildOrg({ slug: "ok", display_name: "x", kind: "team", bio: "b".repeat(4001) }),
    ).toThrow(/exceeds 4000/);
  });

  it("validates every admins entry as pubkey or composite", () => {
    expect(() =>
      buildOrg({ slug: "ok", display_name: "x", kind: "team", admins: ["not a key"] }),
    ).toThrow(/admins\[0\]/);
    const built = buildOrg({
      slug: "ok",
      display_name: "x",
      kind: "team",
      admins: [HEX, "google:12345"],
    });
    expect(JSON.parse(built.template.content).admins).toEqual([HEX, "google:12345"]);
  });
});

describe("buildGrant", () => {
  it("builds a kind-30521 grant with p/role/scope/target tags, replaceable on (target, recipient)", () => {
    const built = buildGrant({
      recipient: HEX,
      role: "contributor",
      scope: "board",
      target: "acme/roadmap",
    });
    expect(built.template.kind).toBe(KIND_GRANT);
    expect(built.addressable).toBe(true);
    expect(built.dTag).toBe(`acme/roadmap/${HEX}`);
    expect(tag(built.template.tags, "p")).toBe(HEX);
    expect(tag(built.template.tags, "role")).toBe("contributor");
    expect(tag(built.template.tags, "scope")).toBe("board");
    expect(tag(built.template.tags, "target")).toBe("acme/roadmap");
  });

  it("accepts composite recipients that have never signed in (grants front-run sign-in)", () => {
    const built = buildGrant({
      recipient: "google:999",
      role: "member",
      scope: "org",
      target: "acme",
    });
    // Composites can't ride a `p` tag — relays enforce hex64 there.
    expect(tag(built.template.tags, "p")).toBeUndefined();
    expect(tag(built.template.tags, "fa:recipient")).toBe("google:999");
  });

  it("enforces target shape per scope: org = one segment, board = two", () => {
    expect(() =>
      buildGrant({ recipient: HEX, role: "member", scope: "org", target: "acme/roadmap" }),
    ).toThrow(/scope=org/);
    expect(() =>
      buildGrant({ recipient: HEX, role: "viewer", scope: "board", target: "acme" }),
    ).toThrow(/scope=board/);
  });

  it("rejects unknown roles and scopes", () => {
    expect(() =>
      buildGrant({ recipient: HEX, role: "emperor", scope: "org", target: "acme" }),
    ).toThrow(/role/);
    expect(() =>
      buildGrant({ recipient: HEX, role: "member", scope: "galaxy", target: "acme" }),
    ).toThrow(/scope/);
  });
});

describe("buildGrantRevoke", () => {
  it("builds a kind-30521 revocation with revokes + e tags on the grant id", () => {
    const built = buildGrantRevoke({ grant_event_id: HEX });
    expect(built.template.kind).toBe(KIND_GRANT);
    expect(tag(built.template.tags, "revokes")).toBe(HEX);
    expect(tag(built.template.tags, "e")).toBe(HEX);
    expect(built.dTag).toBe(`revoke/${HEX}`);
  });

  it("rejects non-hex64 grant ids", () => {
    expect(() => buildGrantRevoke({ grant_event_id: "abc" })).toThrow(/hex/);
    expect(() => buildGrantRevoke({})).toThrow(/grant_event_id/);
  });
});
