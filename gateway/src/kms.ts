// AWS KMS HMAC derivation for 4A custodial Nostr keys.
//
// Calls KMS GenerateMac with a non-extractable HMAC-SHA-256 key to derive a
// secp256k1 secret from an OAuth identity. See ARCHITECTURE.md §
// "Custodial via OAuth (the default)" — the master HMAC key never leaves the
// HSM; the derived secret lives only on the stack of the calling function and
// is dropped as soon as signing completes. No keys persist anywhere.
//
// aws4fetch is used instead of the AWS SDK: it signs SigV4 requests in ~5KB
// of code, runs natively in Workers, and has no Node deps.

import { AwsClient } from "aws4fetch";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

export interface KmsEnv {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  KMS_DERIVATION_KEY_ID: string;
}

export interface OAuthIdentity {
  provider: string;
  oauth_id: string;
}

export interface EventTemplate {
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface SignedEvent extends EventTemplate {
  id: string;
  pubkey: string;
  sig: string;
}

// secp256k1 curve order. A valid private key is in the open interval (0, N).
// HMAC-SHA-256 outputs are uniformly random over 2^256, so the probability of
// landing on 0 or in [N, 2^256) is ~2^-128 — astronomically unlikely. We
// check anyway and re-derive with a counter suffix on the rare miss.
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const MAX_DERIVE_RETRIES = 4;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let r = 0n;
  for (let i = 0; i < bytes.length; i++) r = (r << 8n) | BigInt(bytes[i]!);
  return r;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function base64Decode(input: string): Uint8Array {
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function clampToCurveOrder(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const n = bytesToBigInt(bytes);
  return n > 0n && n < SECP256K1_N;
}

async function generateMac(message: Uint8Array, env: KmsEnv): Promise<Uint8Array> {
  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION,
    service: "kms",
  });
  const url = `https://kms.${env.AWS_REGION}.amazonaws.com/`;
  const response = await aws.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "TrentService.GenerateMac",
    },
    body: JSON.stringify({
      KeyId: env.KMS_DERIVATION_KEY_ID,
      Message: base64Encode(message),
      MacAlgorithm: "HMAC_SHA_256",
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`KMS GenerateMac failed: ${response.status} ${body}`);
  }
  const json = (await response.json()) as { Mac?: string };
  if (typeof json.Mac !== "string") {
    throw new Error("KMS GenerateMac response missing Mac field");
  }
  return base64Decode(json.Mac);
}

export async function deriveNostrKey(
  identity: OAuthIdentity,
  env: KmsEnv,
): Promise<{ secretKey: Uint8Array; publicKey: string }> {
  const base = `${identity.provider}:${identity.oauth_id}`;
  const encoder = new TextEncoder();
  for (let attempt = 0; attempt <= MAX_DERIVE_RETRIES; attempt++) {
    const message = encoder.encode(attempt === 0 ? base : `${base}:retry-${attempt}`);
    const secretKey = await generateMac(message, env);
    if (clampToCurveOrder(secretKey)) {
      const publicKey = bytesToHex(schnorr.getPublicKey(secretKey));
      return { secretKey, publicKey };
    }
  }
  throw new Error("derived secret key out of curve range across all retries");
}

export async function signEventWithDerivedKey(
  template: EventTemplate,
  identity: OAuthIdentity,
  env: KmsEnv,
): Promise<SignedEvent> {
  const { secretKey, publicKey } = await deriveNostrKey(identity, env);
  const serialized = JSON.stringify([
    0,
    publicKey,
    template.created_at,
    template.kind,
    template.tags,
    template.content,
  ]);
  const idBytes = sha256(new TextEncoder().encode(serialized));
  const id = bytesToHex(idBytes);
  const sig = bytesToHex(schnorr.sign(idBytes, secretKey));
  return { ...template, id, pubkey: publicKey, sig };
}
