// 4A v0.5 raw-* sibling audience endpoints (T2a, sonata-studio-v0-phase2-plan §2.3).
//
// Sibling to audience.ts but with NIP-98 auth and *caller-supplied* signed
// events. The original audience.ts path uses JWT + KMS-derived signing — the
// gateway itself signs every event. The raw/ path inverts that: the caller
// (typically the Sonata Studio plugin) holds aud_id_priv / plugin_priv, signs
// the events itself, and the gateway only validates, fans out, and caches.
//
// Auth: NIP-98 (kind:27235) Bearer the request URL + method + body hash.
// Verified via lib/nip98.verifyNip98. Per-identity rate limit reuses the
// publish.ts in-memory window with key "nip98:" + caller_pubkey.
//
// Routes (mounted under /v0/audience/raw/*):
//   POST /create          — caller-signed declaration + founding grant
//   POST /grant           — caller-signed grant (+ optional updated declaration)
//   POST /rotate          — caller-signed declaration + grants[]
//   POST /invite          — caller-signed declaration with new fa:pending
//   POST /claim           — caller-signed kind:30522
//   POST /process-claims  — read-only scan; rotation is the caller's job
//   POST /publish-wraps   — caller-built gift_wraps[]; gateway fans out
//
// All responses are JSON with Cache-Control: no-store and the same CORS
// headers as audience.ts.

import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { SignedEvent, KmsEnv } from "./kms";
import type { AuthEnv } from "./auth";
import {
  audienceAddress,
  parseAudienceAddress,
} from "./lib/audience-events";
import {
  parseAudienceDeclaration,
  validateAudienceEvent,
  type AudienceDeclaration,
  type AudienceLookup,
} from "./audience-validator";
import { validateKeyGrantEvent } from "./keygrant-validator";
import { validateAudienceClaimEvent } from "./audience-claim-validator";
import { validateGiftWrapEvent } from "./gift-wrap-validator";
import {
  loadAudienceStatus,
  rejectIfClosed,
  readAudienceStatus,
} from "./audience-closed-guard";
import { verifyNip98 } from "./lib/nip98";
import type { NostrEvent, RelayPool } from "./relay-pool";
import { fanOut, rateLimitCheck, type RelayResult } from "./publish";

export type AudienceRawEnv = AuthEnv & KmsEnv & {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
};

const HEX64 = /^[0-9a-f]{64}$/i;
const HEX128 = /^[0-9a-f]{128}$/i;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const JSON_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

class RawValidationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function jsonError(
  code: string,
  message: string,
  status: number,
  extra?: Record<string, unknown>,
): Response {
  return jsonResponse({ error: code, message, ...(extra ?? {}) }, status);
}

// ─── shared parsers ────────────────────────────────────────────────────────

