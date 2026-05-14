// 4A MCP/SSE adapter — handler for mcp.4a4.ai.
//
// Implements the MCP HTTP+SSE transport:
//   GET  /sse                          — opens a persistent SSE stream and emits an
//                                        initial `event: endpoint` pointing at the
//                                        per-session POST URL. JSON-RPC responses are
//                                        delivered back as SSE `message` events.
//   POST /messages?sessionId=<id>      — JSON-RPC 2.0 client→server messages. Returns
//                                        202 Accepted; the response is delivered over
//                                        the matching SSE stream.
//
// Sessions live in a singleton McpHub Durable Object so that the GET /sse and
// POST /messages requests — which the CF runtime may route to different worker
// isolates — see the same in-memory session map.

import { DurableObject } from "cloudflare:workers";
import pkg from "../../package.json";
import { verifyJwt, type AuthClaims } from "./auth";
import { handleCredibility, normalizePubkey } from "./credibility";
import { runPublish, type Kind as PublishKind, type PublishEnv } from "./publish";
import type { NostrEvent, QueryFilter, RelayPool } from "./relay-pool";
import {
  runScore,
  validateScoreBody,
  ScoreValidationError,
  type ScoreEnv,
} from "./score";
import {
  runComment,
  validateCommentBody,
  CommentValidationError,
  type CommentEnv,
} from "./comment";
import { __audienceRoutes, type AudienceEnv } from "./audience";

interface McpEnv extends PublishEnv, ScoreEnv, CommentEnv, AudienceEnv {
  RELAY_POOL: DurableObjectNamespace<RelayPool>;
  MCP_HUB: DurableObjectNamespace<McpHub>;
}

const SERVER_NAME = "4a-gateway";
const SERVER_VERSION = (pkg as { version: string }).version;
const PROTOCOL_VERSION = "2024-11-05";
const HEARTBEAT_MS = 15_000;

const KIND_BY_NAME: Record<string, number> = {
  observation: 30500,
  claim: 30501,
  entity: 30502,
  relation: 30503,
  commons: 30504,
};
const VALID_KINDS = new Set(Object.values(KIND_BY_NAME));

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

interface Session {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
  heartbeat: ReturnType<typeof setInterval>;
  // Populated when the SSE handshake carries an `Authorization: Bearer <jwt>`
  // header, or when the client later calls the `auth_4a` tool. Required for
  // any of the publish_* / attest write tools.
  claims?: AuthClaims;
}

// Sessions live on the McpHub DO instance below — no module-scope storage.

interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  examples: { name: string; arguments: Record<string, unknown> }[];
}

