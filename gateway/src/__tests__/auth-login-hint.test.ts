// /auth/{provider}/start — optional login_hint forwarding (Google only).

import { describe, expect, it } from "vitest";
import { handleAuthRequest, parseLoginHint, type AuthEnv } from "../auth";

const env = {
  JWT_SIGNING_KEY: "test-signing-secret",
  GOOGLE_OAUTH_CLIENT_ID: "google-client",
  GITHUB_OAUTH_CLIENT_ID: "github-client",
} as AuthEnv;

async function start(provider: "google" | "github", query: string): Promise<URL> {
  const res = await handleAuthRequest(
    new Request(`https://api.4a4.ai/auth/${provider}/start?${query}`),
    env,
  );
  expect(res.status).toBe(302);
  return new URL(res.headers.get("Location")!);
}

describe("login_hint on /auth/google/start", () => {
  it("forwards a valid email to Google's authorize URL", async () => {
    const loc = await start("google", `login_hint=${encodeURIComponent("archer.dad+hs@gmail.com")}`);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("login_hint")).toBe("archer.dad+hs@gmail.com");
    // the rest of the request is unchanged
    expect(loc.searchParams.get("client_id")).toBe("google-client");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("state")).toBeTruthy();
  });

  it("trims surrounding whitespace", async () => {
    const loc = await start("google", `login_hint=${encodeURIComponent("  a@b.co  ")}`);
    expect(loc.searchParams.get("login_hint")).toBe("a@b.co");
  });

  for (const [what, value] of [
    ["not an email", "archer"],
    ["no TLD", "a@b"],
    ["contains a space", "a b@c.com"],
    ["angle-bracketed", "<a@b.com>"],
    ["two addresses", "a@b.com,c@d.com"],
    ["over 254 chars", `${"a".repeat(250)}@b.com`],
    ["empty", ""],
  ] as const) {
    it(`drops an invalid hint (${what}) but still redirects`, async () => {
      const loc = await start("google", `login_hint=${encodeURIComponent(value)}`);
      expect(loc.searchParams.has("login_hint")).toBe(false);
      expect(loc.searchParams.get("client_id")).toBe("google-client");
    });
  }

  it("never forwards prompt", async () => {
    const loc = await start("google", "login_hint=a%40b.co&prompt=consent");
    expect(loc.searchParams.has("prompt")).toBe(false);
  });

  it("omits login_hint when none is supplied (unchanged behaviour)", async () => {
    const loc = await start("google", "");
    expect(loc.searchParams.has("login_hint")).toBe(false);
  });

  it("ignores login_hint for GitHub", async () => {
    const loc = await start("github", "login_hint=a%40b.co");
    expect(loc.origin).toBe("https://github.com");
    expect(loc.searchParams.has("login_hint")).toBe(false);
    expect(loc.searchParams.has("login")).toBe(false);
  });
});

describe("parseLoginHint", () => {
  it("accepts plain and plus-addressed emails, rejects null", () => {
    expect(parseLoginHint("x@y.org")).toBe("x@y.org");
    expect(parseLoginHint("first.last+tag@sub.example.com")).toBe("first.last+tag@sub.example.com");
    expect(parseLoginHint(null)).toBeUndefined();
  });
});