function requireObject(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RawValidationError("bad_request", `${field} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new RawValidationError("bad_request", `${field} must be a non-empty string`);
  }
  return raw;
}

function requireHex64(raw: unknown, field: string): string {
  const s = requireString(raw, field);
  if (!HEX64.test(s)) {
    throw new RawValidationError("bad_request", `${field} must be 32-byte hex`);
  }
  return s.toLowerCase();
}

/**
 * Parse and structurally validate a SignedNostrEvent body field. Performs the
 * same well-formedness checks the relay-pool DO would (canonical id +
 * schnorr sig) so we surface caller bugs as 400 instead of 502.
 */
function requireSignedEvent(raw: unknown, field: string): SignedEvent {
  const obj = requireObject(raw, field);
  if (typeof obj.id !== "string" || !HEX64.test(obj.id)) {
    throw new RawValidationError("bad_request", `${field}.id must be 32-byte hex`);
  }
  if (typeof obj.pubkey !== "string" || !HEX64.test(obj.pubkey)) {
    throw new RawValidationError("bad_request", `${field}.pubkey must be 32-byte hex`);
  }
  if (typeof obj.sig !== "string" || !HEX128.test(obj.sig)) {
    throw new RawValidationError("bad_request", `${field}.sig must be 64-byte hex`);
  }
  if (typeof obj.created_at !== "number" || !Number.isFinite(obj.created_at)) {
    throw new RawValidationError("bad_request", `${field}.created_at must be a number`);
  }
  if (typeof obj.kind !== "number" || !Number.isInteger(obj.kind)) {
    throw new RawValidationError("bad_request", `${field}.kind must be an integer`);
  }
  if (typeof obj.content !== "string") {
    throw new RawValidationError("bad_request", `${field}.content must be a string`);
  }
  if (!Array.isArray(obj.tags)) {
    throw new RawValidationError("bad_request", `${field}.tags must be an array`);
  }
  for (const t of obj.tags) {
    if (!Array.isArray(t)) {
      throw new RawValidationError("bad_request", `${field}.tags entries must be arrays`);
    }
    for (const v of t) {
      if (typeof v !== "string") {
        throw new RawValidationError("bad_request", `${field}.tags entries must contain strings`);
      }
    }
  }
  const event: SignedEvent = {
    id: obj.id.toLowerCase(),
    pubkey: obj.pubkey.toLowerCase(),
    created_at: obj.created_at,
    kind: obj.kind,
    tags: obj.tags as string[][],
    content: obj.content,
    sig: obj.sig.toLowerCase(),
  };
  // Canonical NIP-01 id check.
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const expectedId = bytesToHex(sha256(new TextEncoder().encode(serialized)));
  if (expectedId !== event.id) {
    throw new RawValidationError(
      "bad_request",
      `${field}.id does not match canonical NIP-01 hash`,
    );
  }
  let sigOk = false;
  try {
    sigOk = schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    throw new RawValidationError("bad_request", `${field} schnorr signature does not verify`);
  }
  return event;
}

function requireAddress(raw: unknown, field: string): { audIdPub: string; slug: string } {
  const s = requireString(raw, field);
  const parsed = parseAudienceAddress(s);
  if (!parsed) {
    throw new RawValidationError(
      "bad_request",
      `${field} must be 30520:<aud_id-hex>:<slug>`,
    );
  }
  return { audIdPub: parsed.pubkey, slug: parsed.slug };
}

// ─── declaration cache lookup ──────────────────────────────────────────────

async function lookupDeclarationByAddress(
  audIdPub: string,
  slug: string,
  env: AudienceRawEnv,
): Promise<{ event: NostrEvent; decl: AudienceDeclaration } | null> {
  const id = env.RELAY_POOL.idFromName("main");
  const stub = env.RELAY_POOL.get(id);
  const event = await stub.getObject(30520, audIdPub, slug);
  if (!event) return null;
  const parsed = parseAudienceDeclaration(event, { dropExpiredPending: true });
  if (!parsed.ok) return null;
  return { event, decl: parsed.value };
}

function buildLookup(
  audIdPub: string,
  slug: string,
  decl: AudienceDeclaration,
): AudienceLookup {
  const expected = audienceAddress(audIdPub, slug);
  return {
    currentDeclarationByAddress: (addr) => {
      if (addr.toLowerCase() !== expected.toLowerCase()) return undefined;
      return decl;
    },
  };
}

// ─── publish helpers ───────────────────────────────────────────────────────

interface PublishOutcome {
  signed: SignedEvent;
  acks: RelayResult[];
  accepted: boolean;
}

async function publishAndStore(
  signed: SignedEvent,
  env: AudienceRawEnv,
): Promise<PublishOutcome> {
  const acks = await fanOut(signed);
  const accepted = acks.some((r) => r.status === "accepted");
  if (accepted) {
    try {
      const id = env.RELAY_POOL.idFromName("main");
      const stub = env.RELAY_POOL.get(id);
      await stub.storeAudienceEvent(signed).catch(() => {});
    } catch {
      // best-effort cache.
    }
  }
  return { signed, acks, accepted };
}

async function publishGiftWrap(
  signed: SignedEvent,
  recipient: string,
  env: AudienceRawEnv,
): Promise<RelayResult[]> {
  const acks = await fanOut(signed);
  if (acks.some((r) => r.status === "accepted")) {
    try {
      const id = env.RELAY_POOL.idFromName("main");
      const stub = env.RELAY_POOL.get(id);
      await stub.storeGiftWrap(signed, recipient).catch(() => {});
    } catch {
      // best-effort.
    }
  }
  return acks;
}

// ─── /v0/audience/raw/create ───────────────────────────────────────────────

interface CreateBody {
  declaration: SignedEvent;
  founding_grant: SignedEvent;
}

function parseCreateBody(raw: Record<string, unknown>): CreateBody {
  return {
    declaration: requireSignedEvent(raw.declaration, "declaration"),
    founding_grant: requireSignedEvent(raw.founding_grant, "founding_grant"),
  };
}

async function runCreate(
  callerPubkey: string,
  body: CreateBody,
  env: AudienceRawEnv,
): Promise<Response> {
  const { declaration, founding_grant } = body;

  // 1. Validate declaration structurally (no lookup — first publish).
  const declCheck = validateAudienceEvent(declaration);
  if (!declCheck.ok) {
    return jsonError("bad_request", `declaration invalid: ${declCheck.error}`, 400);
  }
  const parsedDecl = parseAudienceDeclaration(declaration);
  if (!parsedDecl.ok) {
    return jsonError("bad_request", `declaration parse failed: ${parsedDecl.error}`, 400);
  }
  const decl = parsedDecl.value;

  // 2. founding_grant signed by aud_id_priv (= declaration.pubkey).
  if (declaration.pubkey.toLowerCase() !== founding_grant.pubkey.toLowerCase()) {
    return jsonError(
      "bad_request",
      "founding_grant must be signed by aud_id (declaration.pubkey)",
      400,
    );
  }

  // 3. Validate founding_grant against the just-declared declaration.
  const grantLookup = buildLookup(declaration.pubkey, decl.slug, decl);
  const grantCheck = validateKeyGrantEvent(founding_grant, grantLookup);
  if (!grantCheck.ok) {
    return jsonError("bad_request", `founding_grant invalid: ${grantCheck.error}`, 400);
  }

  // 4. Caller must appear as a member of the declaration (the plugin owns its room).
  const callerIsMember = decl.members.some(
    (m) => m.toLowerCase() === callerPubkey.toLowerCase(),
  );
  if (!callerIsMember) {
    return jsonError(
      "bad_request",
      "caller_pubkey must appear as a member of the declaration",
      400,
    );
  }

  // 5. founding_grant recipient (p tag) must equal caller_pubkey.
  const grantRecipient = founding_grant.tags.find((t) => t[0] === "p")?.[1];
  if (
    !grantRecipient ||
    grantRecipient.toLowerCase() !== callerPubkey.toLowerCase()
  ) {
    return jsonError(
      "bad_request",
      "founding_grant recipient (p tag) must equal caller_pubkey",
      400,
    );
  }

  // 6. Fan-out: declaration first, then grant.
  const declOut = await publishAndStore(declaration, env);
  if (!declOut.accepted) {
    return jsonError("relay_failure", "no relays accepted the declaration", 502, {
      relay_acks: declOut.acks,
    });
  }
  const grantOut = await publishAndStore(founding_grant, env);

  return jsonResponse({
    ok: true,
    audience_address: audienceAddress(declaration.pubkey, decl.slug),
    declaration_event_id: declaration.id,
    founding_grant_event_id: founding_grant.id,
    relay_acks: { declaration: declOut.acks, founding_grant: grantOut.acks },
  });
}

// ─── /v0/audience/raw/grant ────────────────────────────────────────────────

interface GrantBody {
  audience_address: string;
  grant: SignedEvent;
  updated_declaration?: SignedEvent;
}

function parseGrantBody(raw: Record<string, unknown>): GrantBody {
  const out: GrantBody = {
    audience_address: requireString(raw.audience_address, "audience_address"),
    grant: requireSignedEvent(raw.grant, "grant"),
  };
  if (raw.updated_declaration !== undefined) {
    out.updated_declaration = requireSignedEvent(
      raw.updated_declaration,
      "updated_declaration",
    );
  }
  return out;
}

async function runGrant(
  callerPubkey: string,
  body: GrantBody,
  env: AudienceRawEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");
  const cached = await lookupDeclarationByAddress(audIdPub, slug, env);
  if (!cached) {
    return jsonError("not_found", "audience declaration not found", 404);
  }
  const closed = rejectIfClosed(
    await loadAudienceStatus(audIdPub, slug, env),
    "grant",
  );
  if (closed) return closed;

  // Caller must sign the grant (current member issuing a grant).
  if (body.grant.pubkey.toLowerCase() !== callerPubkey.toLowerCase()) {
    return jsonError(
      "bad_request",
      "grant must be signed by the caller (current member)",
      400,
    );
  }

  const lookup = buildLookup(audIdPub, slug, cached.decl);
  const grantCheck = validateKeyGrantEvent(body.grant, lookup);
  if (!grantCheck.ok) {
    return jsonError("bad_request", `grant invalid: ${grantCheck.error}`, 400);
  }

  // Validate optional updated_declaration. Must be signed by aud_id, not the
  // caller — the audience identity is the only key that can re-issue 30520.
  if (body.updated_declaration) {
    if (body.updated_declaration.pubkey.toLowerCase() !== audIdPub.toLowerCase()) {
      return jsonError(
        "bad_request",
        "updated_declaration must be signed by aud_id (audience_address pubkey)",
        400,
      );
    }
    const declCheck = validateAudienceEvent(body.updated_declaration);
    if (!declCheck.ok) {
      return jsonError(
        "bad_request",
        `updated_declaration invalid: ${declCheck.error}`,
        400,
      );
    }
  }

  // Fan-out: grant first; declaration if supplied.
  const grantOut = await publishAndStore(body.grant, env);
  let declOut: PublishOutcome | undefined;
  if (body.updated_declaration) {
    declOut = await publishAndStore(body.updated_declaration, env);
  }

  return jsonResponse({
    ok: true,
    grant_event_id: body.grant.id,
    declaration_event_id: body.updated_declaration?.id ?? cached.event.id,
    relay_acks: {
      grant: grantOut.acks,
      declaration: declOut?.acks ?? [],
    },
  });
}

// ─── /v0/audience/raw/rotate ───────────────────────────────────────────────

interface RotateBody {
  audience_address: string;
  declaration: SignedEvent;
  grants: SignedEvent[];
}

function parseRotateBody(raw: Record<string, unknown>): RotateBody {
  if (!Array.isArray(raw.grants)) {
    throw new RawValidationError("bad_request", "grants must be an array");
  }
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
    declaration: requireSignedEvent(raw.declaration, "declaration"),
    grants: raw.grants.map((g, i) => requireSignedEvent(g, `grants[${i}]`)),
  };
}

async function runRotate(
  _callerPubkey: string,
  body: RotateBody,
  env: AudienceRawEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");

  // Rotating a closed room is forbidden. Reopen-then-rotate is a separate
  // two-step sequence by the founder.
  const closed = rejectIfClosed(
    await loadAudienceStatus(audIdPub, slug, env),
    "rotate",
  );
  if (closed) return closed;

  // Declaration must be signed by aud_id.
  if (body.declaration.pubkey.toLowerCase() !== audIdPub.toLowerCase()) {
    return jsonError(
      "bad_request",
      "declaration must be signed by aud_id (audience_address pubkey)",
      400,
    );
  }
  const declCheck = validateAudienceEvent(body.declaration);
  if (!declCheck.ok) {
    return jsonError("bad_request", `declaration invalid: ${declCheck.error}`, 400);
  }
  const parsed = parseAudienceDeclaration(body.declaration);
  if (!parsed.ok) {
    return jsonError("bad_request", `declaration parse failed: ${parsed.error}`, 400);
  }
  if (parsed.value.slug !== slug) {
    return jsonError("bad_request", "declaration slug does not match audience_address", 400);
  }

  // Each grant must validate against the new declaration.
  const lookup = buildLookup(audIdPub, slug, parsed.value);
  for (let i = 0; i < body.grants.length; i++) {
    const g = body.grants[i]!;
    const r = validateKeyGrantEvent(g, lookup);
    if (!r.ok) {
      return jsonError("bad_request", `grants[${i}] invalid: ${r.error}`, 400);
    }
  }

  // Fan-out: declaration first so subsequent reads see the new epoch.
  const declOut = await publishAndStore(body.declaration, env);
  if (!declOut.accepted) {
    return jsonError("relay_failure", "no relays accepted the rotated declaration", 502, {
      relay_acks: declOut.acks,
    });
  }
  // Per-grant fan-out. Use `relay_acks` to match the field name every other
  // route (and admit.ts in sonata-studio) reads. The previous `acks` key
  // silently broke partial-failure detection — admit's `g.relay_acks ?? []`
  // saw `undefined`, treated rejection as success, and never reported the
  // partial_rotate. Surface `accepted` explicitly so callers don't re-derive.
  const grantOuts: {
    recipient: string;
    event_id: string;
    accepted: boolean;
    relay_acks: RelayResult[];
  }[] = [];
  for (const g of body.grants) {
    const recipient = g.tags.find((t) => t[0] === "p")?.[1] ?? "";
    const out = await publishAndStore(g, env);
    grantOuts.push({
      recipient,
      event_id: g.id,
      accepted: out.accepted,
      relay_acks: out.acks,
    });
  }

  return jsonResponse({
    ok: true,
    audience_address: audienceAddress(audIdPub, slug),
    epoch: parsed.value.epoch,
    declaration_event_id: body.declaration.id,
    grants: grantOuts,
    members: parsed.value.members,
  });
}

// ─── /v0/audience/raw/invite ───────────────────────────────────────────────

interface InviteBody {
  audience_address: string;
  declaration: SignedEvent;
  invite_pub: string;
  invite_priv_4ainv: string;
}

function parseInviteBody(raw: Record<string, unknown>): InviteBody {
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
    declaration: requireSignedEvent(raw.declaration, "declaration"),
    invite_pub: requireHex64(raw.invite_pub, "invite_pub"),
    invite_priv_4ainv: requireString(raw.invite_priv_4ainv, "invite_priv_4ainv"),
  };
}

const HTTPS_CLAIM_BASE = "https://claim.4a4.ai";

async function runInvite(
  _callerPubkey: string,
  body: InviteBody,
  env: AudienceRawEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");

  // Cannot mint invites for a closed room.
  const closed = rejectIfClosed(
    await loadAudienceStatus(audIdPub, slug, env),
    "invite",
  );
  if (closed) return closed;

  if (body.declaration.pubkey.toLowerCase() !== audIdPub.toLowerCase()) {
    return jsonError(
      "bad_request",
      "declaration must be signed by aud_id (audience_address pubkey)",
      400,
    );
  }
  const declCheck = validateAudienceEvent(body.declaration);
  if (!declCheck.ok) {
    return jsonError("bad_request", `declaration invalid: ${declCheck.error}`, 400);
  }
  const parsed = parseAudienceDeclaration(body.declaration);
  if (!parsed.ok) {
    return jsonError("bad_request", `declaration parse failed: ${parsed.error}`, 400);
  }
  if (parsed.value.slug !== slug) {
    return jsonError("bad_request", "declaration slug does not match audience_address", 400);
  }

  const matchingPending = parsed.value.pending.find(
    (p) => p.invitePub.toLowerCase() === body.invite_pub.toLowerCase(),
  );
  if (!matchingPending) {
    return jsonError(
      "bad_request",
      "declaration does not include a fa:pending entry for invite_pub",
      400,
    );
  }

  const declOut = await publishAndStore(body.declaration, env);
  if (!declOut.accepted) {
    return jsonError("relay_failure", "no relays accepted the declaration", 502, {
      relay_acks: declOut.acks,
    });
  }

  const s4aUrl = `s4a://invite/${slug}/${parsed.value.epoch}?k=${body.invite_priv_4ainv}`;
  const httpsUrl = `${HTTPS_CLAIM_BASE}/invite/${slug}/${parsed.value.epoch}?k=${body.invite_priv_4ainv}`;

  return jsonResponse({
    ok: true,
    s4a_url: s4aUrl,
    https_url: httpsUrl,
    invite_pub: body.invite_pub,
    invite_priv_4ainv: body.invite_priv_4ainv,
    expires_at: matchingPending.expirationUnix,
    declaration_event_id: body.declaration.id,
  });
}

// ─── /v0/audience/raw/claim ────────────────────────────────────────────────

interface ClaimBody {
  audience_address: string;
  claim: SignedEvent;
}

function parseClaimBody(raw: Record<string, unknown>): ClaimBody {
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
    claim: requireSignedEvent(raw.claim, "claim"),
  };
}

