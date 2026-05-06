#!/usr/bin/env node
// Build the ten-event fixture set for v0.5-design.md §5 / SPEC-v0.5 §5.5.
//
// Deterministic — uses fixed seed pubkeys and fixed created_at timestamps so
// the JSON output bytes are byte-identical across runs. Run with:
//
//   node scripts/build-v0.5-fixtures.mjs
//
// To run the fixtures against a live relay, see docs/v0.5-audiences-runbook.md.
//
// This script intentionally inlines the minimum NIP-44 / signing logic so it
// can run from a fresh clone with no TS build step. The gateway's lib/*.ts
// modules carry the canonical implementations and are unit-tested.

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { extract as hkdfExtract, expand as hkdfExpand } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { chacha20 } from "@noble/ciphers/chacha.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { base64, bech32 } from "@scure/base";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTDIR = resolve(HERE, "..", "docs", "examples", "v0.5");
mkdirSync(OUTDIR, { recursive: true });

const FA_CONTEXT_V0 = "https://4a4.ai/ns/v0";
const NIP44_SALT = new TextEncoder().encode("nip44-v2");

// ─── deterministic key + nonce helpers ──────────────────────────────────────
function det(label) {
  return sha256(new TextEncoder().encode("4a-v0.5-fixture:" + label));
}
function pub(priv) { return bytesToHex(schnorr.getPublicKey(priv)); }

// ─── BLAKE3 content tag helper (mirrors gateway/src/lib/blake3-tag.ts) ───────
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32Encode(bytes) {
  let bits = 0, value = 0, out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
function blake3ContentTag(content) {
  return "bk-" + base32Encode(blake3(new TextEncoder().encode(content)));
}

// ─── NIP-44 v2 ───────────────────────────────────────────────────────────────
function getConversationKey(privA, pubBHex) {
  const sharedX = secp256k1.getSharedSecret(privA, hexToBytes("02" + pubBHex)).subarray(1, 33);
  return hkdfExtract(sha256, sharedX, NIP44_SALT);
}
function calcPaddedLen(len) {
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}
function pad(plaintext) {
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, plaintext.length, false);
  const suffix = new Uint8Array(calcPaddedLen(plaintext.length) - plaintext.length);
  return concatBytes(prefix, plaintext, suffix);
}
function nip44EncryptBytes(plaintext, senderPriv, recipientPubHex, nonce) {
  const ck = getConversationKey(senderPriv, recipientPubHex);
  const keys = hkdfExpand(sha256, ck, nonce, 76);
  const chachaKey = keys.subarray(0, 32);
  const chachaNonce = keys.subarray(32, 44);
  const hmacKey = keys.subarray(44, 76);
  const padded = pad(plaintext);
  const ct = chacha20(chachaKey, chachaNonce, padded);
  const mac = hmac(sha256, hmacKey, concatBytes(nonce, ct));
  return base64.encode(concatBytes(new Uint8Array([0x02]), nonce, ct, mac));
}
function nip44EncryptString(plaintext, senderPriv, recipientPubHex, nonce) {
  return nip44EncryptBytes(new TextEncoder().encode(plaintext), senderPriv, recipientPubHex, nonce);
}

// ─── event signing (mirrors gateway/src/lib/sign.ts) ─────────────────────────
function signEventWithRawKey(template, priv) {
  const pubkey = bytesToHex(schnorr.getPublicKey(priv));
  const serialized = JSON.stringify([
    0, pubkey, template.created_at, template.kind, template.tags, template.content,
  ]);
  const idBytes = sha256(new TextEncoder().encode(serialized));
  const id = bytesToHex(idBytes);
  const sig = bytesToHex(schnorr.sign(idBytes, priv));
  return { ...template, id, pubkey, sig };
}

