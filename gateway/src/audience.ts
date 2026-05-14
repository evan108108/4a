// 4A v0.5 audience-management routes.
//
// Six routes under api.4a4.ai/v0/audience/*:
//
//   POST /v0/audience/create   — generate aud_id + aud_epoch_1, publish
//                                kind:30520 + founding kind:30521.
//   POST /v0/audience/invite   — generate (invite_priv, invite_pub),
//                                republish 30520 with new fa:pending,
//                                return s4a:// + claim.4a4.ai URLs.
//   POST /v0/audience/grant    — direct kind:30521 grant to a known pubkey
//                                + republish declaration with the new member.
//   POST /v0/audience/claim    — sign + publish kind:30522 with invite_priv
//                                (called by the claim page).
//   POST /v0/audience/rotate   — generate aud_epoch_(n+1), republish 30520
//                                with new roster, issue grants to all members.
//   POST /v0/audience/publish  — encrypt payload to aud_epoch_n_pub, build
//                                kind:30510-30514 rumor, NIP-17 gift-wrap to
//                                each current member, publish all wraps.
//   GET  /v0/audience/:slug/inbox — capability-based decryption for
//                                custodial users (see §2.5).
//
// The audience identity priv (`aud_id_priv`) and current epoch priv are
// returned to the caller on /create and accepted as inputs on subsequent
// state-mutating routes. Per PLAN-v0.5 §6 Q1 default, the gateway does NOT
// persist these; the caller (or their local client) is responsible for
// storing them. A future revision may add `?delegate=true` to opt into
// gateway-side custody.

import { nip19 } from "nostr-tools";
import { hexToBytes, bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { verifyJwt, type AuthClaims, type AuthEnv } from "./auth";
import {
  deriveNostrKey,
  type EventTemplate,
  type KmsEnv,
  type SignedEvent,
} from "./kms";
import {
  buildAudienceClaim,
  buildAudienceDeclaration,
  buildEncryptedVariant,
  buildKeyGrant,
  audienceAddress,
  parseAudienceAddress,
  ENCRYPTED_VARIANT_KINDS,
  type EncryptedVariantKind,
} from "./lib/audience-events";
import {
  encrypt as nip44Encrypt,
  encryptString as nip44EncryptString,
  decrypt as nip44Decrypt,
  decryptString as nip44DecryptString,
} from "./lib/nip44";
import { wrap as giftWrapEvent, unwrap as giftUnwrap } from "./lib/nip17";
import {
  encodeInviteKey,
  decodeInviteKey,
} from "./lib/invite-key";
import {
  generateAudienceIdentity,
  generateEpochKeypair,
  pubkeyFromPriv,
} from "./lib/audience-keys";
import { signEventWithRawKey } from "./lib/sign";
import {
  parseAudienceDeclaration,
  validateAudienceEvent,
  type AudienceDeclaration,
  type AudienceLookup,
} from "./audience-validator";
import { validateKeyGrantEvent } from "./keygrant-validator";
import { validateAudienceClaimEvent } from "./audience-claim-validator";
import { validateEncryptedVariantEvent } from "./encrypted-variant-validator";
import { validateGiftWrapEvent } from "./gift-wrap-validator";
import {
  loadAudienceStatus as loadAudienceStatusGuard,
  rejectIfClosed as rejectIfClosedGuard,
} from "./audience-closed-guard";
import type { NostrEvent, RelayPool } from "./relay-pool";
import { fanOut, rateLimitCheck, type RelayResult } from "./publish";

export type AudienceEnv = AuthEnv & KmsEnv & {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
};

const HEX64 = /^[0-9a-f]{64}$/i;
const SLUG = /^[A-Za-z0-9-]+$/;
const DEFAULT_INVITE_TTL_SEC = 7 * 24 * 60 * 60;
const HTTPS_CLAIM_BASE = "https://claim.4a4.ai";

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

class AudienceValidationError extends Error {}

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

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new AudienceValidationError(`${field} must be a non-empty string`);
  }
  return raw;
}

function requireSlug(raw: unknown, field: string): string {
  const s = requireString(raw, field);
  if (!SLUG.test(s)) {
    throw new AudienceValidationError(`${field} must match /^[A-Za-z0-9-]+$/`);
  }
  return s;
}

function requireHex64(raw: unknown, field: string): string {
  const s = requireString(raw, field);
  if (!HEX64.test(s)) {
    throw new AudienceValidationError(`${field} must be 32-byte hex`);
  }
  return s.toLowerCase();
}

function requireHex64Bytes(raw: unknown, field: string): Uint8Array {
  return hexToBytes(requireHex64(raw, field));
}

