// 4A OAuth + JWT module — Phase 2 custodial publishing path.
//
// This module is two things at once:
//   (1) An OAuth client to upstream IdPs (Google, GitHub) — exchanges their
//       codes for the user's identity.
//   (2) An OAuth Authorization Server for downstream API clients (the ChatGPT
//       GPT, Claude.ai connector, and any other MCP client) — issues
//       short-lived auth codes and exchanges them for 4A JWTs at /auth/token.
//
// Endpoints:
//   GET  /auth/{provider}/start     — entry / authorization endpoint. If
//                                     invoked with OAuth params it runs the
//                                     full AS flow (with optional PKCE).
//                                     Without those params it falls back to
//                                     the legacy "direct" browser flow that
//                                     returns a JWT as JSON.
//   GET  /auth/{provider}/callback  — provider redirects here. Either
//                                     redirects back to the downstream
//                                     client with code+state (AS flow) or
//                                     returns the JWT as JSON (direct flow).
//   POST /auth/token                — RFC 6749 §4.1.3 token endpoint.
//                                     Exchanges an auth code for a 4A JWT.
//                                     PKCE-aware (RFC 7636).
//   POST /auth/register             — RFC 7591 dynamic client registration.
//                                     Stateless: the returned client_id is a
//                                     signed token that encodes a hash of
//                                     the secret + registered redirect_uris.
//
// Plus two metadata documents exposed via dedicated route handlers:
//   GET /.well-known/oauth-authorization-server  → authorizationServerMetadata
//   GET /.well-known/oauth-protected-resource    → protectedResourceMetadata
//
// State, auth codes, and dynamic client_ids are all stateless: signed JSON
// blobs HMAC'd with JWT_SIGNING_KEY. No KV, no DO, no DB. The 5-min auth-code
// TTL is the replay window.
//
// The Nostr key is derived in kms.ts from (provider:oauth_id), so the same
// person logging in with Google vs GitHub gets two distinct, non-colliding
// 4A identities.

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
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  // Static downstream client cred. Optional — clients can also obtain creds
  // via dynamic registration at /auth/register.
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  // Comma-separated list of allowed redirect_uri prefixes for the static
  // client and for DCR. Empty/unset uses DEFAULT_REDIRECT_URI_PREFIXES.
  OAUTH_REDIRECT_URI_ALLOWLIST?: string;
}

const JWT_TTL_SECONDS = 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;
const AUTH_CODE_TTL_SECONDS = 5 * 60;

const DEFAULT_REDIRECT_URI_PREFIXES = [
  "https://chat.openai.com/aip/",
  "https://chatgpt.com/aip/",
  "https://claude.ai/",
  "https://claude.com/",
  "https://evenflow.work/",
];

const DCR_PREFIX = "dcr1_";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface ProviderUser {
  oauth_id: string;
  login: string;
}

interface ProviderConfig {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
  callbackUrl: string;
  clientId(env: AuthEnv): string | undefined;
  clientSecret(env: AuthEnv): string | undefined;
  // Build the body sent to tokenUrl. GitHub accepts JSON; Google requires form-urlencoded.
  buildTokenRequest(args: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): { headers: Record<string, string>; body: string };
  // Auth header for the userinfo request.
  userInfoHeaders(accessToken: string): Record<string, string>;
  // Parse the userinfo response into a ProviderUser, or throw to bubble up an oauth_error.
  parseUserInfo(payload: unknown): ProviderUser;
}