// ─── event builders (mirror gateway/src/lib/audience-events.ts) ──────────────
function buildAudienceDeclaration({ slug, name, description, epoch, epochPub, members, pending, createdAt }) {
  const tags = [
    ["d", slug],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", `Audience: ${slug} (${members.length} member${members.length === 1 ? "" : "s"}, epoch ${epoch})`],
    ["fa:epoch", String(epoch)],
    ["fa:epoch-pubkey", epochPub],
  ];
  for (const m of members) tags.push(["p", m]);
  for (const p of pending ?? []) tags.push(["fa:pending", `${p.invitePub}:${p.expirationUnix}`]);
  const content = JSON.stringify({
    "@context": FA_CONTEXT_V0, "@type": "Audience",
    name, ...(description !== undefined ? { description } : {}), epoch,
  });
  return { kind: 30520, created_at: createdAt, tags, content };
}
function buildKeyGrant({ audIdPub, slug, epoch, recipientPub, ciphertext, createdAt }) {
  return {
    kind: 30521, created_at: createdAt,
    tags: [
      ["d", `${slug}:${epoch}:${recipientPub}`],
      ["fa:context", FA_CONTEXT_V0],
      ["alt", `KeyGrant: ${slug} epoch ${epoch}`],
      ["a", `30520:${audIdPub}:${slug}`],
      ["fa:epoch", String(epoch)],
      ["p", recipientPub],
    ],
    content: ciphertext,
  };
}
function buildAudienceClaim({ audIdPub, slug, epoch, invitePub, inviterPub, claimPub, note, expiration, createdAt }) {
  const tags = [
    ["d", `${slug}:${epoch}:${invitePub}`],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", `claim audience ${slug} epoch ${epoch}`],
    ["a", `30520:${audIdPub}:${slug}`],
    ["fa:epoch", String(epoch)],
    ["p", inviterPub],
    ["fa:claim-pubkey", claimPub],
  ];
  if (expiration !== undefined) tags.push(["expiration", String(expiration)]);
  const content = JSON.stringify({
    "@context": FA_CONTEXT_V0, "@type": "AudienceClaim",
    audience: slug, epoch, claimPubkey: claimPub,
    ...(note !== undefined ? { note } : {}),
  });
  return { kind: 30522, created_at: createdAt, tags, content };
}
function buildEncryptedVariant({ kind, audIdPub, slug, epoch, members, dTag, alt, ciphertext, createdAt }) {
  const tags = [
    ["d", dTag],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", alt],
    ["a", `30520:${audIdPub}:${slug}`],
    ["fa:epoch", String(epoch)],
  ];
  for (const m of members) tags.push(["p", m]);
  tags.push(["blake3", blake3ContentTag(ciphertext)]);
  return { kind, created_at: createdAt, tags, content: ciphertext };
}
function encodeInviteKey(priv) {
  return bech32.encode("4ainv", bech32.toWords(priv), 256);
}

// ─── deterministic actors ────────────────────────────────────────────────────
const AUD_ID = { priv: det("aud_id team-design") }; AUD_ID.pub = pub(AUD_ID.priv);
const AUD_EPOCH_1 = { priv: det("aud_epoch_1 team-design") }; AUD_EPOCH_1.pub = pub(AUD_EPOCH_1.priv);
const AUD_EPOCH_2 = { priv: det("aud_epoch_2 team-design") }; AUD_EPOCH_2.pub = pub(AUD_EPOCH_2.priv);
const EVAN = { priv: det("evan@github 12345") }; EVAN.pub = pub(EVAN.priv);
const ALLISON = { priv: det("allison@github 67890") }; ALLISON.pub = pub(ALLISON.priv);
const INVITE = { priv: det("invite_priv epoch1 team-design") }; INVITE.pub = pub(INVITE.priv);
const T0 = 1777344000; // 2026-04-28T08:00Z — historical timeline of the scenario.
const T = (offsetSec) => T0 + offsetSec;
const fixedNonce = (label) => det("nip44-nonce:" + label);
// PENDING_EXP is hardcoded far in the future (2030-01-01) so the validators'
// "expiration-in-the-past" check against the *current* clock keeps the
// fixtures green forever, while leaving the rest of the timeline historical.
const PENDING_EXP = 1893456000;

// ─── 1: declaration v1 — Evan as sole member ─────────────────────────────────
const decl1 = buildAudienceDeclaration({
  slug: "team-design", name: "team-design", description: "Design notes shared with Allison.",
  epoch: 1, epochPub: AUD_EPOCH_1.pub, members: [EVAN.pub], createdAt: T(0),
});
const decl1Signed = signEventWithRawKey(decl1, AUD_ID.priv);

// ─── 2: KeyGrant epoch 1 → Evan ──────────────────────────────────────────────
const grant1Ct = nip44EncryptBytes(AUD_EPOCH_1.priv, AUD_ID.priv, EVAN.pub, fixedNonce("grant1"));
const grant1 = buildKeyGrant({
  audIdPub: AUD_ID.pub, slug: "team-design", epoch: 1, recipientPub: EVAN.pub,
  ciphertext: grant1Ct, createdAt: T(1),
});
const grant1Signed = signEventWithRawKey(grant1, AUD_ID.priv);