function requireAddress(raw: unknown, field: string): { audIdPub: string; slug: string } {
  const s = requireString(raw, field);
  const parsed = parseAudienceAddress(s);
  if (!parsed) {
    throw new AudienceValidationError(`${field} must be 30520:<aud_id-hex>:<slug>`);
  }
  return { audIdPub: parsed.pubkey, slug: parsed.slug };
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AudienceValidationError("request body must be valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AudienceValidationError("request body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

async function authenticate(
  request: Request,
  env: AudienceEnv,
): Promise<AuthClaims | Response> {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError("unauthorized", "missing Authorization: Bearer <jwt>", 401);
  }
  const claims = await verifyJwt(auth.slice("Bearer ".length).trim(), env);
  if (!claims) return jsonError("unauthorized", "invalid or expired token", 401);
  return claims;
}

interface PublishOutcome {
  signed: SignedEvent;
  acks: RelayResult[];
  accepted: boolean;
}

async function publishAndStore(
  signed: SignedEvent,
  env: AudienceEnv,
): Promise<PublishOutcome> {
  const acks = await fanOut(signed);
  const accepted = acks.some((r) => r.status === "accepted");
  if (!accepted) {
    console.error("[publishAndStore] not-accepted", {
      kind: signed.kind,
      id: signed.id,
      pubkey: signed.pubkey,
      d: signed.tags.find((t) => t[0] === "d")?.[1] ?? null,
      ack_count: acks.length,
      ack_summary: acks.map((a) => `${a.relay}:${a.status}${a.message ? "(" + a.message + ")" : ""}`),
    });
  }
  if (accepted) {
    try {
      const id = env.RELAY_POOL.idFromName("main");
      const stub = env.RELAY_POOL.get(id);
      // Cache the just-published event so subsequent route calls in the same
      // request lifetime can read the latest declaration without a relay
      // round-trip. Storage failures used to be silently swallowed via
      // `.catch(() => {})` AND the return value was discarded — that masked
      // a class of "relays accepted, gateway didn't cache" bugs where
      // listKeyGrants/listGiftWraps returned empty even though the wire
      // succeeded. Log so the failure mode is visible in `wrangler tail`.
      const storeResult = await stub.storeAudienceEvent(signed).catch((err) => {
        console.error("[publishAndStore] storeAudienceEvent threw", {
          kind: signed.kind,
          id: signed.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, reason: "store_threw" } as const;
      });
      if (!storeResult.ok) {
        console.error("[publishAndStore] storeAudienceEvent rejected", {
          kind: signed.kind,
          id: signed.id,
          pubkey: signed.pubkey,
          d: signed.tags.find((t) => t[0] === "d")?.[1] ?? null,
          reason: storeResult.reason ?? "unknown",
        });
      }
    } catch (err) {
      console.error("[publishAndStore] outer catch", {
        kind: signed.kind,
        id: signed.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { signed, acks, accepted };
}

async function lookupDeclarationByAddress(
  audIdPub: string,
  slug: string,
  env: AudienceEnv,
): Promise<{ event: NostrEvent; decl: AudienceDeclaration } | null> {
  const id = env.RELAY_POOL.idFromName("main");
  const stub = env.RELAY_POOL.get(id);
  const event = await stub.getObject(30520, audIdPub, slug);
  if (!event) return null;
  const parsed = parseAudienceDeclaration(event);
  if (!parsed.ok) return null;
  return { event, decl: parsed.value };
}

async function buildLookup(
  audIdPub: string,
  slug: string,
  env: AudienceEnv,
): Promise<AudienceLookup> {
  const cached = await lookupDeclarationByAddress(audIdPub, slug, env);
  return {
    currentDeclarationByAddress: (addr) => {
      if (!cached) return undefined;
      const expected = audienceAddress(audIdPub, slug);
      if (addr.toLowerCase() !== expected.toLowerCase()) return undefined;
      return cached.decl;
    },
  };
}

// ─── /v0/audience/create ────────────────────────────────────────────────────

interface CreateBody {
  slug: string;
  name: string;
  description?: string;
}

function validateCreateBody(raw: Record<string, unknown>): CreateBody {
  const slug = requireSlug(raw.slug, "slug");
  const name = requireString(raw.name, "name");
  const description =
    raw.description === undefined ? undefined : requireString(raw.description, "description");
  return { slug, name, description };
}

async function runCreate(
  body: CreateBody,
  claims: AuthClaims,
  env: AudienceEnv,
): Promise<Response> {
  const identity = { provider: claims.provider, oauth_id: claims.oauth_id };
  const { secretKey: callerPriv, publicKey: callerPub } = await deriveNostrKey(identity, env);

  // 1. Generate audience identity + first epoch keypair.
  const audId = generateAudienceIdentity();
  const epoch1 = generateEpochKeypair();

  // 2. Build + sign the kind:30520 declaration (signed by aud_id, founder is
  //    the caller — caller_pub is the sole initial member).
  const declTpl = buildAudienceDeclaration({
    audIdPub: audId.pub,
    slug: body.slug,
    name: body.name,
    description: body.description,
    epoch: 1,
    epochPub: epoch1.pub,
    members: [callerPub],
  });
  const declSigned = signEventWithRawKey(declTpl, audId.priv);
  const declCheck = validateAudienceEvent(declSigned);
  if (!declCheck.ok) {
    return jsonError("internal_error", `built invalid declaration: ${declCheck.error}`, 500);
  }

  // 3. Build + sign the founding kind:30521 (signed by aud_id; recipient is
  //    the caller; content = NIP-44(epoch1_priv, aud_id_priv → caller_pub)).
  const ciphertext = nip44Encrypt(epoch1.priv, audId.priv, callerPub);
  const grantTpl = buildKeyGrant({
    audIdPub: audId.pub,
    slug: body.slug,
    epoch: 1,
    recipientPub: callerPub,
    ciphertext,
  });
  const grantSigned = signEventWithRawKey(grantTpl, audId.priv);

  // 4. Publish both events.
  const declOut = await publishAndStore(declSigned, env);
  if (!declOut.accepted) {
    return jsonError("relay_failure", "no relays accepted the audience declaration", 502, {
      relay_acks: declOut.acks,
    });
  }
  const grantOut = await publishAndStore(grantSigned, env);

  callerPriv.fill(0);

  return jsonResponse({
    ok: true,
    audience_address: audienceAddress(audId.pub, body.slug),
    aud_id_pub: audId.pub,
    aud_id_priv: bytesToHex(audId.priv),
    epoch: 1,
    aud_epoch_pub: epoch1.pub,
    aud_epoch_priv: bytesToHex(epoch1.priv),
    declaration_event_id: declSigned.id,
    founding_grant_event_id: grantSigned.id,
    founder_pubkey: callerPub,
    founder_npub: nip19.npubEncode(callerPub),
    relay_acks: { declaration: declOut.acks, founding_grant: grantOut.acks },
  });
}

// ─── /v0/audience/invite ────────────────────────────────────────────────────

interface InviteBody {
  audience_address: string;
  aud_id_priv: Uint8Array;
  ttl_seconds: number;
}

function validateInviteBody(raw: Record<string, unknown>): InviteBody {
  // We only return the parsed shape; the audience_address is re-parsed by
  // requireAddress below, which already throws AudienceValidationError on
  // malformed input.
  const audience_address = requireString(raw.audience_address, "audience_address");
  const aud_id_priv = requireHex64Bytes(raw.aud_id_priv, "aud_id_priv");
  let ttl = DEFAULT_INVITE_TTL_SEC;
  if (raw.ttl_seconds !== undefined) {
    if (typeof raw.ttl_seconds !== "number" || raw.ttl_seconds <= 0) {
      throw new AudienceValidationError("ttl_seconds must be a positive number");
    }
    ttl = Math.floor(raw.ttl_seconds);
  }
  return { audience_address, aud_id_priv, ttl_seconds: ttl };
}

async function runInvite(body: InviteBody, env: AudienceEnv): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");
  // Verify aud_id_priv matches audIdPub (callers must hold the audience
  // identity priv to invite — protects against forged declarations).
  if (pubkeyFromPriv(body.aud_id_priv) !== audIdPub) {
    return jsonError("unauthorized", "aud_id_priv does not match audience_address", 401);
  }

  const cached = await lookupDeclarationByAddress(audIdPub, slug, env);
  if (!cached) {
    return jsonError("not_found", "audience declaration not found in relay cache", 404);
  }
  const closed = rejectIfClosedGuard(
    await loadAudienceStatusGuard(audIdPub, slug, env),
    "invite",
  );
  if (closed) return closed;

  // Generate the invite keypair.
  const invitePriv = randomBytes(32);
  const invitePub = bytesToHex(schnorr.getPublicKey(invitePriv));
  const expirationUnix = nowSec() + body.ttl_seconds;

  // Re-publish kind:30520 with the new fa:pending tag.
  const newPending = [...cached.decl.pending, { invitePub, expirationUnix }];
  const declTpl = buildAudienceDeclaration({
    audIdPub: audIdPub,
    slug,
    name: extractDeclarationName(cached.event) ?? slug,
    description: extractDeclarationDescription(cached.event),
    epoch: cached.decl.epoch,
    epochPub: cached.decl.epochPub,
    members: cached.decl.members,
    pending: newPending,
  });
  const declSigned = signEventWithRawKey(declTpl, body.aud_id_priv);
  const declOut = await publishAndStore(declSigned, env);
  if (!declOut.accepted) {
    return jsonError("relay_failure", "no relays accepted the updated declaration", 502, {
      relay_acks: declOut.acks,
    });
  }

  const inviteKey = encodeInviteKey(invitePriv);
  const s4aUrl = `s4a://invite/${slug}/${cached.decl.epoch}?k=${inviteKey}`;
  const httpsUrl = `${HTTPS_CLAIM_BASE}/invite/${slug}/${cached.decl.epoch}?k=${inviteKey}`;

  return jsonResponse({
    ok: true,
    s4a_url: s4aUrl,
    https_url: httpsUrl,
    invite_pub: invitePub,
    invite_priv_4ainv: inviteKey,
    expires_at: expirationUnix,
    declaration_event_id: declSigned.id,
  });
}

function extractDeclarationName(event: NostrEvent): string | undefined {
  try {
    const obj = JSON.parse(event.content) as Record<string, unknown>;
    return typeof obj.name === "string" ? obj.name : undefined;
  } catch {
    return undefined;
  }
}

function extractDeclarationDescription(event: NostrEvent): string | undefined {
  try {
    const obj = JSON.parse(event.content) as Record<string, unknown>;
    return typeof obj.description === "string" ? obj.description : undefined;
  } catch {
    return undefined;
  }
}

// ─── /v0/audience/grant ─────────────────────────────────────────────────────

interface GrantBody {
  audience_address: string;
  aud_id_priv: Uint8Array;
  aud_epoch_priv: Uint8Array;
  recipient_pubkey: string;
}

function validateGrantBody(raw: Record<string, unknown>): GrantBody {
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
    aud_id_priv: requireHex64Bytes(raw.aud_id_priv, "aud_id_priv"),
    aud_epoch_priv: requireHex64Bytes(raw.aud_epoch_priv, "aud_epoch_priv"),
    recipient_pubkey: requireHex64(raw.recipient_pubkey, "recipient_pubkey"),
  };
}

async function runGrant(
  body: GrantBody,
  claims: AuthClaims,
  env: AudienceEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");
  if (pubkeyFromPriv(body.aud_id_priv) !== audIdPub) {
    return jsonError("unauthorized", "aud_id_priv does not match audience_address", 401);
  }
  const closedGrant = rejectIfClosedGuard(
    await loadAudienceStatusGuard(audIdPub, slug, env),
    "grant",
  );
  if (closedGrant) return closedGrant;
  const cached = await lookupDeclarationByAddress(audIdPub, slug, env);
  if (!cached) {
    return jsonError("not_found", "audience declaration not found in relay cache", 404);
  }
  // The granter signs with their identity key; verify that pubkeyFromPriv of
  // aud_epoch_priv matches the epoch the declaration is currently on.
  if (pubkeyFromPriv(body.aud_epoch_priv) !== cached.decl.epochPub) {
    return jsonError(
      "bad_request",
      "aud_epoch_priv does not match the current declaration's fa:epoch-pubkey",
      400,
    );
  }

  // Caller's identity = granter pubkey from KMS derivation.
  const identity = { provider: claims.provider, oauth_id: claims.oauth_id };
  const { secretKey: granterPriv, publicKey: granterPub } = await deriveNostrKey(identity, env);

  // 1. Build + sign the kind:30521 grant from granter → recipient.
  const ciphertext = nip44Encrypt(body.aud_epoch_priv, granterPriv, body.recipient_pubkey);
  const grantTpl = buildKeyGrant({
    audIdPub,
    slug,
    epoch: cached.decl.epoch,
    recipientPub: body.recipient_pubkey,
    ciphertext,
  });
  const grantSigned = signEventWithRawKey(grantTpl, granterPriv);

  // 2. Re-publish declaration with new member added (no rotation per Q2 default).
  const isAlreadyMember = cached.decl.members.some(
    (m) => m.toLowerCase() === body.recipient_pubkey.toLowerCase(),
  );
  let declSigned: SignedEvent | undefined;
  if (!isAlreadyMember) {
    const newMembers = [...cached.decl.members, body.recipient_pubkey];
    const declTpl = buildAudienceDeclaration({
      audIdPub,
      slug,
      name: extractDeclarationName(cached.event) ?? slug,
      description: extractDeclarationDescription(cached.event),
      epoch: cached.decl.epoch,
      epochPub: cached.decl.epochPub,
      members: newMembers,
      pending: cached.decl.pending,
    });
    declSigned = signEventWithRawKey(declTpl, body.aud_id_priv);
  }

  // Publish.
  const grantOut = await publishAndStore(grantSigned, env);
  let declOut: PublishOutcome | undefined;
  if (declSigned) {
    declOut = await publishAndStore(declSigned, env);
  }
  granterPriv.fill(0);

  return jsonResponse({
    ok: true,
    grant_event_id: grantSigned.id,
    declaration_event_id: declSigned?.id ?? cached.event.id,
    granter_pubkey: granterPub,
    recipient_pubkey: body.recipient_pubkey,
    relay_acks: { grant: grantOut.acks, declaration: declOut?.acks ?? [] },
  });
}

// ─── /v0/audience/claim ─────────────────────────────────────────────────────

interface ClaimBody {
  audience_address: string;
  epoch: number;
  invite_priv_4ainv: string;
  claim_pubkey: string;
  inviter_pubkey: string;
  note?: string;
}

function validateClaimBody(raw: Record<string, unknown>): ClaimBody {
  const epoch = raw.epoch;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw new AudienceValidationError("epoch must be a positive integer");
  }
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
    epoch,
    invite_priv_4ainv: requireString(raw.invite_priv_4ainv, "invite_priv_4ainv"),
    claim_pubkey: requireHex64(raw.claim_pubkey, "claim_pubkey"),
    inviter_pubkey: requireHex64(raw.inviter_pubkey, "inviter_pubkey"),
    note:
      raw.note === undefined ? undefined : requireString(raw.note, "note"),
  };
}

async function runClaim(body: ClaimBody, env: AudienceEnv): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");
  // Gateway-signed /claim only emits join claims (no leave path); rejecting
  // when the room is closed mirrors the raw-side guard for runClaim with
  // status != "left".
  const closed = rejectIfClosedGuard(
    await loadAudienceStatusGuard(audIdPub, slug, env),
    "claim",
  );
  if (closed) return closed;
  const decoded = decodeInviteKey(body.invite_priv_4ainv);
  if (!decoded.ok) {
    return jsonError("bad_request", `invalid invite_priv_4ainv: ${decoded.error.kind}`, 400);
  }
  const invitePriv = decoded.priv;
  const invitePub = pubkeyFromPriv(invitePriv);

  const claimTpl = buildAudienceClaim({
    audIdPub,
    slug,
    epoch: body.epoch,
    invitePub,
    inviterPub: body.inviter_pubkey,
    claimPub: body.claim_pubkey,
    note: body.note,
    expiration: nowSec() + DEFAULT_INVITE_TTL_SEC,
  });
  const claimSigned = signEventWithRawKey(claimTpl, invitePriv);
  const out = await publishAndStore(claimSigned, env);
  if (!out.accepted) {
    return jsonError("relay_failure", "no relays accepted the claim event", 502, {
      relay_acks: out.acks,
    });
  }

  return jsonResponse({
    ok: true,
    claim_event_id: claimSigned.id,
    invite_pubkey: invitePub,
    claim_pubkey: body.claim_pubkey,
    relay_acks: out.acks,
  });
}

// ─── /v0/audience/process-claims ────────────────────────────────────────────
//
// Polled equivalent of the §4 claim-watcher (PLAN-v0.5 t13). Cloudflare
// Workers don't run long-lived per-inviter subscriptions cheaply; the gateway
// instead exposes a poll endpoint the inviter (or their cron) calls to scan
// for kind:30522 events addressed to their pubkey on the audience and rotate
// once per pending invite that's been claimed.
//
// Idempotency: rotate-on-claim removes the matching fa:pending entry, so a
// second call with the same claim is a no-op (the invite_pub is no longer
// pending and new pending entries don't appear by themselves).

interface ProcessClaimsBody {
  audience_address: string;
  aud_id_priv: Uint8Array;
}

function validateProcessClaimsBody(raw: Record<string, unknown>): ProcessClaimsBody {
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
    aud_id_priv: requireHex64Bytes(raw.aud_id_priv, "aud_id_priv"),
  };
}