const TOOLS: ToolDef[] = [
  {
    name: "query_4a",
    description:
      "Query verified 4A events from the gateway's relay pool. Filters compose with AND. Returns the matching events plus a count and queriedAt timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        about: {
          type: "string",
          description: "Match events whose subject (a-tag, about-tag, or @id) equals this URI/address",
        },
        kind: {
          type: "string",
          enum: Object.keys(KIND_BY_NAME),
          description: "4A object kind name",
        },
        topic: { type: "string", description: "Topic slug (#t tag value)" },
        author: {
          type: "string",
          description: "Author pubkey (64-char hex or npub1... bech32)",
        },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    examples: [
      { name: "query_4a", arguments: { kind: "claim", topic: "rails", limit: 20 } },
      { name: "query_4a", arguments: { author: "npub1examplepubkey..." } },
    ],
  },
  {
    name: "get_4a_object",
    description:
      "Look up a single addressable 4A object by (kind, pubkey, d). Returns the latest event for that triple, or null when absent.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          oneOf: [
            { type: "string", enum: Object.keys(KIND_BY_NAME) },
            { type: "integer", enum: Array.from(VALID_KINDS) },
          ],
          description: "4A kind name (e.g. 'entity') or numeric kind (30500..30504)",
        },
        pubkey: { type: "string", description: "Author pubkey (hex or npub)" },
        d: { type: "string", description: "Addressable d-tag value" },
      },
      required: ["kind", "pubkey", "d"],
      additionalProperties: false,
    },
    examples: [
      {
        name: "get_4a_object",
        arguments: { kind: "entity", pubkey: "npub1examplepubkey...", d: "next.js" },
      },
    ],
  },
  {
    name: "get_credibility",
    description:
      "Fetch NIP-85 trusted assertions about a pubkey from a configured aggregator (default: nostr.band). Returns published scores per namespace.",
    inputSchema: {
      type: "object",
      properties: {
        pubkey: { type: "string", description: "Subject pubkey (hex or npub)" },
      },
      required: ["pubkey"],
      additionalProperties: false,
    },
    examples: [{ name: "get_credibility", arguments: { pubkey: "npub1examplepubkey..." } }],
  },
  {
    name: "list_commons",
    description: "List every kind-30504 Commons declaration the gateway has indexed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    examples: [{ name: "list_commons", arguments: {} }],
  },
  {
    name: "auth_4a",
    description:
      "Attach a 4A bearer JWT to this MCP session so the publish_* and attest tools can sign on your behalf. Use only when your MCP client cannot pass an Authorization header on the /sse handshake. Obtain the JWT by completing the OAuth flow at https://api.4a4.ai/auth/github/start.",
    inputSchema: {
      type: "object",
      properties: {
        jwt: { type: "string", description: "4A-issued JWT (HS256) from /auth/github/callback" },
      },
      required: ["jwt"],
      additionalProperties: false,
    },
    examples: [{ name: "auth_4a", arguments: { jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...." } }],
  },
  {
    name: "publish_observation",
    description:
      "Publish a 4A Observation event signed by your custodial Nostr key. Use when the user makes a verifiable claim about a software project, library, person, or organization that's worth committing to the public knowledge graph. Provide 'about' (URI of subject), 'property' (the aspect you're observing), 'value' (the claim itself), and 'derivedFrom' (citation URLs). Requires an authenticated session — see auth_4a.",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string", description: "Subject URI or kind:pubkey:d address" },
        property: { type: "string", description: "Aspect being observed (e.g. 'license', 'maintainer-status')" },
        value: { type: "string", description: "The observed value" },
        derivedFrom: {
          type: "array",
          items: { type: "string" },
          description: "Citation URIs supporting the observation",
        },
        topic: { type: "array", items: { type: "string" }, description: "Topic slugs (#t tags)" },
        dSlug: { type: "string", description: "Override the auto-generated d-tag" },
      },
      required: ["about", "property", "value"],
      additionalProperties: false,
    },
    examples: [
      {
        name: "publish_observation",
        arguments: {
          about: "https://github.com/rails/rails",
          property: "primary-language",
          value: "Ruby",
          derivedFrom: ["https://github.com/rails/rails/blob/main/Gemfile"],
        },
      },
    ],
  },
  {
    name: "publish_claim",
    description:
      "Publish a 4A Claim event — a textual assertion with optional citations, signed by your custodial Nostr key. Use for prose-shaped statements about a subject (review, summary, evaluation). Provide 'about' (URI of subject), 'appearance' (the claim text), and optional 'citation' URIs. Requires an authenticated session — see auth_4a.",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string", description: "Subject URI or kind:pubkey:d address" },
        appearance: { type: "string", description: "The claim text as it should appear" },
        citation: {
          type: "array",
          items: { type: "string" },
          description: "Citation URIs (URLs or kind:pubkey:d addresses)",
        },
        topic: { type: "array", items: { type: "string" }, description: "Topic slugs (#t tags)" },
        dSlug: { type: "string", description: "Override the auto-generated d-tag" },
      },
      required: ["about", "appearance"],
      additionalProperties: false,
    },
    examples: [
      {
        name: "publish_claim",
        arguments: {
          about: "https://github.com/sveltejs/svelte",
          appearance: "Svelte 5 runes simplify reactive state management compared to stores.",
          citation: ["https://svelte.dev/blog/runes"],
        },
      },
    ],
  },
  {
    name: "publish_entity",
    description:
      "Publish a 4A Entity declaration — registers a software project, person, or organization in the knowledge graph under your custodial Nostr key. Provide 'canonicalId' (the canonical URI), 'name', and optional 'description', 'codeRepository', 'programmingLanguage', and additional 'types'. Requires an authenticated session — see auth_4a.",
    inputSchema: {
      type: "object",
      properties: {
        canonicalId: { type: "string", description: "Canonical URI for the entity" },
        name: { type: "string", description: "Human-readable name" },
        description: { type: "string", description: "Short description" },
        codeRepository: { type: "string", description: "Repository URL (for software projects)" },
        programmingLanguage: { type: "string", description: "Primary language (for software projects)" },
        types: {
          type: "array",
          items: { type: "string" },
          description: "Additional schema.org types beyond 'Thing' (e.g. 'SoftwareSourceCode', 'Organization')",
        },
        topic: { type: "array", items: { type: "string" }, description: "Topic slugs (#t tags)" },
        dSlug: { type: "string", description: "Override the auto-generated d-tag" },
      },
      required: ["canonicalId", "name"],
      additionalProperties: false,
    },
    examples: [
      {
        name: "publish_entity",
        arguments: {
          canonicalId: "https://github.com/sveltejs/svelte",
          name: "Svelte",
          description: "A web UI framework that compiles to vanilla JS at build time.",
          codeRepository: "https://github.com/sveltejs/svelte",
          programmingLanguage: "TypeScript",
          types: ["SoftwareSourceCode"],
        },
      },
    ],
  },
  {
    name: "publish_relation",
    description:
      "Publish a 4A Relation event — asserts a typed relationship between two entities (e.g. 'maintainer', 'depends-on', 'employs'), signed by your custodial Nostr key. Provide 'subject' URI, 'object' URI, and 'roleName'. Requires an authenticated session — see auth_4a.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Subject URI (the actor of the role)" },
        object: { type: "string", description: "Object URI (the target of the role)" },
        roleName: { type: "string", description: "Role name (e.g. 'maintainer', 'depends-on')" },
        startDate: { type: "string", description: "ISO date the relation began (optional)" },
        endDate: { type: "string", description: "ISO date the relation ended (optional)" },
        dSlug: { type: "string", description: "Override the auto-generated d-tag" },
      },
      required: ["subject", "object", "roleName"],
      additionalProperties: false,
    },
    examples: [
      {
        name: "publish_relation",
        arguments: {
          subject: "https://github.com/dhh",
          object: "https://github.com/rails/rails",
          roleName: "maintainer",
        },
      },
    ],
  },
  {
    name: "score",
    description:
      "Publish a 4A Score (kind:30506) and its paired rationale Comment (kind:30507) atomically — mirrors POST /v0/score. The score expresses a numeric judgment in [0,1] about a target event; the rationale comment justifies it per SPEC §Credibility events. Both events are signed by your custodial Nostr key. Requires an authenticated session — see auth_4a.",
    inputSchema: {
      type: "object",
      properties: {
        target_event_id: {
          type: "string",
          description: "64-char hex event id of the target being scored",
        },
        value: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Numeric score in [0, 1]",
        },
        rationale: {
          type: "string",
          description: "Justifying text published as a paired kind:30507 Comment",
        },
        tier: { type: "string", description: "Optional tier label (per-aggregator vocabulary)" },
        intent: {
          type: "string",
          description: "Optional intent for the rationale comment (default: 'justify')",
        },
        target_a_tag: {
          type: "string",
          description: "Optional addressable a-tag of the target (kind:pubkey:d)",
        },
      },
      required: ["target_event_id", "value", "rationale"],
      additionalProperties: false,
    },
    examples: [
      {
        name: "score",
        arguments: {
          target_event_id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          value: 0.85,
          rationale: "Citations are well-sourced and the claim is internally consistent.",
        },
      },
    ],
  },
  {
    name: "comment",
    description:
      "Publish a 4A Comment (kind:30507) on a target event — mirrors POST /v0/comment. Use to comment on claims, scores, or other comments without producing a paired score. Set reply_to_event_id to thread under a parent comment (NIP-10 markers applied). Requires an authenticated session — see auth_4a.",
    inputSchema: {
      type: "object",
      properties: {
        target_event_id: {
          type: "string",
          description: "64-char hex event id of the target being commented on",
        },
        body: { type: "string", description: "Comment body (non-empty)" },
        intent: {
          type: "string",
          description: "Optional intent label (e.g. 'justify', 'challenge', 'context')",
        },
        reply_to_event_id: {
          type: "string",
          description: "Optional 64-char hex parent comment id when threading a reply",
        },
        target_a_tag: {
          type: "string",
          description: "Optional addressable a-tag of the target (kind:pubkey:d)",
        },
      },
      required: ["target_event_id", "body"],
      additionalProperties: false,
    },
    examples: [
      {
        name: "comment",
        arguments: {
          target_event_id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          body: "This claim conflicts with the cited source — see paragraph 3.",
          intent: "challenge",
        },
      },
    ],
  },
  {
    name: "attest",
    description:
      "Publish a NIP-32 label (kind 1985) attesting to a 4A subject under a namespaced predicate. Use for credibility assertions, stamps, or sponsor declarations. 'subject' is a 64-char hex pubkey or event id; 'namespace' must match 4a.credibility.<domain> | 4a.stamp.<source> | 4a.sponsor; 'value' is optional and namespace-scoped. Requires an authenticated session — see auth_4a.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "64-char hex pubkey or event id" },
        namespace: {
          type: "string",
          description: "Namespace: 4a.credibility.<domain> | 4a.stamp.<source> | 4a.sponsor",
        },
        value: { type: "string", description: "Optional namespace-scoped value (defaults sensibly)" },
      },
      required: ["subject", "namespace"],
      additionalProperties: false,
    },
    examples: [
      {
        name: "attest",
        arguments: {
          subject: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          namespace: "4a.credibility.security-review",
          value: "passed",
        },
      },
    ],
  },
  // ── v0.5 audience tools ─────────────────────────────────────────────────
  {
    name: "audience_create",
    description:
      "Create a new private 4A audience. Generates aud_id + aud_epoch_1, publishes the kind:30520 declaration, and issues a founding kind:30521 to the calling user. Returns the audience_address, the audience identity priv (gateway does NOT persist — caller stores), and the first epoch keypair.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Audience slug (alphanum + hyphens, e.g. 'team-design')" },
        name: { type: "string", description: "Human-readable name" },
        description: { type: "string", description: "One or two sentences" },
      },
      required: ["slug", "name"],
      additionalProperties: false,
    },
    examples: [{ name: "audience_create", arguments: { slug: "team-design", name: "team-design", description: "Design notes shared with Allison." } }],
  },
  {
    name: "audience_invite",
    description: "Generate a one-shot 4ainv1… invite key, republish the audience declaration with a new fa:pending tag, and return the s4a:// + claim.4a4.ai URLs to share off-band.",
    inputSchema: {
      type: "object",
      properties: {
        audience_address: { type: "string", description: "30520:<aud_id-hex>:<slug>" },
        aud_id_priv: { type: "string", description: "Audience identity priv (32-byte hex; from audience_create)" },
        ttl_seconds: { type: "integer", minimum: 60, default: 604800 },
      },
      required: ["audience_address", "aud_id_priv"],
      additionalProperties: false,
    },
    examples: [],
  },
  {
    name: "audience_grant",
    description: "Issue a kind:30521 key-grant directly to a known recipient pubkey (no claim flow). Republishes the declaration to add the recipient to the public roster.",
    inputSchema: {
      type: "object",
      properties: {
        audience_address: { type: "string" },
        aud_id_priv: { type: "string" },
        aud_epoch_priv: { type: "string", description: "Current epoch private key" },
        recipient_pubkey: { type: "string" },
      },
      required: ["audience_address", "aud_id_priv", "aud_epoch_priv", "recipient_pubkey"],
      additionalProperties: false,
    },
    examples: [],
  },
  {
    name: "audience_claim",
    description: "Sign and publish a kind:30522 audience-claim with the invite_priv decoded from the 4ainv1… string. Used by the claim page after OAuth.",
    inputSchema: {
      type: "object",
      properties: {
        audience_address: { type: "string" },
        epoch: { type: "integer", minimum: 1 },
        invite_priv_4ainv: { type: "string", description: "4ainv1… bech32 invite key" },
        claim_pubkey: { type: "string", description: "Invitee identity pubkey" },
        inviter_pubkey: { type: "string", description: "Audience-owner identity pubkey (recipient of the claim's `p` tag)" },
        note: { type: "string" },
      },
      required: ["audience_address", "epoch", "invite_priv_4ainv", "claim_pubkey", "inviter_pubkey"],
      additionalProperties: false,
    },
    examples: [],
  },
  {
    name: "audience_rotate",
    description: "Bump the audience's epoch number, generate a fresh aud_epoch keypair, republish the declaration with the updated roster, and fan out kind:30521 grants to every post-rotation member.",
    inputSchema: {
      type: "object",
      properties: {
        audience_address: { type: "string" },
        aud_id_priv: { type: "string" },
        add_members: { type: "array", items: { type: "string" }, default: [] },
        remove_members: { type: "array", items: { type: "string" }, default: [] },
        remove_pending: { type: "array", items: { type: "string" }, default: [] },
      },
      required: ["audience_address", "aud_id_priv"],
      additionalProperties: false,
    },
    examples: [],
  },
  {
    name: "audience_publish",
    description: "Publish a 4A object (Observation / Claim / Entity / Relation / Commons) into a private audience. NIP-44-encrypts the payload to the current aud_epoch_pub, builds the kind:30510-30514 rumor, NIP-17 gift-wraps once per current member, and fans out the wraps. Caller must be a current member.",
    inputSchema: {
      type: "object",
      properties: {
        audience_address: { type: "string" },
        aud_epoch_pub: { type: "string", description: "Current epoch pubkey (from audience_create or audience_rotate)" },
        kind: { type: "integer", enum: [30510, 30511, 30512, 30513, 30514] },
        d_tag: { type: "string", description: "Replaceable d-slug" },
        alt: { type: "string", description: "One-line summary; MUST NOT leak inner payload" },
        payload: { type: "object", description: "JSON-LD payload (matches the public-kind shape)" },
      },
      required: ["audience_address", "aud_epoch_pub", "kind", "d_tag", "alt", "payload"],
      additionalProperties: false,
    },
    examples: [],
  },
  {
    name: "audience_inbox",
    description: "Read recent audience-addressed events for the calling user. Runs the §2.5 capability-based decryption pipeline: pull cached gift-wraps, NIP-17 unwrap, look up the matching kind:30521 grant, NIP-44-decrypt the rumor content, return parsed JSON-LD payloads.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Audience slug (filters the inbox to this audience)" },
        since: { type: "integer", description: "Unix timestamp; only return events with created_at >= since" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    examples: [],
  },
  {
    name: "audience_process_claims",
    description: "Polled equivalent of the §4 claim-watcher. Scans the audience's pending invites for matching kind:30522 events and triggers a rotation that adds the new members + drops the matched pending entries. Idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        audience_address: { type: "string" },
        aud_id_priv: { type: "string" },
      },
      required: ["audience_address", "aud_id_priv"],
      additionalProperties: false,
    },
    examples: [],
  },
  {
    name: "audience_list_pending_claims",
    description:
      "Founder-only preview of pending claims on an audience. Walks the audience's current fa:pending invites, returns any kind:30522 claim events the gateway has cached (each item carries invite_pub, claim_pubkey, claim_event_id, expires_at, and the claim's parsed JSON-LD content). Same scan as audience_process_claims but stops before rotating — useful for showing the founder who wants in before they admit anyone.",
    inputSchema: {
      type: "object",
      properties: {
        audience_address: { type: "string", description: "30520:<aud_id-hex>:<slug>" },
        aud_id_priv: { type: "string", description: "Audience identity priv (32-byte hex; proves founder)" },
      },
      required: ["audience_address", "aud_id_priv"],
      additionalProperties: false,
    },
    examples: [],
  },
  {
    name: "audience_list_my",
    description:
      "List audiences the calling user is a member of. Returns one entry per audience the caller holds a current key-grant for, with { audience_address, aud_id_pub, slug, epoch_n, role: 'founder' | 'member' }. Role is best-effort: 'founder' marks audiences whose key-grants to the caller were signed by the audience identity key itself; 'member' is the default. Uses the caller's identity from the authenticated session — no extra inputs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    examples: [{ name: "audience_list_my", arguments: {} }],
  },
];