async function runClaim(
  _callerPubkey: string,
  body: ClaimBody,
  env: AudienceRawEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");
  const cached = await lookupDeclarationByAddress(audIdPub, slug, env);

  // Closed-room guard: reject join claims, allow leave claims (a member of a
  // closed room may still record their departure).
  const claimStatus = body.claim.tags.find((t) => t[0] === "fa:status")?.[1];
  const isLeave = claimStatus === "left";
  if (!isLeave) {
    const closed = rejectIfClosed(
      await loadAudienceStatus(audIdPub, slug, env),
      "claim",
    );
    if (closed) return closed;
  }

  // Claim validation works without the cached declaration too — but if we
  // have it, the lookup catches "this invite_pub is no longer pending" at
  // request time.
  const lookup: AudienceLookup = cached
    ? buildLookup(audIdPub, slug, cached.decl)
    : {};
  const claimCheck = validateAudienceClaimEvent(body.claim, lookup);
  if (!claimCheck.ok) {
    // Special-case the leave-while-booted race (§5.4): if the leaving
    // member is no longer in the roster, surface 403 not_current_member so
    // the renderer can map this to a "you were already removed" toast
    // rather than a generic validation failure.
    if (isLeave && claimCheck.error === "not_current_member") {
      return jsonError(
        "not_current_member",
        "leaving member is not in the current declaration's roster",
        403,
      );
    }
    return jsonError("bad_request", `claim invalid: ${claimCheck.error}`, 400);
  }

  const out = await publishAndStore(body.claim, env);
  if (!out.accepted) {
    return jsonError("relay_failure", "no relays accepted the claim event", 502, {
      relay_acks: out.acks,
    });
  }

  return jsonResponse({
    ok: true,
    audience_address: audienceAddress(audIdPub, slug),
    claim_event_id: body.claim.id,
    relay_acks: out.acks,
  });
}