async function runProcessClaims(
  body: ProcessClaimsBody,
  claims: AuthClaims,
  env: AudienceEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");
  if (pubkeyFromPriv(body.aud_id_priv) !== audIdPub) {
    return jsonError("unauthorized", "aud_id_priv does not match audience_address", 401);
  }
  const cached = await lookupDeclarationByAddress(audIdPub, slug, env);
  if (!cached) {
    return jsonError("not_found", "audience declaration not found in relay cache", 404);
  }

  // Walk current pending invites; for each one, look for a kind:30522 with
  // d=<slug>:<epoch>:<invite_pub> in local cache. If found, treat it as a
  // claimed invite and queue the (invite_pub, claim_pubkey) for rotation.
  const id = env.RELAY_POOL.idFromName("main");
  const stub = env.RELAY_POOL.get(id);

  const claimed: { invitePub: string; claimPubkey: string; claim_event_id: string }[] = [];
  for (const pending of cached.decl.pending) {
    const dTag = `${slug}:${cached.decl.epoch}:${pending.invitePub}`;
    const claimEvt = await stub.getObject(30522, pending.invitePub, dTag);
    if (!claimEvt) continue;
    // Find fa:claim-pubkey tag.
    const claimPubTag = claimEvt.tags.find((t) => t[0] === "fa:claim-pubkey")?.[1];
    if (!claimPubTag) continue;
    const validation = validateAudienceClaimEvent(claimEvt, {
      currentDeclarationByAddress: () => cached.decl,
    });
    if (!validation.ok) continue;
    claimed.push({
      invitePub: pending.invitePub,
      claimPubkey: claimPubTag,
      claim_event_id: claimEvt.id,
    });
  }

  if (claimed.length === 0) {
    return jsonResponse({ ok: true, claimed: [], rotated: false });
  }

  // One rotation handles all claimed invites at once.
  const rotateBody: RotateBody = {
    audience_address: body.audience_address,
    aud_id_priv: body.aud_id_priv,
    add_members: claimed.map((c) => c.claimPubkey),
    remove_members: [],
    remove_pending: claimed.map((c) => c.invitePub),
  };
  const rotateResp = await runRotate(rotateBody, claims, env);
  if (!rotateResp.ok) return rotateResp;
  const rotateJson = (await rotateResp.json()) as Record<string, unknown>;

  return jsonResponse({
    ok: true,
    claimed,
    rotated: true,
    rotation: rotateJson,
  });
}

