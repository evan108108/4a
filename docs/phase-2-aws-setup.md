# Phase 2 — AWS KMS + IAM setup runbook

This is the one-time setup Evan does to provision the AWS-side resources the gateway will call from Cloudflare Workers in Phase 2 (custodial publishing).

Time budget: ~15 minutes in the AWS Console.

---

## 1. Why this exists

Phase 2 introduces custodial publishing: a user signs in with GitHub OAuth, and the gateway derives their Nostr keypair on demand from their OAuth identity. The gateway holds **no per-user keys** — every signing request re-derives the private key in-memory from a single non-extractable HMAC key in AWS KMS, via `kms:GenerateMac`. The KMS key is the only long-lived secret in the whole system; it never leaves the HSM, and the IAM credentials below are the only thing that can talk to it.

See [`ARCHITECTURE.md`](../ARCHITECTURE.md) → "Why Cloudflare Workers + AWS KMS" and "Custodial via OAuth" for the design rationale.

---

## 2. Prerequisites

- An AWS account. Free-tier is fine — KMS HMAC operations are sub-cent at expected scale (see §7).
- Permission to create IAM users and KMS keys in that account (root, or an admin IAM user).
- Decide on a region before starting. This runbook uses **`us-east-1`**. If you choose another region, use it consistently in every step below — KMS keys are regional, and the ARN bakes the region in.

> **Region note.** `us-east-1` is the cheapest, has the most KMS feature coverage, and is where most AWS docs default. Cloudflare Workers call AWS KMS from whatever PoP serves the request, so picking a region close to the bulk of your users matters less than picking one and sticking with it. If 4A grows enough to care about KMS regional latency, the right move is multi-region replicated keys — that is a Phase 2.5+ decision.

---

## 3. Step-by-step

### a. Create the HMAC key in AWS KMS

1. Sign in to the AWS Console as a user with KMS admin permissions.
2. Confirm the region selector (top-right) reads **US East (N. Virginia) us-east-1**. If not, switch it now — every later step assumes this region.
3. In the search bar at the top of the console, type **KMS** and click **Key Management Service**.
4. In the left nav, click **Customer managed keys**.
5. Click **Create key** (top-right).
6. **Configure key** page:
   - **Key type:** Symmetric
   - **Key usage:** Generate and verify MAC
   - Expand **Advanced options** and confirm:
     - **Key material origin:** KMS
     - **Regionality:** Single-Region key
   - Click **Next**.
7. **Specify key MAC algorithm** page:
   - Check **HMAC_SHA_256** (uncheck the others).
   - Click **Next**.
8. **Add labels** page:
   - **Alias:** `4a-derivation-v1`
     (the console will store this as `alias/4a-derivation-v1`)
   - **Description:** `4A custodial Nostr key derivation. HMAC-SHA-256 over oauth_provider:oauth_user_id. Do not delete or rotate without reading docs/phase-2-aws-setup.md §8.`
   - **Tags:**
     - `project` = `4a`
     - `purpose` = `nostr-derivation`
   - Click **Next**.
9. **Define key administrative permissions** page:
   - Leave the admin set as the IAM user/role you are signed in as. Do **not** add the gateway IAM user here — administrators can schedule deletion, which we do not want the gateway principal to be able to do.
   - Click **Next**.
10. **Define key usage permissions** page:
    - Leave this empty. We will write the key policy by hand in step §5 to lock the key to exactly one IAM user with exactly one action.
    - Click **Next**.
11. **Review** page:
    - The auto-generated policy will list only the admin principal under `kms:*`. That is fine — we will paste the final policy in a moment.
    - Click **Finish**.
12. You are now on the key detail page. **Capture three things into a scratch buffer:**
    - **Key ID** (UUID-shaped, e.g. `1a2b3c4d-5e6f-7890-abcd-ef1234567890`)
    - **Key ARN** (e.g. `arn:aws:kms:us-east-1:123456789012:key/1a2b3c4d-5e6f-7890-abcd-ef1234567890`)
    - **Alias ARN** (`arn:aws:kms:us-east-1:123456789012:alias/4a-derivation-v1`)

