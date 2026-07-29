// Org + key-grant builders behind POST /v0/publish/{org,grant,grant_revoke}.
//
// Evenflow's org layer (phase 16) publishes three event flavors:
//   kind 30520 — org declaration: an audience-family event carrying org
//                identity (slug, kind, display name) in tags and the
//                mutable profile surface (avatar, bio, admins) in content.
//   kind 30521 — key-grant: role assignment for a recipient against an org
//                or board target. Parameterized-replaceable on
//                (target, recipient) so a re-grant with a new role replaces
//                the old one instead of accumulating.
//   kind 30521 — grant revocation: same kind, tagged ["revokes", <id>] so
//                aggregators tombstone the referenced grant.
//
// Standalone module (no Workers-runtime imports) so it unit-tests like
// profile-builder. Recipients are allowed to be pubkeys that have never
// signed in — including Evenflow's `provider:oauth_id` composite stand-ins —
// because grants intentionally front-run first sign-in; reconciliation
// happens when the recipient's key first derives.

import type { EventTemplate } from "./kms";

export const KIND_ORG = 30520;
export const KIND_GRANT = 30521;

export const ORG_KINDS = ["personal", "team"] as const;
export const GRANT_SCOPES = ["org", "board"] as const;
export const GRANT_ROLES = ["owner", "admin", "member", "contributor", "viewer"] as const;

export const ORG_SLUG_MAX = 64;
export const ORG_NAME_MAX = 128;
export const ORG_BIO_MAX = 4000;
export const ORG_AVATAR_URL_MAX = 512;
export const ORG_ADMINS_MAX = 64;

const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const CONTEXT_URL = "https://4a4.ai/ns/v0";
const HEX64 = /^[0-9a-f]{64}$/i;