function getPool(env: McpEnv): DurableObjectStub<RelayPool> {
  return env.RELAY_POOL.get(env.RELAY_POOL.idFromName("main"));
}

function rpcError(code: number, message: string, data?: unknown): RpcError {
  return new RpcError(code, message, data);
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: McpEnv,
  session: Session,
): Promise<unknown> {
  switch (name) {
    case "query_4a":
      return runQuery(args, env);
    case "get_4a_object":
      return runGetObject(args, env);
    case "get_credibility":
      return runCredibility(args);
    case "list_commons":
      return runListCommons(env);
    case "auth_4a":
      return runAuth(args, env, session);
    case "publish_observation":
      return runPublishTool("observation", args, env, session);
    case "publish_claim":
      return runPublishTool("claim", args, env, session);
    case "publish_entity":
      return runPublishTool("entity", args, env, session);
    case "publish_relation":
      return runPublishTool("relation", args, env, session);
    case "attest":
      return runPublishTool("attest", args, env, session);
    case "score":
      return runScoreTool(args, env, session);
    case "comment":
      return runCommentTool(args, env, session);
    case "audience_create":
    case "audience_invite":
    case "audience_grant":
    case "audience_claim":
    case "audience_rotate":
    case "audience_publish":
    case "audience_inbox":
    case "audience_process_claims":
    case "audience_list_pending_claims":
    case "audience_list_my":
      return runAudienceTool(name, args, env, session);
    default:
      throw rpcError(METHOD_NOT_FOUND, `unknown tool: ${name}`);
  }
}