// ─── 3: declaration v1' — pending invite added ───────────────────────────────
const decl1pending = buildAudienceDeclaration({
  slug: "team-design", name: "team-design", description: "Design notes shared with Allison.",
  epoch: 1, epochPub: AUD_EPOCH_1.pub, members: [EVAN.pub],
  pending: [{ invitePub: INVITE.pub, expirationUnix: PENDING_EXP }], createdAt: T(2),
});
const decl1pendingSigned = signEventWithRawKey(decl1pending, AUD_ID.priv);

// ─── 4: claim from invite_priv → Evan ────────────────────────────────────────
const claim = buildAudienceClaim({
  audIdPub: AUD_ID.pub, slug: "team-design", epoch: 1, invitePub: INVITE.pub,
  inviterPub: EVAN.pub, claimPub: ALLISON.pub, note: "claimed via claim.4a4.ai",
  expiration: PENDING_EXP, createdAt: T(3),
});
const claimSigned = signEventWithRawKey(claim, INVITE.priv);

// ─── 5: declaration v2 — Allison joins, epoch bumped to 2 ────────────────────
const decl2 = buildAudienceDeclaration({
  slug: "team-design", name: "team-design", description: "Design notes shared with Allison.",
  epoch: 2, epochPub: AUD_EPOCH_2.pub, members: [EVAN.pub, ALLISON.pub], createdAt: T(4),
});
const decl2Signed = signEventWithRawKey(decl2, AUD_ID.priv);

// ─── 6: KeyGrant epoch 2 → Evan ──────────────────────────────────────────────
const grant2EvanCt = nip44EncryptBytes(AUD_EPOCH_2.priv, AUD_ID.priv, EVAN.pub, fixedNonce("grant2-evan"));
const grant2Evan = buildKeyGrant({
  audIdPub: AUD_ID.pub, slug: "team-design", epoch: 2, recipientPub: EVAN.pub,
  ciphertext: grant2EvanCt, createdAt: T(5),
});
const grant2EvanSigned = signEventWithRawKey(grant2Evan, AUD_ID.priv);

// ─── 7: KeyGrant epoch 2 → Allison ───────────────────────────────────────────
const grant2AllisonCt = nip44EncryptBytes(AUD_EPOCH_2.priv, AUD_ID.priv, ALLISON.pub, fixedNonce("grant2-allison"));
const grant2Allison = buildKeyGrant({
  audIdPub: AUD_ID.pub, slug: "team-design", epoch: 2, recipientPub: ALLISON.pub,
  ciphertext: grant2AllisonCt, createdAt: T(6),
});
const grant2AllisonSigned = signEventWithRawKey(grant2Allison, AUD_ID.priv);

// ─── 8: Evan's encrypted Observation (kind:30510) ────────────────────────────
const observation = JSON.stringify({
  "@context": FA_CONTEXT_V0, "@type": "Observation",
  agent: { "@id": "nostr:" + EVAN.pub },
  observationDate: "2026-04-28T08:07:00Z",
  observationAbout: { "@id": "https://example.org/css-resets" },
  measuredProperty: "css-trick",
  value: "Saw a slick CSS reset that drops `margin: 0` on `body` — relies on `:where()` to keep specificity at zero so user styles always win.",
});
const observationCt = nip44EncryptString(observation, EVAN.priv, AUD_EPOCH_2.pub, fixedNonce("observation-ct"));
const rumor = buildEncryptedVariant({
  kind: 30510, audIdPub: AUD_ID.pub, slug: "team-design", epoch: 2,
  members: [EVAN.pub, ALLISON.pub], dTag: "team-design-css-reset",
  alt: "encrypted Observation in team-design", ciphertext: observationCt, createdAt: T(7),
});
const rumorSigned = signEventWithRawKey(rumor, EVAN.priv);

// ─── 9 + 10: gift-wraps to Evan and Allison ──────────────────────────────────
function buildDeterministicGiftWrap(rumorEvent, publisherPriv, recipientPub, label) {
  const ephPriv = det("eph " + label);
  const sealNonce = fixedNonce("seal " + label);
  const wrapNonce = fixedNonce("wrap " + label);
  const sealContent = nip44EncryptString(JSON.stringify(rumorEvent), publisherPriv, recipientPub, sealNonce);
  const sealSigned = signEventWithRawKey({ kind: 13, created_at: T(8), tags: [], content: sealContent }, publisherPriv);
  const wrapContent = nip44EncryptString(JSON.stringify(sealSigned), ephPriv, recipientPub, wrapNonce);
  return signEventWithRawKey({ kind: 1059, created_at: T(9), tags: [["p", recipientPub]], content: wrapContent }, ephPriv);
}
const giftWrapEvan = buildDeterministicGiftWrap(rumorSigned, EVAN.priv, EVAN.pub, "evan");
const giftWrapAllison = buildDeterministicGiftWrap(rumorSigned, EVAN.priv, ALLISON.pub, "allison");

