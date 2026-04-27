// 4A OAuth + JWT module — Phase 2 custodial publishing path.
//
// Exports:
//   - handleAuthRequest(request, env): dispatches /auth/* on api.4a4.ai
//   - mintJwt(claims, env):  HS256 JWT signed with env.JWT_SIGNING_KEY
//   - verifyJwt(token, env): returns AuthClaims or null (rejects expired,
//                            malformed payloads, wrong alg, bad sig)
//
// Provider in v0: GitHub only. The OAuth state parameter is a one-shot HMAC
// over (random nonce + expiry) — no KV, no cookie. The callback verifies the
// signature and expiry before exchanging the code for a token.

export interface AuthClaims {
  provider: string;
  oauth_id: string;
  login: string;
  iat: number;
  exp: number;
}

export interface AuthEnv {
  JWT_SIGNING_KEY?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
}

const JWT_TTL_SECONDS = 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const CALLBACK_URL = "https://api.4a4.ai/auth/github/callback";
const SCOPE = "read:user";
const PROVIDER = "github";

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlString(s: string): string {
  return b64urlBytes(enc.encode(s));
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacSign(key: CryptoKey, msg: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

async function hmacVerify(key: CryptoKey, msg: string, sig: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(msg));
}

function getSigningSecret(env: AuthEnv): string {
  const s = env.JWT_SIGNING_KEY;
  if (!s) throw new Error("JWT_SIGNING_KEY is not configured");
  return s;
}

export async function mintJwt(
  claims: Pick<AuthClaims, "provider" | "oauth_id" | "login"> & { iat?: number; exp?: number },
  env: AuthEnv,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full: AuthClaims = {
    provider: claims.provider,
    oauth_id: claims.oauth_id,
    login: claims.login,
    iat: claims.iat ?? now,
    exp: claims.exp ?? now + JWT_TTL_SECONDS,
  };
  const header = b64urlString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlString(JSON.stringify(full));
  const input = `${header}.${payload}`;
  const key = await importHmacKey(getSigningSecret(env));
  const sig = await hmacSign(key, input);
  return `${input}.${b64urlBytes(sig)}`;
}

export async function verifyJwt(token: string, env: AuthEnv): Promise<AuthClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const sigB64 = parts[2]!;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(dec.decode(b64urlDecode(headerB64))) as { alg?: string; typ?: string };
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  let sig: Uint8Array;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  const key = await importHmacKey(getSigningSecret(env));
  if (!(await hmacVerify(key, `${headerB64}.${payloadB64}`, sig))) return null;

  let claims: AuthClaims;
  try {
    claims = JSON.parse(dec.decode(b64urlDecode(payloadB64))) as AuthClaims;
  } catch {
    return null;
  }
  if (
    typeof claims.provider !== "string" ||
    typeof claims.oauth_id !== "string" ||
    typeof claims.login !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) return null;
  if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
  return claims;
}

async function mintState(env: AuthEnv): Promise<string> {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = b64urlBytes(nonceBytes);
  const expiry = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
  const key = await importHmacKey(getSigningSecret(env));
  const sig = await hmacSign(key, `${nonce}.${expiry}`);
  return `${nonce}.${expiry}.${b64urlBytes(sig)}`;
}

async function verifyState(state: string, env: AuthEnv): Promise<boolean> {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const nonce = parts[0]!;
  const expiryStr = parts[1]!;
  const sigB64 = parts[2]!;
  const expiry = Number(expiryStr);
  if (!Number.isInteger(expiry)) return false;
  if (expiry <= Math.floor(Date.now() / 1000)) return false;
  let sig: Uint8Array;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return false;
  }
  const key = await importHmacKey(getSigningSecret(env));
  return hmacVerify(key, `${nonce}.${expiry}`, sig);
}

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function handleAuthRequest(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/auth/github/start" && method === "GET") return startGithub(env);
  if (path === "/auth/github/callback" && method === "GET") return callbackGithub(url, env);
  if (path === "/auth/exchange" && method === "POST") {
    return jsonError(
      "not_implemented",
      "/auth/exchange is reserved for short-lived delegations and not implemented in v0",
      501,
    );
  }
  return jsonError("not_found", `unknown auth path: ${path}`, 404);
}

async function startGithub(env: AuthEnv): Promise<Response> {
  if (!env.GITHUB_OAUTH_CLIENT_ID) {
    return jsonError("misconfigured", "GITHUB_OAUTH_CLIENT_ID is not configured", 500);
  }
  if (!env.JWT_SIGNING_KEY) {
    return jsonError("misconfigured", "JWT_SIGNING_KEY is not configured", 500);
  }
  const state = await mintState(env);
  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    scope: SCOPE,
    state,
    allow_signup: "true",
  });
  return Response.redirect(`${GITHUB_AUTHORIZE_URL}?${params.toString()}`, 302);
}

async function callbackGithub(url: URL, env: AuthEnv): Promise<Response> {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
    return jsonError("misconfigured", "GitHub OAuth secrets are not configured", 500);
  }
  if (!env.JWT_SIGNING_KEY) {
    return jsonError("misconfigured", "JWT_SIGNING_KEY is not configured", 500);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return jsonError("bad_request", "missing code or state", 400);
  if (!(await verifyState(state, env))) {
    return jsonError("bad_request", "invalid or expired state", 400);
  }

  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "4a-gateway",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: CALLBACK_URL,
    }),
  });
  if (!tokenRes.ok) {
    return jsonError("oauth_error", `github token exchange failed: ${tokenRes.status}`, 502);
  }
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (tokenBody.error || !tokenBody.access_token) {
    return jsonError(
      "oauth_error",
      `github token exchange returned error: ${tokenBody.error ?? "no access_token"}`,
      502,
    );
  }

  const userRes = await fetch(GITHUB_USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenBody.access_token}`,
      "User-Agent": "4a-gateway",
    },
  });
  if (!userRes.ok) {
    return jsonError("oauth_error", `github /user fetch failed: ${userRes.status}`, 502);
  }
  const user = (await userRes.json()) as { id?: number; login?: string };
  if (typeof user.id !== "number" || typeof user.login !== "string") {
    return jsonError("oauth_error", "github /user returned unexpected payload", 502);
  }

  const oauth_id = String(user.id);
  const token = await mintJwt({ provider: PROVIDER, oauth_id, login: user.login }, env);

  return new Response(
    JSON.stringify({ token, user: { provider: PROVIDER, id: oauth_id, login: user.login } }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}
