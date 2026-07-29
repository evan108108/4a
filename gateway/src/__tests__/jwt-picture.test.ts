// The optional `picture` JWT claim (OAuth-provider avatar URL) — minted
// only when claims-safe (https, bounded), stripped on verify otherwise.

import { describe, expect, it } from "vitest";
import { mintJwt, verifyJwt, type AuthEnv } from "../auth";
// Base64url helpers — kept runtime-agnostic (no node Buffer types in this workers-typed project).
const fromB64url = (s: string): string => atob(s.replaceAll("-", "+").replaceAll("_", "/"));
const toB64url = (s: string | Uint8Array): string => {
  const bin = typeof s === "string" ? s : String.fromCharCode(...s);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const env: AuthEnv = { JWT_SIGNING_KEY: "test-signing-secret" };
const BASE = { provider: "github", oauth_id: "42", login: "octocat" };

describe("picture claim", () => {
  it("round-trips a valid https picture URL", async () => {
    const token = await mintJwt(
      { ...BASE, picture: "https://avatars.githubusercontent.com/u/42?v=4" },
      env,
    );
    const claims = await verifyJwt(token, env);
    expect(claims?.picture).toBe("https://avatars.githubusercontent.com/u/42?v=4");
  });

  it("omits the claim entirely when no picture is supplied", async () => {
    const token = await mintJwt(BASE, env);
    const claims = await verifyJwt(token, env);
    expect(claims).not.toBeNull();
    expect("picture" in claims!).toBe(false);
  });

  it("drops non-https URLs at mint time", async () => {
    const token = await mintJwt({ ...BASE, picture: "http://insecure.example/pic.png" }, env);
    const claims = await verifyJwt(token, env);
    expect(claims?.picture).toBeUndefined();
  });

  it("drops over-long URLs at mint time", async () => {
    const token = await mintJwt({ ...BASE, picture: `https://x.example/${"a".repeat(600)}` }, env);
    const claims = await verifyJwt(token, env);
    expect(claims?.picture).toBeUndefined();
  });

  it("verify strips a malformed picture claim from a foreign-minted token", async () => {
    // Hand-assemble a token whose payload carries a non-https picture (as if
    // minted by an older/other implementation) but a valid signature.
    const good = await mintJwt(BASE, env);
    const [h, p, _s] = good.split(".");
    const payload = JSON.parse(fromB64url(p!));
    payload.picture = "javascript:alert(1)";
    const forgedPayload = toB64url(JSON.stringify(payload));
    // Re-sign properly via WebCrypto with the same secret.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-signing-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${forgedPayload}`)),
    );
    const sigB64 = toB64url(sig);
    const claims = await verifyJwt(`${h}.${forgedPayload}.${sigB64}`, env);
    expect(claims).not.toBeNull();
    expect(claims?.picture).toBeUndefined();
  });
});