// ─── /v0/audience/raw/process-claims ───────────────────────────────────────

interface ProcessClaimsBody {
  audience_address: string;
}

function parseProcessClaimsBody(raw: Record<string, unknown>): ProcessClaimsBody {
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
  };
}

async function runProcessClaims(
  _callerPubkey: string,
  body: ProcessClaimsBody,
  env: AudienceRawEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");
  const cached = await lookupDeclarationByAddress(audIdPub, slug, env);
  if (!cached) {
    return jsonError("not_found", "audience declaration not found", 404);
  }

  const id = env.RELAY_POOL.idFromName("main");
  const stub = env.RELAY_POOL.get(id);
  const lookup: AudienceLookup = {
    currentDeclarationByAddress: () => cached.decl,
  };
  const claimed: { invite_pub: string; claim_pubkey: string; claim_event_id: string }[] = [];
  for (const pending of cached.decl.pending) {
    const dTag = `${slug}:${cached.decl.epoch}:${pending.invitePub}`;
    const claimEvt = await stub.getObject(30522, pending.invitePub, dTag);
    if (!claimEvt) continue;
    const claimPubTag = claimEvt.tags.find((t) => t[0] === "fa:claim-pubkey")?.[1];
    if (!claimPubTag) continue;
    const validation = validateAudienceClaimEvent(claimEvt, lookup);
    if (!validation.ok) continue;
    claimed.push({
      invite_pub: pending.invitePub,
      claim_pubkey: claimPubTag,
      claim_event_id: claimEvt.id,
    });
  }
  return jsonResponse({ ok: true, claimed });
}