const GITHUB: ProviderConfig = {
  name: "github",
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userInfoUrl: "https://api.github.com/user",
  scope: "read:user",
  callbackUrl: "https://api.4a4.ai/auth/github/callback",
  clientId: (env) => env.GITHUB_OAUTH_CLIENT_ID,
  clientSecret: (env) => env.GITHUB_OAUTH_CLIENT_SECRET,
  buildTokenRequest({ code, clientId, clientSecret, redirectUri }) {
    return {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "4a-gateway",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    };
  },
  userInfoHeaders(accessToken) {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "4a-gateway",
    };
  },
  parseUserInfo(payload) {
    const user = payload as { id?: number; login?: string };
    if (typeof user.id !== "number" || typeof user.login !== "string") {
      throw new Error("github /user returned unexpected payload");
    }
    return { oauth_id: String(user.id), login: user.login };
  },
};

const GOOGLE: ProviderConfig = {
  name: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  scope: "openid email profile",
  callbackUrl: "https://api.4a4.ai/auth/google/callback",
  clientId: (env) => env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: (env) => env.GOOGLE_OAUTH_CLIENT_SECRET,
  buildTokenRequest({ code, clientId, clientSecret, redirectUri }) {
    const form = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    return {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    };
  },
  userInfoHeaders(accessToken) {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
  },
  parseUserInfo(payload) {
    const user = payload as { sub?: string; email?: string };
    if (typeof user.sub !== "string" || typeof user.email !== "string") {
      throw new Error("google userinfo returned unexpected payload");
    }
    return { oauth_id: user.sub, login: user.email };
  },
};

const PROVIDERS: Record<string, ProviderConfig> = {
  github: GITHUB,
  google: GOOGLE,
};

// ── Encoding / hashing helpers ─────────────────────────────────────────────

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

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
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

async function signedToken(payload: unknown, env: AuthEnv): Promise<string> {
  const body = b64urlString(JSON.stringify(payload));
  const key = await importHmacKey(getSigningSecret(env));
  const sig = await hmacSign(key, body);
  return `${body}.${b64urlBytes(sig)}`;
}