async function runAuth(
  args: Record<string, unknown>,
  env: McpEnv,
  session: Session,
): Promise<unknown> {
  if (typeof args.jwt !== "string" || args.jwt.length === 0) {
    throw rpcError(INVALID_PARAMS, "jwt is required");
  }
  const claims = await verifyJwt(args.jwt, env);
  if (!claims) {
    throw rpcError(
      INVALID_PARAMS,
      "invalid or expired token — obtain a fresh one at https://api.4a4.ai/auth/github/start",
    );
  }
  session.claims = claims;
  return {
    ok: true,
    provider: claims.provider,
    login: claims.login,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

async function runAudienceTool(
  name: string,
  args: Record<string, unknown>,
  env: McpEnv,
  session: Session,
): Promise<unknown> {
  if (!session.claims) {
    throw rpcError(
      INVALID_REQUEST,
      "not authenticated — call auth_4a with a JWT from https://api.4a4.ai/auth/github/start",
    );
  }
  try {
    let resp: Response;
    switch (name) {
      case "audience_create": {
        const body = __audienceRoutes.validateCreateBody(args);
        resp = await __audienceRoutes.runCreate(body, session.claims, env);
        break;
      }
      case "audience_invite": {
        const body = __audienceRoutes.validateInviteBody(args);
        resp = await __audienceRoutes.runInvite(body, env);
        break;
      }
      case "audience_grant": {
        const body = __audienceRoutes.validateGrantBody(args);
        resp = await __audienceRoutes.runGrant(body, session.claims, env);
        break;
      }
      case "audience_claim": {
        const body = __audienceRoutes.validateClaimBody(args);
        resp = await __audienceRoutes.runClaim(body, env);
        break;
      }
      case "audience_rotate": {
        const body = __audienceRoutes.validateRotateBody(args);
        resp = await __audienceRoutes.runRotate(body, session.claims, env);
        break;
      }
      case "audience_publish": {
        const body = __audienceRoutes.validateAudiencePublishBody(args);
        resp = await __audienceRoutes.runAudiencePublish(body, session.claims, env);
        break;
      }
      case "audience_process_claims": {
        const body = __audienceRoutes.validateProcessClaimsBody(args);
        resp = await __audienceRoutes.runProcessClaims(body, session.claims, env);
        break;
      }
      case "audience_list_pending_claims": {
        const body = __audienceRoutes.validateListPendingClaimsBody(args);
        resp = await __audienceRoutes.runListPendingClaims(body, env);
        break;
      }
      case "audience_list_my": {
        resp = await __audienceRoutes.runListMy(session.claims, env);
        break;
      }
      case "audience_inbox": {
        const slug = typeof args.slug === "string" ? args.slug : "";
        if (!slug) throw rpcError(INVALID_PARAMS, "slug is required");
        const since = typeof args.since === "number" ? args.since : undefined;
        const limit =
          typeof args.limit === "number"
            ? Math.min(Math.max(args.limit, 1), 200)
            : 50;
        resp = await __audienceRoutes.runInbox(slug, since, limit, session.claims, env);
        break;
      }
      default:
        throw rpcError(METHOD_NOT_FOUND, `unknown audience tool: ${name}`);
    }
    const json = await resp.json();
    if (!resp.ok) {
      const code = resp.status === 400 ? INVALID_PARAMS : INTERNAL_ERROR;
      const j = json as Record<string, unknown>;
      throw rpcError(code, String(j.message ?? "audience tool failed"), j);
    }
    return json;
  } catch (err) {
    if (err instanceof RpcError) throw err;
    if (err instanceof Error && err.name === "AudienceValidationError") {
      throw rpcError(INVALID_PARAMS, err.message);
    }
    throw rpcError(
      INTERNAL_ERROR,
      err instanceof Error ? err.message : "audience tool failed",
    );
  }
}

async function runPublishTool(
  kind: PublishKind,
  args: Record<string, unknown>,
  env: McpEnv,
  session: Session,
): Promise<unknown> {
  if (!session.claims) {
    throw rpcError(
      INVALID_REQUEST,
      "not authenticated — clients that support OAuth discovery can fetch https://mcp.4a4.ai/.well-known/oauth-protected-resource and run the standard authorization-code flow. Otherwise: pass `Authorization: Bearer <jwt>` on the GET /sse handshake, or call the `auth_4a` tool with a JWT obtained from https://api.4a4.ai/auth/google/start",
    );
  }
  const result = await runPublish(kind, args, session.claims, env);
  if (!result.ok) {
    const code = result.status === 400 ? INVALID_PARAMS : INTERNAL_ERROR;
    throw rpcError(code, result.message, { error: result.error, ...(result.extra ?? {}) });
  }
  return {
    ok: true,
    eventId: result.eventId,
    address: result.address,
    kind: result.kind,
    pubkey: result.pubkey,
    npub: result.npub,
    relayResults: result.relayResults,
  };
}

async function runScoreTool(
  args: Record<string, unknown>,
  env: McpEnv,
  session: Session,
): Promise<unknown> {
  if (!session.claims) {
    throw rpcError(
      INVALID_REQUEST,
      "not authenticated — pass `Authorization: Bearer <jwt>` on the GET /sse handshake or call the `auth_4a` tool",
    );
  }
  let body;
  try {
    body = validateScoreBody(args);
  } catch (err) {
    if (err instanceof ScoreValidationError) {
      throw rpcError(INVALID_PARAMS, err.message);
    }
    throw err;
  }
  const result = await runScore(body, session.claims, env);
  if (!("ok" in result) || !result.ok) {
    const code = result.status === 400 ? INVALID_PARAMS : INTERNAL_ERROR;
    throw rpcError(code, result.message, { error: result.error, ...(result.extra ?? {}) });
  }
  return {
    ok: true,
    score_event_id: result.score_event_id,
    comment_event_id: result.comment_event_id,
    score_address: result.score_address,
    comment_address: result.comment_address,
    pubkey: result.pubkey,
    npub: result.npub,
    relay_acks: result.relay_acks,
  };
}

async function runCommentTool(
  args: Record<string, unknown>,
  env: McpEnv,
  session: Session,
): Promise<unknown> {
  if (!session.claims) {
    throw rpcError(
      INVALID_REQUEST,
      "not authenticated — pass `Authorization: Bearer <jwt>` on the GET /sse handshake or call the `auth_4a` tool",
    );
  }
  let body;
  try {
    body = validateCommentBody(args);
  } catch (err) {
    if (err instanceof CommentValidationError) {
      throw rpcError(INVALID_PARAMS, err.message);
    }
    throw err;
  }
  const result = await runComment(body, session.claims, env);
  if (!("ok" in result) || !result.ok) {
    const code = result.status === 400 ? INVALID_PARAMS : INTERNAL_ERROR;
    throw rpcError(code, result.message, { error: result.error, ...(result.extra ?? {}) });
  }
  return {
    ok: true,
    comment_event_id: result.comment_event_id,
    address: result.address,
    kind: result.kind,
    pubkey: result.pubkey,
    npub: result.npub,
    relay_acks: result.relay_acks,
  };
}

async function runQuery(args: Record<string, unknown>, env: McpEnv): Promise<unknown> {
  const filter: QueryFilter = {};
  if (typeof args.about === "string" && args.about.length > 0) filter.about = args.about;
  if (typeof args.topic === "string" && args.topic.length > 0) filter.topic = args.topic;
  if (typeof args.kind === "string") {
    const k = KIND_BY_NAME[args.kind.toLowerCase()];
    if (k === undefined) {
      throw rpcError(
        INVALID_PARAMS,
        `unknown kind '${args.kind}' — try observation|claim|entity|relation|commons`,
      );
    }
    filter.kind = k;
  }
  if (typeof args.author === "string") {
    const hex = normalizePubkey(args.author);
    if (!hex) throw rpcError(INVALID_PARAMS, `author must be 64-char hex or npub1...`);
    filter.author = hex;
  }
  let limit = 50;
  if (args.limit !== undefined && args.limit !== null) {
    const n = Number(args.limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      throw rpcError(INVALID_PARAMS, `limit must be an integer in 1..200`);
    }
    limit = n;
  }
  filter.limit = limit;

  const events: NostrEvent[] = await getPool(env).query(filter);
  return { events, count: events.length, queriedAt: new Date().toISOString() };
}

async function runGetObject(args: Record<string, unknown>, env: McpEnv): Promise<unknown> {
  let kind: number;
  if (typeof args.kind === "string") {
    const fromName = KIND_BY_NAME[args.kind.toLowerCase()];
    const fromNum = Number(args.kind);
    if (fromName !== undefined) {
      kind = fromName;
    } else if (Number.isInteger(fromNum) && VALID_KINDS.has(fromNum)) {
      kind = fromNum;
    } else {
      throw rpcError(INVALID_PARAMS, `unknown kind '${args.kind}'`);
    }
  } else if (typeof args.kind === "number" && VALID_KINDS.has(args.kind)) {
    kind = args.kind;
  } else {
    throw rpcError(INVALID_PARAMS, `kind must be a 4A kind name or numeric 30500..30504`);
  }

  if (typeof args.pubkey !== "string") throw rpcError(INVALID_PARAMS, `pubkey is required`);
  const pubkey = normalizePubkey(args.pubkey);
  if (!pubkey) throw rpcError(INVALID_PARAMS, `pubkey must be 64-char hex or npub1...`);

  if (typeof args.d !== "string" || args.d.length === 0) {
    throw rpcError(INVALID_PARAMS, `d is required`);
  }

  const event = await getPool(env).getObject(kind, pubkey, args.d);
  return event ?? null;
}

async function runCredibility(args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.pubkey !== "string") throw rpcError(INVALID_PARAMS, `pubkey is required`);
  const proxyReq = new Request("https://mcp.4a4.ai/credibility", { method: "GET" });
  const resp = await handleCredibility(proxyReq, args.pubkey);
  const body = (await resp.json()) as Record<string, unknown>;
  if (resp.status >= 400) {
    throw rpcError(
      INVALID_PARAMS,
      typeof body.message === "string" ? body.message : "credibility lookup failed",
      body,
    );
  }
  return body;
}

async function runListCommons(env: McpEnv): Promise<unknown> {
  const commons = await getPool(env).listCommons();
  return { commons, count: commons.length };
}

function jsonRpcSuccess(id: unknown, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function jsonRpcFailure(id: unknown, error: JsonRpcError) {
  return { jsonrpc: "2.0" as const, id, error };
}

async function dispatch(
  msg: JsonRpcRequest,
  env: McpEnv,
  session: Session,
): Promise<unknown | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  const id = msg.id ?? null;
  const method = msg.method;
  const params = (msg.params && typeof msg.params === "object"
    ? (msg.params as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  try {
    let result: unknown;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
        break;
      case "ping":
        result = {};
        break;
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return null;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const toolName = params.name;
        if (typeof toolName !== "string") {
          throw rpcError(INVALID_PARAMS, "tools/call requires a 'name' string");
        }
        const toolArgs =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        try {
          const data = await callTool(toolName, toolArgs, env, session);
          result = {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            isError: false,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = {
            content: [{ type: "text", text: message }],
            isError: true,
          };
        }
        break;
      }
      case "resources/list":
        result = { resources: [] };
        break;
      case "prompts/list":
        result = { prompts: [] };
        break;
      default:
        if (isNotification) return null;
        throw rpcError(METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
    if (isNotification) return null;
    return jsonRpcSuccess(id, result);
  } catch (err) {
    if (isNotification) return null;
    if (err instanceof RpcError) {
      return jsonRpcFailure(id, { code: err.code, message: err.message, data: err.data });
    }
    return jsonRpcFailure(id, {
      code: INTERNAL_ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

function sseFrame(eventName: string | null, data: string): string {
  let out = "";
  if (eventName) out += `event: ${eventName}\n`;
  for (const line of data.split("\n")) out += `data: ${line}\n`;
  out += "\n";
  return out;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

// McpHub Durable Object — singleton (id "main") that owns all live SSE
// sessions for the worker. The worker forwards every mcp.4a4.ai/* request
// here so the GET /sse and POST /messages handlers see the same in-memory
// session map regardless of which edge isolate first received the request.
export class McpHub extends DurableObject<McpEnv> {
  private sessions = new Map<string, Session>();

  override async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/sse" && request.method === "GET") return await this.handleOpen(request);
    if (path === "/messages" && request.method === "POST") return this.handleMessage(request);
    if ((path === "/" || path === "/health") && request.method === "GET") {
      return jsonResponse({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        transport: "sse",
        protocolVersion: PROTOCOL_VERSION,
        endpoints: { sse: "/sse", messages: "/messages?sessionId=<id>" },
        tools: TOOLS.map((t) => t.name),
        liveSessions: this.sessions.size,
      });
    }
    return jsonResponse({ error: "not_found", message: `unknown path: ${path}` }, 404);
  }

  private closeSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    clearInterval(s.heartbeat);
    try {
      s.writer.close();
    } catch {
      /* already closed */
    }
  }

  private async emit(session: Session, payload: unknown): Promise<void> {
    try {
      await session.writer.write(
        session.encoder.encode(sseFrame("message", JSON.stringify(payload))),
      );
    } catch {
      /* writer closed; reaped on next heartbeat */
    }
  }

  private async handleOpen(request: Request): Promise<Response> {
    // /sse requires Bearer auth on the handshake — a missing or invalid
    // bearer triggers a 401 with WWW-Authenticate so MCP clients run the
    // standard OAuth discovery+authorization flow before the session opens.
    // Public read access is still available at api.4a4.ai/v0/* (no auth).
    const auth = request.headers.get("Authorization");
    const bearer = auth && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    let claims: AuthClaims | undefined;
    if (bearer) {
      const verified = await verifyJwt(bearer, this.env);
      if (verified) claims = verified;
    }
    if (!claims) {
      // RFC 9728 §5.1 — point clients at the protected-resource metadata so
      // they can discover the authorization server without out-of-band config.
      const errorTag = bearer ? "invalid_token" : "missing_token";
      const desc = bearer ? "invalid or expired bearer token" : "authentication required";
      const wwwAuth =
        `Bearer error="${errorTag}", error_description="${desc}", ` +
        'resource_metadata="https://mcp.4a4.ai/.well-known/oauth-protected-resource"';
      return new Response(
        JSON.stringify({
          error: "unauthorized",
          message:
            "/sse requires an Authorization: Bearer <jwt> header. Clients that support OAuth discovery should fetch https://mcp.4a4.ai/.well-known/oauth-protected-resource and run the standard authorization-code flow.",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "WWW-Authenticate": wwwAuth,
            ...CORS_HEADERS,
          },
        },
      );
    }

    const sessionId = newSessionId();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const heartbeat = setInterval(() => {
      writer
        .write(encoder.encode(`: heartbeat\n\n`))
        .catch(() => this.closeSession(sessionId));
    }, HEARTBEAT_MS);

    this.sessions.set(sessionId, { writer, encoder, heartbeat, claims });

    // Fire-and-forget — awaiting before returning the Response would deadlock
    // because the readable side isn't being consumed yet.
    const endpointPath = `/messages?sessionId=${sessionId}`;
    writer
      .write(encoder.encode(sseFrame("endpoint", endpointPath)))
      .catch(() => this.closeSession(sessionId));

    if (request.signal) {
      request.signal.addEventListener("abort", () => this.closeSession(sessionId));
    }

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...CORS_HEADERS,
      },
    });
  }

  private async handleMessage(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return jsonResponse(
        { error: "bad_request", message: "sessionId query parameter required" },
        400,
      );
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      return jsonResponse(
        { error: "not_found", message: "no such session — reconnect via GET /sse" },
        404,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      await this.emit(session, jsonRpcFailure(null, { code: PARSE_ERROR, message: "invalid JSON" }));
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }

    const messages = Array.isArray(body) ? body : [body];
    for (const raw of messages) {
      if (
        !raw ||
        typeof raw !== "object" ||
        (raw as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
        typeof (raw as { method?: unknown }).method !== "string"
      ) {
        const id = (raw as { id?: unknown } | null)?.id ?? null;
        await this.emit(
          session,
          jsonRpcFailure(id, { code: INVALID_REQUEST, message: "malformed JSON-RPC envelope" }),
        );
        continue;
      }
      const response = await dispatch(raw as JsonRpcRequest, this.env, session);
      if (response !== null) await this.emit(session, response);
    }

    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }
}

export function handleMcpRequest(request: Request, env: McpEnv): Promise<Response> {
  // Forward every mcp.4a4.ai/* request to the singleton McpHub DO so SSE
  // session state survives across worker isolates.
  const stub = env.MCP_HUB.get(env.MCP_HUB.idFromName("main"));
  return stub.fetch(request);
}

