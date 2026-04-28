// Pure-function parsers for kind:30506 (Score) and kind:30507 (Comment) content
// payloads, per SPEC-phase3-credibility.md §§2–3.
//
// These functions are the single source of truth for the *shape* of credibility
// payloads. They are deliberately I/O-free, dependency-free, and unaware of any
// methodology (no aggregation, no pairing logic). Validators and publish helpers
// wrap these.
//
// Result discipline: every parser returns `{ ok: true, value }` or
// `{ ok: false, error }` — never throws on invalid input, never returns
// `undefined`.

export const FA_CONTEXT_V0 = "https://4a4.ai/ns/v0" as const;

export interface ScoreContent {
  "@context": typeof FA_CONTEXT_V0;
  "@type": "Score";
  value: number;
  target: { "@id": string };
  tier?: string;
  preamble?: string;
}

export interface CommentContent {
  "@context": typeof FA_CONTEXT_V0;
  "@type": "Comment";
  body: string;
  target: { "@id": string };
  intent?: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// --- type guards --------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

function isOptionalString(x: unknown): x is string | undefined {
  return x === undefined || typeof x === "string";
}

function isTarget(x: unknown): x is { "@id": string } {
  if (!isPlainObject(x)) return false;
  const id = x["@id"];
  return isNonEmptyString(id) && id.startsWith("nostr:");
}

export function isScoreContent(x: unknown): x is ScoreContent {
  if (!isPlainObject(x)) return false;
  if (x["@context"] !== FA_CONTEXT_V0) return false;
  if (x["@type"] !== "Score") return false;
  if (!isFiniteNumber(x.value)) return false;
  if (x.value < 0 || x.value > 1) return false;
  if (!isTarget(x.target)) return false;
  if (!isOptionalString(x.tier)) return false;
  if (!isOptionalString(x.preamble)) return false;
  return true;
}

export function isCommentContent(x: unknown): x is CommentContent {
  if (!isPlainObject(x)) return false;
  if (x["@context"] !== FA_CONTEXT_V0) return false;
  if (x["@type"] !== "Comment") return false;
  if (typeof x.body !== "string") return false;
  if (!isTarget(x.target)) return false;
  if (!isOptionalString(x.intent)) return false;
  return true;
}

// --- parsers ------------------------------------------------------------------

function parseJson(content: string): ParseResult<unknown> {
  if (typeof content !== "string") {
    return { ok: false, error: "content must be a string" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `content is not valid JSON: ${msg}` };
  }
  return { ok: true, value: parsed };
}

function checkContext(obj: Record<string, unknown>): string | null {
  const ctx = obj["@context"];
  if (ctx === undefined) return "missing @context";
  if (ctx !== FA_CONTEXT_V0) {
    return `@context must equal "${FA_CONTEXT_V0}"`;
  }
  return null;
}

function checkTarget(obj: Record<string, unknown>): string | null {
  const target = obj.target;
  if (target === undefined) return "missing target";
  if (!isPlainObject(target)) return "target must be an object";
  const id = target["@id"];
  if (id === undefined) return "target.@id is required";
  if (typeof id !== "string") return "target.@id must be a string";
  if (id.length === 0) return "target.@id must be non-empty";
  if (!id.startsWith("nostr:")) {
    return 'target.@id must start with "nostr:"';
  }
  return null;
}

export function parseScoreContent(
  content: string,
): ParseResult<ScoreContent> {
  const json = parseJson(content);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) {
    return { ok: false, error: "content must be a JSON object" };
  }
  const obj = json.value;

  const ctxErr = checkContext(obj);
  if (ctxErr) return { ok: false, error: ctxErr };

  if (obj["@type"] !== "Score") {
    return { ok: false, error: '@type must equal "Score"' };
  }

  const value = obj.value;
  if (value === undefined) return { ok: false, error: "missing value" };
  if (typeof value !== "number") {
    return { ok: false, error: "value must be a number, not a string" };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, error: "value must be a finite number" };
  }
  if (value < 0 || value > 1) {
    return { ok: false, error: "value must be in the closed interval [0, 1]" };
  }

  const targetErr = checkTarget(obj);
  if (targetErr) return { ok: false, error: targetErr };

  if (obj.tier !== undefined && typeof obj.tier !== "string") {
    return { ok: false, error: "tier must be a string when present" };
  }
  if (obj.preamble !== undefined && typeof obj.preamble !== "string") {
    return { ok: false, error: "preamble must be a string when present" };
  }

  if (!isScoreContent(obj)) {
    return { ok: false, error: "content does not match Score schema" };
  }
  return { ok: true, value: obj };
}

export function parseCommentContent(
  content: string,
): ParseResult<CommentContent> {
  const json = parseJson(content);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) {
    return { ok: false, error: "content must be a JSON object" };
  }
  const obj = json.value;

  const ctxErr = checkContext(obj);
  if (ctxErr) return { ok: false, error: ctxErr };

  if (obj["@type"] !== "Comment") {
    return { ok: false, error: '@type must equal "Comment"' };
  }

  const body = obj.body;
  if (body === undefined) return { ok: false, error: "missing body" };
  if (typeof body !== "string") {
    return { ok: false, error: "body must be a string" };
  }

  const targetErr = checkTarget(obj);
  if (targetErr) return { ok: false, error: targetErr };

  if (obj.intent !== undefined && typeof obj.intent !== "string") {
    return { ok: false, error: "intent must be a string when present" };
  }

  if (!isCommentContent(obj)) {
    return { ok: false, error: "content does not match Comment schema" };
  }
  return { ok: true, value: obj };
}