// ─── write fixtures ──────────────────────────────────────────────────────────
const fixtures = [
  ["01-declaration-v1.json", decl1Signed, "Audience declaration v1 — Evan as sole member"],
  ["02-keygrant-epoch1-evan.json", grant1Signed, "KeyGrant epoch 1 → Evan (founding grant, signed by aud_id)"],
  ["03-declaration-v1-pending.json", decl1pendingSigned, "Audience declaration v1' — pending invite added"],
  ["04-claim-from-invite.json", claimSigned, "Claim event from invite_priv → Evan"],
  ["05-declaration-v2.json", decl2Signed, "Audience declaration v2 — Allison joins, epoch bumped"],
  ["06-keygrant-epoch2-evan.json", grant2EvanSigned, "KeyGrant epoch 2 → Evan"],
  ["07-keygrant-epoch2-allison.json", grant2AllisonSigned, "KeyGrant epoch 2 → Allison"],
  ["08-encrypted-observation.json", rumorSigned, "Evan's encrypted Observation (kind:30510 rumor)"],
  ["09-giftwrap-to-evan.json", giftWrapEvan, "Gift-wrap of (8) addressed to Evan"],
  ["10-giftwrap-to-allison.json", giftWrapAllison, "Gift-wrap of (8) addressed to Allison"],
];

for (const [filename, event] of fixtures) {
  writeFileSync(resolve(OUTDIR, filename), JSON.stringify(event, null, 2) + "\n");
}

const indexLines = [
  "# 4A v0.5 worked-example fixtures",
  "",
  "Ten JSON files: the events from `v0.5-design.md` §5 / `SPEC-v0.5.md` §5.5,",
  "generated deterministically by `scripts/build-v0.5-fixtures.mjs`.",
  "",
  "Use cases:",
  "- driving the §5 walk-through against any compatible relay;",
  "- regression tests that pin v0.5 wire shapes;",
  "- the `docs/v0.5-audiences-runbook.md` curl examples.",
  "",
  "## Deterministic seeds",
  "",
  "Every keypair below is derived as `SHA-256(\"4a-v0.5-fixture:\" + label)`,",
  "so two runs produce byte-identical output. **These are NOT real production",
  "keys** — they exist solely so humans can diff PR changes without nonce churn.",
  "",
  "| Role | Label | Pubkey |",
  "|---|---|---|",
  `| aud_id | aud_id team-design | \`${AUD_ID.pub}\` |`,
  `| aud_epoch_1 | aud_epoch_1 team-design | \`${AUD_EPOCH_1.pub}\` |`,
  `| aud_epoch_2 | aud_epoch_2 team-design | \`${AUD_EPOCH_2.pub}\` |`,
  `| Evan | evan@github 12345 | \`${EVAN.pub}\` |`,
  `| Allison | allison@github 67890 | \`${ALLISON.pub}\` |`,
  `| invite_priv | invite_priv epoch1 team-design | \`${INVITE.pub}\` |`,
  "",
  `Audience address: \`30520:${AUD_ID.pub}:team-design\`.`,
  "",
  "Bech32 invite key:",
  "",
  "```",
  encodeInviteKey(INVITE.priv),
  "```",
  "",
  "## Files",
  "",
  ...fixtures.map(([f, _e, d]) => `- [\`${f}\`](./${f}) — ${d}`),
  "",
  "## Status",
  "",
  "All ten events are produced offline by the same algorithms the gateway",
  "uses (see `gateway/src/lib/{audience-events,nip44,sign}.ts` for canonical",
  "TS implementations). To exercise the round-trip against the live `4a4.ai`",
  "relay set, follow `docs/v0.5-audiences-runbook.md` — that's marked",
  "**ready-to-run, needs Evan to execute** since this build session does not",
  "have outbound websocket access to relays.",
  "",
  "## Re-running",
  "",
  "```sh",
  "node scripts/build-v0.5-fixtures.mjs",
  "```",
  "",
];
writeFileSync(resolve(OUTDIR, "README.md"), indexLines.join("\n"));

process.stdout.write(`Wrote ${fixtures.length} fixtures + README.md to ${OUTDIR}\n`);