// ─── /v0/audience/raw/publish-wraps ────────────────────────────────────────

interface PublishWrapsBody {
  audience_address: string;
  gift_wraps: SignedEvent[];
}

function parsePublishWrapsBody(raw: Record<string, unknown>): PublishWrapsBody {
  if (!Array.isArray(raw.gift_wraps) || raw.gift_wraps.length === 0) {
    throw new RawValidationError("bad_request", "gift_wraps must be a non-empty array");
  }
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
    gift_wraps: raw.gift_wraps.map((g, i) => requireSignedEvent(g, `gift_wraps[${i}]`)),
  };
}

async function runPublishWraps(
  _callerPubkey: string,
  body: PublishWrapsBody,
  env: AudienceRawEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");
  const cached = await lookupDeclarationByAddress(audIdPub, slug, env);
  if (!cached) {
    return jsonError("not_found", "audience declaration not found", 404);
  }
  const closed = rejectIfClosed(
    await loadAudienceStatus(audIdPub, slug, env),
    "publish-wraps",
  );
  if (closed) return closed;

  const memberSet = new Set(cached.decl.members.map((m) => m.toLowerCase()));

  // Pre-flight: every wrap must address a current member, and validate the
  // gift-wrap envelope shape. Fail-fast so partial fan-out doesn't leak some
  // wraps before discovering a bad one.
  for (let i = 0; i < body.gift_wraps.length; i++) {
    const w = body.gift_wraps[i]!;
    const r = validateGiftWrapEvent(w);
    if (!r.ok) {
      return jsonError("bad_request", `gift_wraps[${i}] invalid: ${r.error}`, 400);
    }
    const recipient = w.tags.find((t) => t[0] === "p")?.[1] ?? "";
    if (!memberSet.has(recipient.toLowerCase())) {
      return jsonError(
        "bad_request",
        `gift_wraps[${i}] addresses non-member ${recipient}`,
        400,
      );
    }
  }

  const wraps: { recipient: string; event_id: string; relay_acks: RelayResult[] }[] = [];
  for (const w of body.gift_wraps) {
    const recipient = w.tags.find((t) => t[0] === "p")?.[1] ?? "";
    const acks = await publishGiftWrap(w, recipient, env);
    wraps.push({ recipient, event_id: w.id, relay_acks: acks });
  }

  return jsonResponse({
    ok: true,
    audience_address: audienceAddress(audIdPub, slug),
    epoch: cached.decl.epoch,
    gift_wraps: wraps,
  });
}

