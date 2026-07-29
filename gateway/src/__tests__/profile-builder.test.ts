// Unit tests for buildProfile — the kind-0 (NIP-01 user metadata) builder
// behind POST /v0/publish/profile. The privacy posture matters most here:
// server-known JWT fields (login = the user's email) must never reach the
// event content unless the user typed them into a profile field themselves.

import { describe, expect, it } from "vitest";
import { buildProfile } from "../profile-builder";

describe("buildProfile", () => {
  it("builds a standard kind 0: metadata JSON content, no tags, not addressable", () => {
    const built = buildProfile({
      name: "evan108108",
      display_name: "Evan",
      picture: "https://cdn.example/e.png",
      about: "building things",
    });
    expect(built.template.kind).toBe(0);
    expect(built.template.tags).toEqual([]);
    expect(built.addressable).toBe(false);
    expect(built.dTag).toBe("");
    expect(JSON.parse(built.template.content)).toEqual({
      name: "evan108108",
      display_name: "Evan",
      picture: "https://cdn.example/e.png",
      about: "building things",
    });
  });

  it("omits absent fields and allows an all-empty profile (clear)", () => {
    expect(JSON.parse(buildProfile({}).template.content)).toEqual({});
    expect(JSON.parse(buildProfile({ display_name: "E" }).template.content)).toEqual({
      display_name: "E",
    });
  });

  it("ignores unknown fields — login from JWT claims can never leak through", () => {
    const built = buildProfile({
      display_name: "Evan",
      login: "evan108108@gmail.com",
      pubkey: "attacker-controlled",
    } as never);
    expect(JSON.parse(built.template.content)).toEqual({ display_name: "Evan" });
  });

  it("rejects over-cap fields instead of truncating", () => {
    expect(() => buildProfile({ name: "x".repeat(65) })).toThrow(/name exceeds 64/);
    expect(() => buildProfile({ display_name: "x".repeat(129) })).toThrow(/display_name exceeds 128/);
    expect(() => buildProfile({ picture: `https://x/${"p".repeat(512)}` })).toThrow(/picture exceeds 512/);
    expect(() => buildProfile({ about: "x".repeat(4001) })).toThrow(/about exceeds 4000/);
  });

  it("rejects non-https picture URLs", () => {
    expect(() => buildProfile({ picture: "http://x/p.png" })).toThrow(/https/);
    expect(() => buildProfile({ picture: "javascript:alert(1)" })).toThrow(/https/);
    expect(() => buildProfile({ picture: "data:image/png;base64,AAAA" })).toThrow(/https/);
  });

  it("rejects non-string fields", () => {
    expect(() => buildProfile({ name: 42 as never })).toThrow(/name must be a string/);
  });
});