Leave this tab open — you will paste the final key policy here in step §5 once the IAM user exists.

### b. Create the IAM user for the Worker

1. In the AWS Console search bar, type **IAM** and click **IAM**.
2. Left nav → **Users** → **Create user**.
3. **Specify user details** page:
   - **User name:** `4a-gateway-worker`
   - Leave **Provide user access to the AWS Management Console** *unchecked*. This user is for programmatic access only; it never logs into the console.
   - Click **Next**.
4. **Set permissions** page:
   - Select **Attach policies directly**.
   - Do **not** attach any managed policies. Scroll past the policy list.
   - Click **Next**.
5. **Review and create** page:
   - Confirm there are zero permissions attached.
   - Click **Create user**.
6. You are returned to the user list. Click on `4a-gateway-worker` to open its detail page.
7. Click the **Permissions** tab → **Add permissions** → **Create inline policy**.
8. Switch the editor to **JSON** and paste the policy from §4 below, with `<key-arn-from-step-a>` replaced by the **Key ARN** captured in step §3a.12.
9. Click **Next**.
10. **Policy name:** `4a-gateway-kms-derivation`. Click **Create policy**.

The user now has exactly one permission: `kms:GenerateMac` on exactly one key.

### c. Generate the IAM access key

1. Still on the `4a-gateway-worker` detail page → **Security credentials** tab.
2. Scroll to **Access keys** → **Create access key**.
3. **Use case:** select **Application running outside AWS**.
   - The console will warn you to "consider alternatives." We have considered them: the Worker runs on Cloudflare, not AWS, so role-assumption is not available. Click **Next**.
4. **Description tag value:** `cloudflare-worker-4a-gateway`. Click **Create access key**.
5. **Copy both values now**, before clicking Done. The secret is shown exactly once.
   - **Access key ID** (begins with `AKIA…`)
   - **Secret access key** (40 char base64-ish blob)
6. Click **Done**.

### d. Add credentials to `/Users/evan/projects/4a/.env`

The `.env` file is already gitignored (verified — see `.gitignore` line 6). Open it and append:

```bash
# AWS KMS — Phase 2 custodial Nostr key derivation
# Created via docs/phase-2-aws-setup.md on <DATE>.
# IAM user: 4a-gateway-worker (only permission: kms:GenerateMac on KMS_DERIVATION_KEY_ID)
AWS_ACCESS_KEY_ID=AKIA...                    # from step c.5
AWS_SECRET_ACCESS_KEY=...                    # from step c.5
AWS_REGION=us-east-1
KMS_DERIVATION_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/1a2b3c4d-5e6f-7890-abcd-ef1234567890
```

Use the **Key ARN** for `KMS_DERIVATION_KEY_ID` (not the alias and not the bare UUID). The full ARN avoids any ambiguity about region or account when the Worker constructs the SigV4 request.

When the Worker is deployed, these four values get pushed as Cloudflare Worker secrets via `wrangler secret put`. They never live in `wrangler.toml` and never get committed.

---

## 4. The IAM policy JSON