// ─── /v0/audience/list-pending-claims ───────────────────────────────────────
//
// Founder-only read: walk the audience's current fa:pending invites and
// surface any matching kind:30522 claim events the gateway has cached. Same
// scan as `runProcessClaims` but stops before issuing the rotation, so the
// inviter can preview pending claims (e.g. to show "Allison wants to join")
// before admitting them.
//
// Founder-gating: requires `aud_id_priv` so callers prove they hold the
// audience identity key, matching the rotate / process-claims pattern.

interface ListPendingClaimsBody {
  audience_address: string;
  aud_id_priv: Uint8Array;
}

function validateListPendingClaimsBody(raw: Record<string, unknown>): ListPendingClaimsBody {
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
    aud_id_priv: requireHex64Bytes(raw.aud_id_priv, "aud_id_priv"),
  };
}

async function runListPendingClaims(
  body: ListPendingClaimsBody,
  env: AudienceEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");
  if (pubkeyFromPriv(body.aud_id_priv) !== audIdPub) {
    return jsonError("unauthorized", "aud_id_priv does not match audience_address", 401);
  }
  const cached = await lookupDeclarationByAddress(audIdPub, slug, env);
  if (!cached) {
    return jsonError("not_found", "audience declaration not found in relay cache", 404);
  }

  const id = env.RELAY_POOL.idFromName("main");
  const stub = env.RELAY_POOL.get(id);

  const claims: {
    invite_pub: string;
    claim_pubkey: string;
    claim_event_id: string;
    expires_at: number;
    content: unknown;
  }[] = [];
  for (const pending of cached.decl.pending) {
    const dTag = `${slug}:${cached.decl.epoch}:${pending.invitePub}`;
    const claimEvt = await stub.getObject(30522, pending.invitePub, dTag);
    if (!claimEvt) continue;
    const claimPubTag = claimEvt.tags.find((t) => t[0] === "fa:claim-pubkey")?.[1];
    if (!claimPubTag) continue;
    const validation = validateAudienceClaimEvent(claimEvt, {
      currentDeclarationByAddress: () => cached.decl,
    });
    if (!validation.ok) continue;
    let content: unknown = claimEvt.content;
    try {
      content = JSON.parse(claimEvt.content);
    } catch {
      // leave as string
    }
    claims.push({
      invite_pub: pending.invitePub,
      claim_pubkey: claimPubTag,
      claim_event_id: claimEvt.id,
      expires_at: pending.expirationUnix,
      content,
    });
  }

  return jsonResponse({
    ok: true,
    audience_address: body.audience_address,
    epoch: cached.decl.epoch,
    pending_invite_count: cached.decl.pending.length,
    claims,
  });
}