export class OrgValidationError extends Error {}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OrgValidationError(`${field} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new OrgValidationError(`${field} exceeds ${max} characters`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, max);
}

function requireOneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlyArray<T>,
): T {
  if (typeof value !== "string" || !(allowed as ReadonlyArray<string>).includes(value)) {
    throw new OrgValidationError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * A grant recipient is either a real hex64 Nostr pubkey or Evenflow's
 * `provider:oauth_id` composite stand-in for users whose key has not
 * derived yet (never signed in). Both are legal on purpose.
 */
function requireRecipient(value: unknown, field: string): string {
  const s = requireString(value, field, 256);
  if (HEX64.test(s)) return s.toLowerCase();
  if (/^[a-z0-9_-]+:.+$/i.test(s)) return s;
  throw new OrgValidationError(`${field} must be a hex64 pubkey or provider:oauth_id composite`);
}

export interface BuiltOrgEvent {
  template: EventTemplate;
  dTag: string;
  addressable: boolean;
}

// ─── kind 30520 — org declaration ───────────────────────────────────────────

export interface OrgBody {
  slug?: string;
  display_name?: string;
  kind?: string;
  avatar_url?: string;
  bio?: string;
  admins?: string[];
}

export function buildOrg(body: OrgBody): BuiltOrgEvent {
  const slug = requireString(body.slug, "slug", ORG_SLUG_MAX);
  if (!ORG_SLUG_RE.test(slug)) {
    throw new OrgValidationError("slug must be lowercase alphanumeric with hyphens");
  }
  const displayName = requireString(body.display_name, "display_name", ORG_NAME_MAX);
  const orgKind = requireOneOf(body.kind, "kind", ORG_KINDS);
  const avatarUrl = optionalString(body.avatar_url, "avatar_url", ORG_AVATAR_URL_MAX);
  if (avatarUrl !== undefined && !avatarUrl.startsWith("https://")) {
    throw new OrgValidationError("avatar_url must be an https:// URL");
  }
  const bio = optionalString(body.bio, "bio", ORG_BIO_MAX);

  let admins: string[] = [];
  if (body.admins !== undefined) {
    if (!Array.isArray(body.admins)) {
      throw new OrgValidationError("admins must be an array of pubkeys");
    }
    if (body.admins.length > ORG_ADMINS_MAX) {
      throw new OrgValidationError(`admins exceeds ${ORG_ADMINS_MAX} entries`);
    }
    admins = body.admins.map((a, i) => requireRecipient(a, `admins[${i}]`));
  }

  const payload: Record<string, unknown> = {};
  if (avatarUrl !== undefined) payload["avatar_url"] = avatarUrl;
  if (bio !== undefined) payload["bio"] = bio;
  payload["admins"] = admins;

  return {
    template: {
      kind: KIND_ORG,
      created_at: nowSec(),
      tags: [
        ["d", slug],
        ["type", "org"],
        ["slug", slug],
        ["kind", orgKind],
        ["name", displayName],
        ["alt", `Org: ${truncate(displayName, 140)}`],
        ["fa:context", CONTEXT_URL],
      ],
      content: JSON.stringify(payload),
    },
    dTag: slug,
    addressable: true,
  };
}

// ─── kind 30521 — key-grant ─────────────────────────────────────────────────

export interface GrantBody {
  recipient?: string;
  role?: string;
  scope?: string;
  target?: string;
}

export function buildGrant(body: GrantBody): BuiltOrgEvent {
  const recipient = requireRecipient(body.recipient, "recipient");
  const role = requireOneOf(body.role, "role", GRANT_ROLES);
  const scope = requireOneOf(body.scope, "scope", GRANT_SCOPES);
  // target is `<org_slug>` for scope=org, `<org_slug>/<board_slug>` for
  // scope=board — validated as shape, not existence (the gateway has no
  // Evenflow board table; existence is Evenflow's concern).
  const target = requireString(body.target, "target", ORG_SLUG_MAX * 2 + 1);
  const targetParts = target.split("/");
  const partsOk =
    (scope === "org" && targetParts.length === 1) ||
    (scope === "board" && targetParts.length === 2);
  if (!partsOk || targetParts.some((p) => !ORG_SLUG_RE.test(p))) {
    throw new OrgValidationError(
      scope === "org"
        ? "target must be <org_slug> for scope=org"
        : "target must be <org_slug>/<board_slug> for scope=board",
    );
  }

  // Replaceable identity is (target, recipient): one live grant per person
  // per target. Role changes republish the same address.
  const dTag = `${target}/${recipient}`;

  // Relays enforce hex64 on `p` tags (fixed-size), so only real pubkeys ride
  // one; composite provider:oauth_id stand-ins (recipients who have never
  // signed in) carry `fa:recipient` instead. Reconciliation on first sign-in
  // re-grants against the derived hex key.
  const recipientTag: string[] = HEX64.test(recipient)
    ? ["p", recipient]
    : ["fa:recipient", recipient];

  return {
    template: {
      kind: KIND_GRANT,
      created_at: nowSec(),
      tags: [
        ["d", dTag],
        recipientTag,
        ["role", role],
        ["scope", scope],
        ["target", target],
        ["alt", `Key-grant: ${role} on ${truncate(target, 100)}`],
        ["fa:context", CONTEXT_URL],
      ],
      content: "",
    },
    dTag,
    addressable: true,
  };
}

// ─── kind 30521 — grant revocation ──────────────────────────────────────────

export interface GrantRevokeBody {
  grant_event_id?: string;
}

export function buildGrantRevoke(body: GrantRevokeBody): BuiltOrgEvent {
  const grantEventId = requireString(body.grant_event_id, "grant_event_id", 64);
  if (!HEX64.test(grantEventId)) {
    throw new OrgValidationError("grant_event_id must be a 64-char hex event id");
  }
  const id = grantEventId.toLowerCase();
  const dTag = `revoke/${id}`;

  return {
    template: {
      kind: KIND_GRANT,
      created_at: nowSec(),
      tags: [
        ["d", dTag],
        ["revokes", id],
        ["e", id],
        ["alt", `Key-grant revocation of ${id.slice(0, 16)}…`],
        ["fa:context", CONTEXT_URL],
      ],
      content: "",
    },
    dTag,
    addressable: true,
  };
}