// ─── /v0/audience/raw/publish-declaration ──────────────────────────────────

interface PublishDeclarationBody {
  audience_address: string;
  declaration: SignedEvent;
}

function parsePublishDeclarationBody(
  raw: Record<string, unknown>,
): PublishDeclarationBody {
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
    declaration: requireSignedEvent(raw.declaration, "declaration"),
  };
}

/**
 * Publish a re-signed kind:30520 declaration without minting key-grants or
 * invites. Used by the Studio room-lifecycle plumbing for boot / close /
 * reopen: roster + status changes that don't rotate the epoch.
 *
 * Auth is the Schnorr signature on the kind:30520 — `declaration.pubkey` must
 * equal the audience identity (`audIdPub`) from `audience_address`, and the
 * sig is verified via `validateAudienceEvent` (which `requireSignedEvent`
 * already runs structurally; `validateAudienceEvent` additionally enforces
 * the cross-event "identity key never rotates" invariant). The NIP-98 wrapper
 * authenticates the caller for rate-limiting, but the route-level admin gate
 * is the audience-identity signature itself — consistent with runRotate /
 * runInvite, which similarly trust the inner declaration's signer.
 */
async function runPublishDeclaration(
  _callerPubkey: string,
  body: PublishDeclarationBody,
  env: AudienceRawEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");

  if (body.declaration.pubkey.toLowerCase() !== audIdPub.toLowerCase()) {
    return jsonError(
      "bad_request",
      "declaration must be signed by aud_id (audience_address pubkey)",
      400,
    );
  }
  const declCheck = validateAudienceEvent(body.declaration);
  if (!declCheck.ok) {
    return jsonError("bad_request", `declaration invalid: ${declCheck.error}`, 400);
  }
  const parsed = parseAudienceDeclaration(body.declaration);
  if (!parsed.ok) {
    return jsonError("bad_request", `declaration parse failed: ${parsed.error}`, 400);
  }
  if (parsed.value.slug !== slug) {
    return jsonError("bad_request", "declaration slug does not match audience_address", 400);
  }

  // Status-transition check: a closed room may be reopened (status flips to
  // active), or re-closed idempotently with the same roster, but its roster
  // cannot be reshaped while still closed.
  const prior = await loadAudienceStatus(audIdPub, slug, env);
  const next = readAudienceStatus(body.declaration);
  if (prior && prior.status === "closed" && next.status === "closed") {
    const priorMembers = prior.declaration.members.map((m) => m.toLowerCase()).sort();
    const nextMembers = parsed.value.members.map((m) => m.toLowerCase()).sort();
    const rosterChanged =
      priorMembers.length !== nextMembers.length ||
      priorMembers.some((m, i) => m !== nextMembers[i]);
    if (rosterChanged) {
      return jsonError(
        "closed_room_roster_locked",
        "cannot reshape roster while audience is closed; reopen first",
        403,
      );
    }
  }

  const out = await publishAndStore(body.declaration, env);
  if (!out.accepted) {
    return jsonError("relay_failure", "no relays accepted the declaration", 502, {
      relay_acks: out.acks,
    });
  }

  return jsonResponse({
    ok: true,
    audience_address: audienceAddress(audIdPub, slug),
    declaration_event_id: body.declaration.id,
    relay_acks: out.acks,
  });
}