// ─── /v0/audience/list-my ───────────────────────────────────────────────────
//
// Returns audiences the caller has access to. Implementation walks every
// cached kind:30521 key-grant addressed to the caller's pubkey, groups by
// (aud_id_pub, slug), and reports the highest epoch the caller holds plus a
// role hint. Role detection is best-effort: founder = the founding grant was
// signed by aud_id itself (rather than by another member), so we mark the
// caller as 'founder' whenever any of their cached grants for the audience
// have `pubkey === aud_id_pub`; otherwise 'member'.

async function runListMy(claims: AuthClaims, env: AudienceEnv): Promise<Response> {
  const identity = { provider: claims.provider, oauth_id: claims.oauth_id };
  const { secretKey: callerPriv, publicKey: callerPub } = await deriveNostrKey(identity, env);
  callerPriv.fill(0);

  const id = env.RELAY_POOL.idFromName("main");
  const stub = env.RELAY_POOL.get(id);
  const grants = await stub.listKeyGrants(callerPub, undefined, 500);

  // (aud_id_pub, slug) -> { latest epoch held, founder? }
  const byAudience = new Map<string, {
    aud_id_pub: string;
    slug: string;
    epoch_n: number;
    role: "founder" | "member";
  }>();
  for (const g of grants) {
    const dTag = g.tags.find((t) => t[0] === "d")?.[1];
    if (!dTag) continue;
    const parts = dTag.split(":");
    if (parts.length !== 3) continue;
    const [slug, epochStr] = parts;
    const epoch = Number(epochStr);
    if (!Number.isSafeInteger(epoch) || epoch < 1) continue;
    const audIdPub = g.pubkey.toLowerCase();
    // Best-effort: the grant's `pubkey` is the granter. The granter could be
    // aud_id (founding case) or a member. We don't yet know which without an
    // extra lookup; we treat the audience as one we belong to either way and
    // resolve role below by checking against the cached declaration.
    const key = `${audIdPub}:${slug}`;
    const existing = byAudience.get(key);
    if (!existing || epoch > existing.epoch_n) {
      byAudience.set(key, { aud_id_pub: audIdPub, slug: slug ?? "", epoch_n: epoch, role: "member" });
    }
  }

  // Resolve role + sanity-check membership against the live declaration. If
  // the caller isn't on the declaration's member roster we drop the entry
  // (their grant was for a stale epoch they've since been rotated out of).
  const audiences: {
    audience_address: string;
    aud_id_pub: string;
    slug: string;
    epoch_n: number;
    role: "founder" | "member";
  }[] = [];
  for (const entry of byAudience.values()) {
    const cached = await lookupDeclarationByAddress(entry.aud_id_pub, entry.slug, env);
    if (!cached) continue;
    const isMember = cached.decl.members.some(
      (m) => m.toLowerCase() === callerPub.toLowerCase(),
    );
    if (!isMember) continue;
    // Founder heuristic: the declaration was signed by aud_id (its pubkey is
    // the audience identity) and the caller was the first member to receive
    // a grant. The wire doesn't carry a "founder" flag, so we approximate
    // by: caller is the only original member or holds an aud_id-signed grant.
    // For v0 keep it simple — anyone holding a grant signed by aud_id is
    // treated as founder.
    const founderGrant = grants.find((g) => {
      const dTag = g.tags.find((t) => t[0] === "d")?.[1];
      return (
        dTag?.startsWith(`${entry.slug}:`) &&
        g.pubkey.toLowerCase() === entry.aud_id_pub.toLowerCase()
      );
    });
    audiences.push({
      audience_address: audienceAddress(entry.aud_id_pub, entry.slug),
      aud_id_pub: entry.aud_id_pub,
      slug: entry.slug,
      epoch_n: entry.epoch_n,
      role: founderGrant ? "founder" : "member",
    });
  }

  audiences.sort((a, b) => a.slug.localeCompare(b.slug));

  return jsonResponse({
    ok: true,
    caller_pubkey: callerPub,
    audiences,
  });
}

// ─── /v0/audience/rotate ────────────────────────────────────────────────────

interface RotateBody {
  audience_address: string;
  aud_id_priv: Uint8Array;
  add_members: string[];
  remove_members: string[];
  remove_pending: string[];
}