Paste this into the inline policy editor in step §3b.8. Replace `<key-arn-from-step-a>` with the actual Key ARN.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowDerivationOnly",
      "Effect": "Allow",
      "Action": "kms:GenerateMac",
      "Resource": "<key-arn-from-step-a>"
    }
  ]
}
```

This is deliberately minimal:

- **One action.** `kms:GenerateMac` is all the Worker ever calls. No `Sign`, no `Encrypt`, no `DescribeKey`, no `ListKeys`.
- **One resource.** A specific key ARN, not `*`. If a second 4A key is ever created (e.g. a rotation key), the gateway will get a separate IAM policy or a separate user — not a wildcard.
- **No conditions on region or VPC.** Cloudflare Workers do not have a stable source IP range, so IP-pinning is not viable. The two layers of defense are: (1) `Resource` is one specific key, and (2) the IAM access key only ever sits in Cloudflare Worker secrets.

---

## 5. The KMS key policy JSON

Go back to the KMS console tab from step §3a.12. Click **Switch to policy view** (top-right of the Key policy section). Replace the entire policy with the JSON below, substituting:

- `<account-id>` → your 12-digit AWS account ID (visible top-right of the console)
- `<key-arn>` → the Key ARN from step §3a.12

```json
{
  "Version": "2012-10-17",
  "Id": "4a-derivation-v1-key-policy",
  "Statement": [
    {
      "Sid": "EnableRootAccountAdmin",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<account-id>:root"
      },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "AllowGatewayWorkerToDeriveOnly",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<account-id>:user/4a-gateway-worker"
      },
      "Action": "kms:GenerateMac",
      "Resource": "<key-arn>"
    },
    {
      "Sid": "DenyEverythingElseToGatewayWorker",
      "Effect": "Deny",
      "Principal": {
        "AWS": "arn:aws:iam::<account-id>:user/4a-gateway-worker"
      },
      "NotAction": "kms:GenerateMac",
      "Resource": "*"
    }
  ]
}
```

What each statement does:

- `EnableRootAccountAdmin` — keeps the AWS-recommended root-account fallback so you cannot accidentally lock yourself out of the key. The root account is protected by the AWS root MFA, not by IAM credentials.
- `AllowGatewayWorkerToDeriveOnly` — explicitly grants the gateway IAM user the one action it needs. Combined with the IAM-side policy in §4, this is belt-and-suspender: even if someone modifies the IAM policy, the key policy still gates the action.
- `DenyEverythingElseToGatewayWorker` — explicit deny on every other KMS action for this principal on this key. Defense-in-depth: if the IAM policy ever gets widened by mistake, the key policy still says no.

Click **Save changes**.

---

## 6. Verification

Install the AWS CLI if you don't have it (`brew install awscli`), then configure a profile pointing at the new IAM user:

```bash
aws configure --profile 4a-gateway-worker
# AWS Access Key ID: AKIA... (from step c.5)
# AWS Secret Access Key: ... (from step c.5)
# Default region name: us-east-1
# Default output format: json
```

### Check 1: the key exists and you can read its metadata

```bash
aws kms describe-key \
  --key-id alias/4a-derivation-v1 \
  --region us-east-1 \
  --profile 4a-gateway-worker
```

Expected: this should **fail** with `AccessDeniedException` because the gateway IAM user does *not* have `kms:DescribeKey`. That is correct — the gateway should not be able to introspect the key. To verify the key exists, run the same command with your admin profile:

```bash
aws kms describe-key \
  --key-id alias/4a-derivation-v1 \
  --region us-east-1
```

Expected: a JSON document with `KeyState: Enabled`, `KeyUsage: GENERATE_VERIFY_MAC`, `KeySpec: HMAC_256`, and the `MultiRegion: false` flag.

### Check 2: the gateway user can call GenerateMac

```bash
aws kms generate-mac \
  --key-id alias/4a-derivation-v1 \
  --message "$(printf 'github:12345' | base64)" \
  --mac-algorithm HMAC_SHA_256 \
  --region us-east-1 \
  --profile 4a-gateway-worker
```

Expected: a JSON response containing `Mac` (a base64 string ~44 chars), `MacAlgorithm: HMAC_SHA_256`, and the `KeyId` ARN. The same input should always return the same `Mac` — that is the whole point of deterministic derivation.

Run the command twice with the same input. The `Mac` field should be byte-identical.

### Check 3: the gateway user cannot do anything else

```bash
aws kms list-keys \
  --region us-east-1 \
  --profile 4a-gateway-worker