// ─── router ────────────────────────────────────────────────────────────────

type RawRoute = (
  callerPubkey: string,
  body: Record<string, unknown>,
  env: AudienceRawEnv,
) => Promise<Response>;

const ROUTES: Record<string, RawRoute> = {
  "/v0/audience/raw/create": (pk, raw, env) => runCreate(pk, parseCreateBody(raw), env),
  "/v0/audience/raw/grant": (pk, raw, env) => runGrant(pk, parseGrantBody(raw), env),
  "/v0/audience/raw/rotate": (pk, raw, env) => runRotate(pk, parseRotateBody(raw), env),
  "/v0/audience/raw/invite": (pk, raw, env) => runInvite(pk, parseInviteBody(raw), env),
  "/v0/audience/raw/claim": (pk, raw, env) => runClaim(pk, parseClaimBody(raw), env),
  "/v0/audience/raw/process-claims": (pk, raw, env) =>
    runProcessClaims(pk, parseProcessClaimsBody(raw), env),
  "/v0/audience/raw/publish-wraps": (pk, raw, env) =>
    runPublishWraps(pk, parsePublishWrapsBody(raw), env),
  "/v0/audience/raw/publish-declaration": (pk, raw, env) =>
    runPublishDeclaration(pk, parsePublishDeclarationBody(raw), env),
};