function validateRotateBody(raw: Record<string, unknown>): RotateBody {
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
    aud_id_priv: requireHex64Bytes(raw.aud_id_priv, "aud_id_priv"),
    add_members: arrayOfHex64(raw.add_members, "add_members"),
    remove_members: arrayOfHex64(raw.remove_members, "remove_members"),
    remove_pending: arrayOfHex64(raw.remove_pending, "remove_pending"),
  };
}

function arrayOfHex64(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new AudienceValidationError(`${field} must be an array`);
  }
  return raw.map((v, i) => requireHex64(v, `${field}[${i}]`));
}

async function runRotate(
  body: RotateBody,
  claims: AuthClaims,
  env: AudienceEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");
  if (pubkeyFromPriv(body.aud_id_priv) !== audIdPub) {
    return jsonError("unauthorized", "aud_id_priv does not match audience_address", 401);
  }
  const closed = rejectIfClosedGuard(
    await loadAudienceStatusGuard(audIdPub, slug, env),
    "rotate",
  );
  if (closed) return closed;
  const cached = await lookupDeclarationByAddress(audIdPub, slug, env);
  if (!cached) {
    return jsonError("not_found", "audience declaration not found in relay cache", 404);
  }

  // Compute the post-rotation member set.
  const removeSet = new Set(body.remove_members.map((m) => m.toLowerCase()));
  const newMembers = cached.decl.members.filter((m) => !removeSet.has(m.toLowerCase()));
  for (const m of body.add_members) {
    if (!newMembers.some((x) => x.toLowerCase() === m.toLowerCase())) {
      newMembers.push(m);
    }
  }
  // Compute remaining pending invites.
  const removePendingSet = new Set(body.remove_pending.map((m) => m.toLowerCase()));
  const newPending = cached.decl.pending.filter(
    (p) => !removePendingSet.has(p.invitePub.toLowerCase()),
  );

  // Generate new epoch.
  const newEpoch = cached.decl.epoch + 1;
  const epochKp = generateEpochKeypair();

  // Republish declaration.
  const declTpl = buildAudienceDeclaration({
    audIdPub,
    slug,
    name: extractDeclarationName(cached.event) ?? slug,
    description: extractDeclarationDescription(cached.event),
    epoch: newEpoch,
    epochPub: epochKp.pub,
    members: newMembers,
    pending: newPending,
  });
  const declSigned = signEventWithRawKey(declTpl, body.aud_id_priv);
  const declOut = await publishAndStore(declSigned, env);
  if (!declOut.accepted) {
    return jsonError("relay_failure", "no relays accepted the rotated declaration", 502, {
      relay_acks: declOut.acks,
    });
  }

  // Issue grants. Granter is the caller (must be a member of the post-rotation
  // audience). If the caller isn't a member, fall back to signing grants with
  // aud_id (founding-grant pattern) so a rotation-after-removal still works.
  const identity = { provider: claims.provider, oauth_id: claims.oauth_id };
  const { secretKey: granterPriv, publicKey: granterPub } = await deriveNostrKey(identity, env);
  const granterIsMember = newMembers.some((m) => m.toLowerCase() === granterPub.toLowerCase());
  const grantSigningPriv = granterIsMember ? granterPriv : body.aud_id_priv;

  const grantOuts: { recipient: string; event_id: string; acks: RelayResult[] }[] = [];
  for (const recipient of newMembers) {
    const ciphertext = nip44Encrypt(epochKp.priv, grantSigningPriv, recipient);
    const grantTpl = buildKeyGrant({
      audIdPub,
      slug,
      epoch: newEpoch,
      recipientPub: recipient,
      ciphertext,
    });
    const grantSigned = signEventWithRawKey(grantTpl, grantSigningPriv);
    const out = await publishAndStore(grantSigned, env);
    grantOuts.push({ recipient, event_id: grantSigned.id, acks: out.acks });
  }

  granterPriv.fill(0);

  return jsonResponse({
    ok: true,
    epoch: newEpoch,
    aud_epoch_pub: epochKp.pub,
    aud_epoch_priv: bytesToHex(epochKp.priv),
    declaration_event_id: declSigned.id,
    grants: grantOuts,
    members: newMembers,
    pending: newPending,
  });
}

// ─── /v0/audience/publish ───────────────────────────────────────────────────

interface AudiencePublishBody {
  audience_address: string;
  aud_epoch_pub: string;
  kind: EncryptedVariantKind;
  payload: unknown;
  d_tag: string;
  alt: string;
}

function validateAudiencePublishBody(raw: Record<string, unknown>): AudiencePublishBody {
  const kind = raw.kind;
  if (typeof kind !== "number" || !ENCRYPTED_VARIANT_KINDS.includes(kind as EncryptedVariantKind)) {
    throw new AudienceValidationError(
      `kind must be one of ${ENCRYPTED_VARIANT_KINDS.join(", ")}`,
    );
  }
  if (raw.payload === undefined || typeof raw.payload !== "object" || raw.payload === null) {
    throw new AudienceValidationError("payload must be a JSON object");
  }
  return {
    audience_address: requireString(raw.audience_address, "audience_address"),
    aud_epoch_pub: requireHex64(raw.aud_epoch_pub, "aud_epoch_pub"),
    kind: kind as EncryptedVariantKind,
    payload: raw.payload,
    d_tag: requireString(raw.d_tag, "d_tag"),
    alt: requireString(raw.alt, "alt"),
  };
}

