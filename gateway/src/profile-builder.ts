// Kind-0 (NIP-01 user metadata) builder behind POST /v0/publish/profile.
//
// Standalone module (no Workers-runtime imports) so it unit-tests like the
// other validators. Privacy posture: only the four user-chosen fields are
// read from the body; anything else — in particular a `login` field
// carrying the caller's JWT email — is ignored, so server-known PII can
// never leak into the substrate unless the user typed it into a profile
// field themselves.

import type { EventTemplate } from "./kms";

// Field caps. Violations reject with 400 — never truncate silently.
export const PROFILE_NAME_MAX = 64;
export const PROFILE_DISPLAY_NAME_MAX = 128;
export const PROFILE_PICTURE_MAX = 512;
export const PROFILE_ABOUT_MAX = 4000;

const KIND_PROFILE = 0;

export class ProfileValidationError extends Error {}

export interface ProfileBody {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
}

export interface BuiltProfileEvent {
  template: EventTemplate;
  dTag: string;
  addressable: boolean;
}

function optionalCappedString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ProfileValidationError(`${field} must be a string`);
  if (value.length > max) {
    throw new ProfileValidationError(`${field} exceeds ${max} characters`);
  }
  return value;
}

export function buildProfile(body: ProfileBody): BuiltProfileEvent {
  // Standard Nostr kind 0 — content is the metadata JSON, no tags,
  // replaceable (not parameterized; no d-tag).
  const payload: Record<string, string> = {};
  const name = optionalCappedString(body.name, "name", PROFILE_NAME_MAX);
  if (name !== undefined) payload["name"] = name;
  const displayName = optionalCappedString(body.display_name, "display_name", PROFILE_DISPLAY_NAME_MAX);
  if (displayName !== undefined) payload["display_name"] = displayName;
  const picture = optionalCappedString(body.picture, "picture", PROFILE_PICTURE_MAX);
  if (picture !== undefined) {
    if (!picture.startsWith("https://")) {
      throw new ProfileValidationError("picture must be an https:// URL");
    }
    payload["picture"] = picture;
  }
  const about = optionalCappedString(body.about, "about", PROFILE_ABOUT_MAX);
  if (about !== undefined) payload["about"] = about;

  return {
    template: {
      kind: KIND_PROFILE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(payload),
    },
    dTag: "",
    addressable: false,
  };
}