export async function handleAudienceRawRequest(
  request: Request,
  env: AudienceRawEnv,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }

  const url = new URL(request.url);
  const handler = ROUTES[url.pathname];
  if (!handler) {
    return jsonError("not_found", `no handler for ${url.pathname}`, 404);
  }

  // Read body bytes + verify NIP-98 + parse JSON inside one helper. The
  // per-route parser runs after auth so payload-shape errors don't leak any
  // bandwidth before we know the caller is authenticated.
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return jsonError("bad_request", "could not read request body", 400);
  }
  const auth = await verifyNip98(request, bodyBytes);
  if (!auth.ok) {
    return jsonError(auth.error, "NIP-98 auth failed", 401);
  }

  const rl = rateLimitCheck(`nip98:${auth.pubkey}`);
  if (!rl.ok) {
    return jsonError("rate_limited", "max 60 requests/hour per identity", 429, {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return jsonError("bad_request", "request body must be valid JSON", 400);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return jsonError("bad_request", "request body must be a JSON object", 400);
  }

  try {
    return await handler(auth.pubkey, raw as Record<string, unknown>, env);
  } catch (err) {
    if (err instanceof RawValidationError) {
      return jsonError(err.code, err.message, err.status);
    }
    return jsonError(
      "internal_error",
      err instanceof Error ? err.message : "audience raw request failed",
      500,
    );
  }
}

// Re-exports for tests.
export const __audienceRawInternals = {
  runCreate,
  runGrant,
  runRotate,
  runInvite,
  runClaim,
  runProcessClaims,
  runPublishWraps,
  runPublishDeclaration,
  parseCreateBody,
  parseGrantBody,
  parseRotateBody,
  parseInviteBody,
  parseClaimBody,
  parseProcessClaimsBody,
  parsePublishWrapsBody,
  parsePublishDeclarationBody,
  requireSignedEvent,
};