async function runAudiencePublish(
  body: AudiencePublishBody,
  claims: AuthClaims,
  env: AudienceEnv,
): Promise<Response> {
  const { audIdPub, slug } = requireAddress(body.audience_address, "audience_address");
  const closed = rejectIfClosedGuard(
    await loadAudienceStatusGuard(audIdPub, slug, env),
    "publish",
  );
  if (closed) return closed;
  const cached = await lookupDeclarationByAddress(audIdPub, slug, env);
  if (!cached) {
    return jsonError("not_found", "audience declaration not found in relay cache", 404);
  }
  if (cached.decl.epochPub !== body.aud_epoch_pub) {
    return jsonError(
      "bad_request",
      "aud_epoch_pub does not match the current declaration's fa:epoch-pubkey",
      400,
    );
  }

  // Caller's identity = publisher.
  const identity = { provider: claims.provider, oauth_id: claims.oauth_id };
  const { secretKey: publisherPriv, publicKey: publisherPub } = await deriveNostrKey(
    identity,
    env,
  );
  if (!cached.decl.members.some((m) => m.toLowerCase() === publisherPub.toLowerCase())) {
    publisherPriv.fill(0);
    return jsonError("forbidden", "publisher is not a current member of the audience", 403);
  }

  // 1. Encrypt the payload to the audience's epoch pubkey.
  const plaintext = JSON.stringify(body.payload);
  const ciphertext = nip44EncryptString(plaintext, publisherPriv, cached.decl.epochPub);

  // 2. Build the encrypted-variant rumor.
  const rumorTpl = buildEncryptedVariant({
    kind: body.kind,
    audIdPub,
    slug,
    epoch: cached.decl.epoch,
    members: cached.decl.members,
    dTag: body.d_tag,
    alt: body.alt,
    ciphertext,
  });
  const rumor = signEventWithRawKey(rumorTpl, publisherPriv);

  // 3. For each member, gift-wrap the rumor, publish the wrap, and cache it
  //    in the relay-pool DO under the recipient's giftwrap index so the same-
  //    instance inbox endpoint can read it without an external subscription.
  const wraps: { recipient: string; event_id: string; acks: RelayResult[] }[] = [];
  const id = env.RELAY_POOL.idFromName("main");
  const stub = env.RELAY_POOL.get(id);
  for (const recipient of cached.decl.members) {
    const wrapSigned: SignedEvent = giftWrapEvent(rumor, publisherPriv, recipient);
    const acks = await fanOut(wrapSigned);
    await stub.storeGiftWrap(wrapSigned, recipient).catch(() => {});
    wraps.push({ recipient, event_id: wrapSigned.id, acks });
  }

  publisherPriv.fill(0);

  return jsonResponse({
    ok: true,
    rumor_event_id: rumor.id,
    rumor_kind: rumor.kind,
    audience_address: body.audience_address,
    epoch: cached.decl.epoch,
    publisher_pubkey: publisherPub,
    member_count: cached.decl.members.length,
    gift_wraps: wraps,
  });
}

// ─── GET /v0/audience/:slug/inbox ───────────────────────────────────────────
//
// Capability-based decryption per v0.5-design.md §2.5 / PLAN-v0.5 §6 Q4.
// The flow runs entirely inside the per-request KMS-derivation window:
//
//   1. Authenticate the caller (JWT bearer); derive their identity priv via
//      KMS. The priv lives only on this request's stack — never persisted,
//      never logged.
//   2. Pull cached gift-wraps addressed to the caller from the relay-pool
//      DO. (Cross-instance gift-wraps from external relays will require a
//      subscription extension; tracked as a t15 follow-up. Same-instance
//      publish→read works today.)
//   3. For each gift-wrap, NIP-17 unwrap with the caller's priv. Discard
//      anything that fails to unwrap (not addressed to us / tampered).
//   4. Filter rumors to the requested audience slug (matching the rumor's
//      `a` tag against the caller's audience_address path param).
//   5. For each rumor, look up the matching kind:30521 grant addressed to
//      the caller for the rumor's (audience, epoch). Decrypt to get the
//      epoch private key.
//   6. NIP-44-decrypt the rumor's `content` (encrypted-variant ciphertext)
//      using the publisher's pubkey + the epoch priv. Parse JSON-LD.
//   7. Discard all key material at end of request — the GC reclaims the
//      stack and `caller_priv.fill(0)` zeroes the priv buffer explicitly.

interface InboxItem {
  event_id: string;
  kind: number;
  audience_slug: string;
  epoch: number;
  publisher_pubkey: string;
  created_at: number;
  payload: unknown;
  d_tag: string | undefined;
}

async function runInbox(
  slugFromPath: string,
  since: number | undefined,
  limit: number,
  claims: AuthClaims,
  env: AudienceEnv,
): Promise<Response> {
  const identity = { provider: claims.provider, oauth_id: claims.oauth_id };
  const { secretKey: callerPriv, publicKey: callerPub } = await deriveNostrKey(identity, env);

  try {
    const id = env.RELAY_POOL.idFromName("main");
    const stub = env.RELAY_POOL.get(id);
    const wraps = await stub.listGiftWraps(callerPub, since, limit * 4);

    // Walk wraps, attempt unwrap. Failures are silently dropped — gift-wraps
    // for other recipients land here too if a future shared-pool config
    // exists; either way unwrap fails for those.
    const items: InboxItem[] = [];
    for (const w of wraps) {
      let unwrapped;
      try {
        unwrapped = giftUnwrap(w, callerPriv);
      } catch {
        continue;
      }
      const rumor = unwrapped.rumor;
      // Filter by audience slug from the path.
      const aTag = rumor.tags.find((t) => t[0] === "a")?.[1];
      if (!aTag) continue;
      const parsedAddr = parseAudienceAddress(aTag);
      if (!parsedAddr || parsedAddr.slug !== slugFromPath) continue;

      const fa_epoch = Number(rumor.tags.find((t) => t[0] === "fa:epoch")?.[1] ?? NaN);
      if (!Number.isSafeInteger(fa_epoch)) continue;

      // Find the matching kind:30521 key-grant addressed to us for this audience+epoch.
      const grantD = `${parsedAddr.slug}:${fa_epoch}:${callerPub}`;
      // The grant could be signed by aud_id (founding) or any current member.
      // Try aud_id first, then walk the declaration's member list.
      let grantEvent: NostrEvent | null = await stub.getObject(30521, parsedAddr.pubkey, grantD);
      if (!grantEvent) {
        // Fall back: scan members of the current declaration as potential granters.
        const decl = await stub.getObject(30520, parsedAddr.pubkey, parsedAddr.slug);
        if (decl) {
          const members = decl.tags.filter((t) => t[0] === "p").map((t) => t[1]!);
          for (const m of members) {
            const candidate = await stub.getObject(30521, m, grantD);
            if (candidate) {
              grantEvent = candidate;
              break;
            }
          }
        }
      }
      if (!grantEvent) continue;

      let epochPrivBytes: Uint8Array;
      try {
        epochPrivBytes = nip44Decrypt(grantEvent.content, callerPriv, grantEvent.pubkey);
      } catch {
        continue;
      }
      if (epochPrivBytes.length !== 32) continue;

      let plaintext: string;
      try {
        plaintext = nip44DecryptString(rumor.content, epochPrivBytes, unwrapped.publisherPub);
      } catch {
        // Defensive zero-fill the leaked epoch priv on this branch too.
        epochPrivBytes.fill(0);
        continue;
      }
      let parsedPayload: unknown = plaintext;
      try {
        parsedPayload = JSON.parse(plaintext);
      } catch {
        // payload wasn't JSON — leave as string.
      }
      epochPrivBytes.fill(0);

      const dTag = rumor.tags.find((t) => t[0] === "d")?.[1];
      items.push({
        event_id: rumor.id,
        kind: rumor.kind,
        audience_slug: parsedAddr.slug,
        epoch: fa_epoch,
        publisher_pubkey: unwrapped.publisherPub,
        created_at: rumor.created_at,
        payload: parsedPayload,
        d_tag: dTag,
      });
      if (items.length >= limit) break;
    }
    items.sort((a, b) => a.created_at - b.created_at);

    return jsonResponse({
      ok: true,
      audience_slug: slugFromPath,
      reader_pubkey: callerPub,
      since: since ?? null,
      limit,
      items,
    });
  } finally {
    callerPriv.fill(0);
  }
}