```

Expected: `AccessDeniedException`. If this returns a list of keys, the IAM policy is too permissive — go back to step §3b.8.

```bash
aws kms encrypt \
  --key-id alias/4a-derivation-v1 \
  --plaintext "$(printf 'hello' | base64)" \
  --region us-east-1 \
  --profile 4a-gateway-worker
```

Expected: `AccessDeniedException` (also, the key would refuse this anyway because its KeyUsage is MAC, not encryption — but the IAM denial fires first). If this returns a ciphertext, the policy is wrong.

---

## 7. Cost expectations

| Item | Unit cost | Expected v0 monthly |
|---|---|---|
| KMS HMAC key (resident) | $1 / month / key | **$1** |
| `kms:GenerateMac` calls | $0.03 / 10,000 calls | **<$0.01** at v0 traffic |
| CloudTrail data events on the key | free for management events; data events $0.10/100k | **$0** (we only enable management events) |

**Total expected: ~$1/month flat**, until 4A has real adoption. At one million publishes per month, KMS calls add ~$3, total ~$4/month. The cost crossover where KMS becomes meaningful (>$50/mo) sits north of 15M publishes/month — far past v0.

The IAM user, the access key, and the key policy are all free. CloudTrail management events covering `kms:GenerateMac` calls are free and are the audit trail of record.

---

## 8. Rotation playbook (deferred)

This is **not** a v0 concern. Documenting it now so future-Evan does not have to reverse-engineer the design.

**Why rotation is non-trivial.** The HMAC key is the master secret for every custodial user's Nostr keypair. A naive rotation — replacing the key — would re-derive every user to a new pubkey, orphaning all their published 4A events and credibility scores. Automatic KMS key rotation is therefore **disabled** on this key (KMS does not auto-rotate HMAC keys by default, but it should never be enabled either).

**The intended rotation path.** Add a rotation counter to the derivation:

```
oauth_id_string = oauth_provider + ":" + oauth_user_id + ":" + rotation_counter
```

The counter starts at `0` (v0 behavior — implicit) and increments per-user when the user explicitly opts into rotation. The counter lives somewhere user-visible (NIP-32 self-published label, JWT claim, or a small KV store — to be decided). Old pubkeys remain valid for reading historical events; the user re-attests their identity under the new pubkey to migrate credibility.

**Compromise scenario.** If the master HMAC key is suspected compromised (e.g. AWS HSM CVE), the response is *not* rotation — it is an emergency announcement that all custodial users should `GET /me/export` immediately and migrate to a NIP-46 bunker or local self-hosting. Rotation does not help here because the attacker already has the derivation power; the only safe state is for users to move off the custodial path entirely.

---

## 9. What NOT to do

- **Do not put `AWS_SECRET_ACCESS_KEY` in any git-tracked file.** Not `wrangler.toml`, not a sample `.env` checked in for tests, not a comment in source. It belongs in `.env` (gitignored) and in Cloudflare Worker secrets.
- **Do not grant the gateway IAM user any permission beyond `kms:GenerateMac`** on this one key. No `DescribeKey`, no `ListKeys`, no `Encrypt`, no second key. Adding permissions is a one-way ratchet — strip them now if they crept in.
- **Do not enable automatic KMS key rotation on `alias/4a-derivation-v1`.** AWS does not auto-rotate HMAC keys today, but if that ever becomes available, leave it off. Rotation changes the master HMAC secret, which would re-derive every custodial user to a new Nostr keypair and orphan all their published 4A events and credibility attestations.
- **Do not delete the key as a "let's start over" gesture.** KMS deletion has a 7-30 day waiting period precisely because deletion is unrecoverable: every custodial user's Nostr identity is the deterministic output of this key plus their OAuth ID. Deleting the key vaporizes every 4A custodial pubkey forever.
- **Do not create a second derivation key in another region "for redundancy."** Two keys produce two different derived pubkeys for the same user, which defeats the entire deterministic design. If multi-region ever becomes necessary, use a KMS multi-region replicated key (one logical key, multiple regional replicas, identical key material).