async function verifySignedToken<T>(token: string, env: AuthEnv): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const body = parts[0]!;
  const sigB64 = parts[1]!;
  let sig: Uint8Array;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  const key = await importHmacKey(getSigningSecret(env));
  if (!(await hmacVerify(key, body, sig))) return null;
  try {
    return JSON.parse(dec.decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

// ── JWT (downstream API access token) ──────────────────────────────────────

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

// ── State token (upstream OAuth state we send to Google/GitHub) ────────────

interface StateToken {
  v: 1;
  prov: string; // upstream provider name
  exp: number;
  // AS-flow context
  ru?: string;  // downstream client redirect_uri
  cs?: string;  // downstream client state
  ci?: string;  // downstream client_id
  cc?: string;  // PKCE code_challenge
  cm?: string;  // PKCE code_challenge_method
}

interface AsContext {
  redirectUri: string;
  clientState: string;
  clientId: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

async function mintState(
  provider: string,
  env: AuthEnv,
  asContext?: AsContext,
): Promise<string> {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const payload: StateToken & { n: string } = {
    v: 1,
    n: b64urlBytes(nonceBytes),
    prov: provider,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    ...(asContext
      ? {
          ru: asContext.redirectUri,
          cs: asContext.clientState,
          ci: asContext.clientId,
          ...(asContext.codeChallenge ? { cc: asContext.codeChallenge } : {}),
          ...(asContext.codeChallengeMethod ? { cm: asContext.codeChallengeMethod } : {}),
        }
      : {}),
  };
  return signedToken(payload, env);
}

async function verifyState(
  state: string,
  expectedProvider: string,
  env: AuthEnv,
): Promise<StateToken | null> {
  const decoded = await verifySignedToken<StateToken & { n?: string }>(state, env);
  if (!decoded) return null;
  if (decoded.v !== 1) return null;
  if (decoded.prov !== expectedProvider) return null;
  if (typeof decoded.exp !== "number") return null;
  if (decoded.exp <= Math.floor(Date.now() / 1000)) return null;
  return decoded;
}

// ── Auth code (downstream) ─────────────────────────────────────────────────

interface AuthCodeToken {
  v: 1;
  prov: string;
  exp: number;
  oid: string; // oauth_id
  lg: string;  // login
  ru: string;  // redirect_uri (must match at /auth/token)
  ci: string;  // client_id (must match at /auth/token)
  cc?: string; // PKCE code_challenge
  cm?: string; // PKCE code_challenge_method
}

async function mintAuthCode(
  payload: Omit<AuthCodeToken, "v" | "exp">,
  env: AuthEnv,
): Promise<string> {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  return signedToken(
    {
      v: 1,
      n: b64urlBytes(nonceBytes),
      ...payload,
      exp: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SECONDS,
    },
    env,
  );
}

async function verifyAuthCode(code: string, env: AuthEnv): Promise<AuthCodeToken | null> {
  const decoded = await verifySignedToken<AuthCodeToken>(code, env);
  if (!decoded) return null;
  if (decoded.v !== 1) return null;
  if (typeof decoded.exp !== "number") return null;
  if (decoded.exp <= Math.floor(Date.now() / 1000)) return null;
  if (
    typeof decoded.prov !== "string" ||
    typeof decoded.oid !== "string" ||
    typeof decoded.lg !== "string" ||
    typeof decoded.ru !== "string" ||
    typeof decoded.ci !== "string"
  ) {
    return null;
  }
  return decoded;
}

// ── Dynamic Client Registration (RFC 7591) ─────────────────────────────────

interface DcrPayload {
  v: 1;
  sh: string;     // sha256(client_secret), b64url
  rus: string[];  // registered redirect_uris
  n: string;      // client_name (truncated)
  iat: number;
}

interface ClientValidation {
  ok: boolean;
  redirectUris?: string[]; // dynamic clients have explicitly-registered URIs
}

async function validateClient(
  clientId: string,
  clientSecret: string | undefined,
  env: AuthEnv,
): Promise<ClientValidation> {
  if (env.OAUTH_CLIENT_ID && clientId === env.OAUTH_CLIENT_ID) {
    if (clientSecret !== undefined && clientSecret !== env.OAUTH_CLIENT_SECRET) {
      return { ok: false };
    }
    return { ok: true };
  }
  if (clientId.startsWith(DCR_PREFIX)) {
    const decoded = await verifySignedToken<DcrPayload>(
      clientId.slice(DCR_PREFIX.length),
      env,
    );
    if (!decoded || decoded.v !== 1) return { ok: false };
    if (!Array.isArray(decoded.rus)) return { ok: false };
    if (clientSecret !== undefined) {
      const expectedHash = b64urlBytes(await sha256(clientSecret));
      if (expectedHash !== decoded.sh) return { ok: false };
    }
    return { ok: true, redirectUris: decoded.rus };
  }
  return { ok: false };
}

// ── Redirect-URI allowlist ─────────────────────────────────────────────────

function isAllowedRedirectUri(uri: string, env: AuthEnv): boolean {
  const configured = (env.OAUTH_REDIRECT_URI_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const prefixes = configured.length > 0 ? configured : DEFAULT_REDIRECT_URI_PREFIXES;
  return prefixes.some((prefix) => uri.startsWith(prefix));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function pkceVerify(challenge: string, method: string, verifier: string): Promise<boolean> {
  if (method !== "S256") return false;
  const computed = b64urlBytes(await sha256(verifier));
  return computed === challenge;
}

// ── Metadata documents (RFC 8414 + RFC 9728) ───────────────────────────────

const METADATA_HEADERS: HeadersInit = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
  "Access-Control-Allow-Origin": "*",
};

export function authorizationServerMetadata(): Response {
  const meta = {
    issuer: "https://api.4a4.ai",
    authorization_endpoint: "https://api.4a4.ai/auth/google/start",
    token_endpoint: "https://api.4a4.ai/auth/token",
    registration_endpoint: "https://api.4a4.ai/auth/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
    scopes_supported: ["publish"],
    service_documentation: "https://4a4.ai",
  };
  return new Response(JSON.stringify(meta), { status: 200, headers: METADATA_HEADERS });
}

export function protectedResourceMetadata(): Response {
  const meta = {
    resource: "https://mcp.4a4.ai",
    authorization_servers: ["https://api.4a4.ai"],
    scopes_supported: ["publish"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://4a4.ai",
  };
  return new Response(JSON.stringify(meta), { status: 200, headers: METADATA_HEADERS });
}

// ── Top-level dispatch ─────────────────────────────────────────────────────

export async function handleAuthRequest(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/auth/token" && method === "POST") return tokenEndpoint(request, env);
  if (path === "/auth/register" && method === "POST") return registerEndpoint(request, env);

  // /auth/{provider}/start | /auth/{provider}/callback
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 3 && segs[0] === "auth") {
    const providerName = segs[1]!;
    const action = segs[2]!;
    const provider = PROVIDERS[providerName];
    if (provider) {
      if (action === "start" && method === "GET") return startProvider(provider, url, env);
      if (action === "callback" && method === "GET") return callbackProvider(provider, url, env);
    }
  }
  return jsonError("not_found", `unknown auth path: ${path}`, 404);
}

// ── /auth/{provider}/start ─────────────────────────────────────────────────

async function startProvider(
  provider: ProviderConfig,
  url: URL,
  env: AuthEnv,
): Promise<Response> {
  const providerClientId = provider.clientId(env);
  if (!providerClientId) {
    return jsonError(
      "misconfigured",
      `${provider.name.toUpperCase()}_OAUTH_CLIENT_ID is not configured`,
      500,
    );
  }
  if (!env.JWT_SIGNING_KEY) {
    return jsonError("misconfigured", "JWT_SIGNING_KEY is not configured", 500);
  }

  const asClientId = url.searchParams.get("client_id");
  const asRedirectUri = url.searchParams.get("redirect_uri");
  const asState = url.searchParams.get("state") ?? "";
  const asResponseType = url.searchParams.get("response_type");
  const codeChallenge = url.searchParams.get("code_challenge") ?? undefined;
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? undefined;
  const isAsFlow = !!(asClientId || asRedirectUri || asResponseType);

  let asContext: AsContext | undefined;
  if (isAsFlow) {
    if (asResponseType !== "code") {
      return jsonError(
        "unsupported_response_type",
        "only response_type=code is supported",
        400,
      );
    }
    if (!asClientId || !asRedirectUri) {
      return jsonError("invalid_request", "missing client_id or redirect_uri", 400);
    }
    const validation = await validateClient(asClientId, undefined, env);
    if (!validation.ok) {
      return jsonError("invalid_client", "unknown client_id", 401);
    }
    const allowed = validation.redirectUris
      ? validation.redirectUris.includes(asRedirectUri)
      : isAllowedRedirectUri(asRedirectUri, env);
    if (!allowed) {
      return jsonError(
        "invalid_request",
        validation.redirectUris
          ? "redirect_uri does not match any registered URI"
          : "redirect_uri is not allowlisted",
        400,
      );
    }
    if (codeChallenge) {
      if (codeChallengeMethod && codeChallengeMethod !== "S256") {
        return jsonError(
          "invalid_request",
          "only code_challenge_method=S256 is supported",
          400,
        );
      }
    }
    asContext = {
      redirectUri: asRedirectUri,
      clientState: asState,
      clientId: asClientId,
      codeChallenge,
      codeChallengeMethod: codeChallenge ? codeChallengeMethod ?? "S256" : undefined,
    };
  }

  const state = await mintState(provider.name, env, asContext);
  const params = new URLSearchParams({
    client_id: providerClientId,
    redirect_uri: provider.callbackUrl,
    scope: provider.scope,
    state,
    response_type: "code",
  });
  if (provider.name === "github") params.set("allow_signup", "true");
  return Response.redirect(`${provider.authorizeUrl}?${params.toString()}`, 302);
}

// ── /auth/{provider}/callback ──────────────────────────────────────────────

async function callbackProvider(
  provider: ProviderConfig,
  url: URL,
  env: AuthEnv,
): Promise<Response> {
  const providerClientId = provider.clientId(env);
  const providerClientSecret = provider.clientSecret(env);
  if (!providerClientId || !providerClientSecret) {
    return jsonError(
      "misconfigured",
      `${provider.name} OAuth secrets are not configured`,
      500,
    );
  }
  if (!env.JWT_SIGNING_KEY) {
    return jsonError("misconfigured", "JWT_SIGNING_KEY is not configured", 500);
  }
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  if (!code || !stateRaw) return jsonError("bad_request", "missing code or state", 400);
  const state = await verifyState(stateRaw, provider.name, env);
  if (!state) return jsonError("bad_request", "invalid or expired state", 400);

  const tokenReq = provider.buildTokenRequest({
    code,
    clientId: providerClientId,
    clientSecret: providerClientSecret,
    redirectUri: provider.callbackUrl,
  });
  const tokenRes = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: tokenReq.headers,
    body: tokenReq.body,
  });
  if (!tokenRes.ok) {
    return jsonError(
      "oauth_error",
      `${provider.name} token exchange failed: ${tokenRes.status}`,
      502,
    );
  }
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (tokenBody.error || !tokenBody.access_token) {
    return jsonError(
      "oauth_error",
      `${provider.name} token exchange returned error: ${tokenBody.error ?? "no access_token"}`,
      502,
    );
  }

  const userRes = await fetch(provider.userInfoUrl, {
    headers: provider.userInfoHeaders(tokenBody.access_token),
  });
  if (!userRes.ok) {
    return jsonError(
      "oauth_error",
      `${provider.name} userinfo fetch failed: ${userRes.status}`,
      502,
    );
  }
  let user: ProviderUser;
  try {
    user = provider.parseUserInfo(await userRes.json());
  } catch (e) {
    return jsonError("oauth_error", String(e instanceof Error ? e.message : e), 502);
  }

  // AS flow
  if (state.ru && state.ci) {
    const authCode = await mintAuthCode(
      {
        prov: provider.name,
        oid: user.oauth_id,
        lg: user.login,
        ru: state.ru,
        ci: state.ci,
        ...(state.cc ? { cc: state.cc, cm: state.cm ?? "S256" } : {}),
      },
      env,
    );
    const target = new URL(state.ru);
    target.searchParams.set("code", authCode);
    if (state.cs) target.searchParams.set("state", state.cs);
    return Response.redirect(target.toString(), 302);
  }

  // Direct flow (legacy / power-user)
  const token = await mintJwt(
    { provider: provider.name, oauth_id: user.oauth_id, login: user.login },
    env,
  );
  return new Response(
    JSON.stringify({
      token,
      user: { provider: provider.name, id: user.oauth_id, login: user.login },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

// ── /auth/token ────────────────────────────────────────────────────────────

async function tokenEndpoint(request: Request, env: AuthEnv): Promise<Response> {
  if (!env.JWT_SIGNING_KEY) {
    return jsonError("misconfigured", "JWT_SIGNING_KEY is not configured", 500);
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  let body: Record<string, string>;
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await request.text();
      body = Object.fromEntries(new URLSearchParams(text).entries());
    } else if (contentType.includes("application/json")) {
      body = (await request.json()) as Record<string, string>;
    } else {
      const text = await request.text();
      body = Object.fromEntries(new URLSearchParams(text).entries());
    }
  } catch {
    return jsonError("invalid_request", "could not parse request body", 400);
  }

  let clientId = body.client_id;
  let clientSecret = body.client_secret;
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(authHeader.slice(6).trim());
      const colonAt = decoded.indexOf(":");
      if (colonAt > 0) {
        clientId = decodeURIComponent(decoded.slice(0, colonAt));
        clientSecret = decodeURIComponent(decoded.slice(colonAt + 1));
      }
    } catch {
      return jsonError("invalid_client", "malformed Authorization header", 401);
    }
  }

  const grantType = body.grant_type;
  const code = body.code;
  const redirectUri = body.redirect_uri;
  const codeVerifier = body.code_verifier;

  if (grantType !== "authorization_code") {
    return jsonError(
      "unsupported_grant_type",
      "only grant_type=authorization_code is supported",
      400,
    );
  }
  if (!code || !redirectUri || !clientId) {
    return jsonError("invalid_request", "missing code, redirect_uri, or client_id", 400);
  }

  const validation = await validateClient(clientId, clientSecret, env);
  if (!validation.ok) {
    return jsonError("invalid_client", "client authentication failed", 401);
  }

  const authCode = await verifyAuthCode(code, env);
  if (!authCode) {
    return jsonError("invalid_grant", "code is invalid or expired", 400);
  }
  if (authCode.ru !== redirectUri) {
    return jsonError("invalid_grant", "redirect_uri does not match", 400);
  }
  if (authCode.ci !== clientId) {
    return jsonError("invalid_grant", "client_id does not match", 400);
  }

  // PKCE verification — if the auth code carries a challenge, the verifier is
  // mandatory and must match.
  if (authCode.cc) {
    if (!codeVerifier) {
      return jsonError("invalid_grant", "code_verifier required (PKCE)", 400);
    }
    const ok = await pkceVerify(authCode.cc, authCode.cm ?? "S256", codeVerifier);
    if (!ok) {
      return jsonError("invalid_grant", "code_verifier does not match challenge", 400);
    }
  }

  const accessToken = await mintJwt(
    { provider: authCode.prov, oauth_id: authCode.oid, login: authCode.lg },
    env,
  );

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: JWT_TTL_SECONDS,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}

// ── /auth/register (RFC 7591) ──────────────────────────────────────────────

async function registerEndpoint(request: Request, env: AuthEnv): Promise<Response> {
  if (!env.JWT_SIGNING_KEY) {
    return jsonError("misconfigured", "JWT_SIGNING_KEY is not configured", 500);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("invalid_client_metadata", "expected application/json body", 400);
  }

  const redirectUrisRaw = body.redirect_uris;
  if (!Array.isArray(redirectUrisRaw) || redirectUrisRaw.length === 0) {
    return jsonError(
      "invalid_redirect_uri",
      "redirect_uris must be a non-empty array",
      400,
    );
  }
  const redirectUris: string[] = [];
  for (const u of redirectUrisRaw) {
    if (typeof u !== "string") {
      return jsonError("invalid_redirect_uri", "redirect_uris must be strings", 400);
    }
    if (!isAllowedRedirectUri(u, env)) {
      return jsonError(
        "invalid_redirect_uri",
        `redirect_uri ${u} is not allowlisted by the 4A authorization server`,
        400,
      );
    }
    redirectUris.push(u);
  }

  const clientName =
    typeof body.client_name === "string" ? body.client_name.slice(0, 200) : "";

  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const clientSecret = b64urlBytes(secretBytes);
  const secretHash = b64urlBytes(await sha256(clientSecret));

  const issuedAt = Math.floor(Date.now() / 1000);
  const dcrPayload: DcrPayload = {
    v: 1,
    sh: secretHash,
    rus: redirectUris,
    n: clientName,
    iat: issuedAt,
  };
  const clientId = DCR_PREFIX + (await signedToken(dcrPayload, env));

  const responseBody = {
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: issuedAt,
    client_secret_expires_at: 0, // never
    redirect_uris: redirectUris,
    client_name: clientName,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
    application_type: "web",
  };
  return new Response(JSON.stringify(responseBody), {
    status: 201,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