// ─── router ─────────────────────────────────────────────────────────────────

export async function handleAudienceRequest(
  request: Request,
  env: AudienceEnv,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // GET /v0/audience/:slug/declaration?aud_id_pub=<hex> — public read for the
  // current cached kind:30520 declaration. No auth: declarations are public
  // Nostr events on the relay pool, so leaking content is no leak. Used by
  // the Sonata Studio plugin's "join" flow to discover the audience identity
  // before it has membership (chicken-and-egg with the SSE stream).
  const declMatch = path.match(/^\/v0\/audience\/([A-Za-z0-9-]+)\/declaration$/);
  if (declMatch) {
    if (request.method !== "GET") {
      return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
    }
    const slug = declMatch[1]!;
    const audIdPubRaw = url.searchParams.get("aud_id_pub");
    if (!audIdPubRaw || !HEX64.test(audIdPubRaw)) {
      return jsonError("bad_request", "aud_id_pub query param must be 32-byte hex", 400);
    }
    const audIdPub = audIdPubRaw.toLowerCase();
    const cached = await lookupDeclarationByAddress(audIdPub, slug, env);
    if (!cached) {
      return jsonError("not_found", "audience declaration not found", 404);
    }
    return jsonResponse({
      ok: true,
      audience_address: audienceAddress(audIdPub, slug),
      declaration: cached.event,
    });
  }

  // /v0/audience/:slug/inbox is a GET path; everything else is POST.
  const inboxMatch = path.match(/^\/v0\/audience\/([A-Za-z0-9-]+)\/inbox$/);
  if (inboxMatch) {
    if (request.method !== "GET") {
      return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
    }
    const claims = await authenticate(request, env);
    if (claims instanceof Response) return claims;
    const slug = inboxMatch[1]!;
    const since = url.searchParams.get("since");
    const limit = url.searchParams.get("limit");
    const sinceParsed = since ? Number(since) : undefined;
    const limitParsed = limit ? Math.min(Math.max(Number(limit) || 50, 1), 200) : 50;
    return runInbox(slug, sinceParsed, limitParsed, claims, env);
  }

  if (request.method !== "POST") {
    return jsonError("method_not_allowed", `${request.method} not allowed`, 405);
  }

  const claims = await authenticate(request, env);
  if (claims instanceof Response) return claims;

  // Per-route rate limit (publish-style endpoints are heavier than score).
  const rateKey = `${claims.provider}:${claims.oauth_id}`;
  const rl = rateLimitCheck(rateKey);
  if (!rl.ok) {
    return jsonError("rate_limited", "max 60 publishes/hour per identity", 429, {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  let raw: Record<string, unknown>;
  try {
    raw = await parseJsonBody(request);
  } catch (err) {
    if (err instanceof AudienceValidationError) return jsonError("bad_request", err.message, 400);
    throw err;
  }

  try {
    if (path === "/v0/audience/create") {
      return await runCreate(validateCreateBody(raw), claims, env);
    }
    if (path === "/v0/audience/invite") {
      return await runInvite(validateInviteBody(raw), env);
    }
    if (path === "/v0/audience/grant") {
      return await runGrant(validateGrantBody(raw), claims, env);
    }
    if (path === "/v0/audience/claim") {
      return await runClaim(validateClaimBody(raw), env);
    }
    if (path === "/v0/audience/rotate") {
      return await runRotate(validateRotateBody(raw), claims, env);
    }
    if (path === "/v0/audience/process-claims") {
      return await runProcessClaims(validateProcessClaimsBody(raw), claims, env);
    }
    if (path === "/v0/audience/list-pending-claims") {
      return await runListPendingClaims(validateListPendingClaimsBody(raw), env);
    }
    if (path === "/v0/audience/list-my") {
      return await runListMy(claims, env);
    }
    if (path === "/v0/audience/publish") {
      return await runAudiencePublish(validateAudiencePublishBody(raw), claims, env);
    }
    return jsonError("not_found", `no handler for ${path}`, 404);
  } catch (err) {
    if (err instanceof AudienceValidationError) {
      return jsonError("bad_request", err.message, 400);
    }
    return jsonError(
      "internal_error",
      err instanceof Error ? err.message : "audience request failed",
      500,
    );
  }
}

// Re-exports for tests + the worked-example fixture builder.
export {
  buildAudienceDeclaration,
  buildKeyGrant,
  buildAudienceClaim,
  buildEncryptedVariant,
  audienceAddress,
};
export {
  giftUnwrap,
  nip44Decrypt,
  nip44DecryptString,
};
export {
  validateAudienceEvent,
  validateKeyGrantEvent,
  validateAudienceClaimEvent,
  validateEncryptedVariantEvent,
  validateGiftWrapEvent,
};

// Re-exports for the MCP shim that wraps these routes as JSON-RPC tools.
// Each accepts a parsed body and returns a Response (the MCP layer reads the
// body back out via .json()). Auth is handled by the MCP session.
export const __audienceRoutes = {
  runCreate,
  runInvite,
  runGrant,
  runClaim,
  runRotate,
  runAudiencePublish,
  runProcessClaims,
  runListPendingClaims,
  runListMy,
  runInbox,
  validateCreateBody,
  validateInviteBody,
  validateGrantBody,
  validateClaimBody,
  validateRotateBody,
  validateAudiencePublishBody,
  validateProcessClaimsBody,
  validateListPendingClaimsBody,
};
