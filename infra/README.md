# 4A — AWS infrastructure as code

CloudFormation templates for the AWS-side resources 4A depends on. Single source of truth for what should exist in the AWS account; replaces the manual click-through runbook in `docs/phase-2-aws-setup.md`.

## Stacks

| Stack | Template | Resources |
|---|---|---|
| `fourA-kms` | [`aws-kms.yaml`](./aws-kms.yaml) | KMS HMAC derivation key, alias, gateway IAM user, inline policy |

## Why CloudFormation (not Terraform / CDK)

- No state file. The stack itself is the state, managed by AWS. No shared backend to provision before the first deploy.
- Native to AWS. Works with the AWS CLI we already use; no extra tooling.
- Idempotent via `aws cloudformation deploy` — re-runs converge to the template.
- Small footprint today. If 4A grows beyond a handful of AWS resources, revisit Terraform / CDK.

## Deploying a fresh account

```bash
aws cloudformation deploy \
  --template-file infra/aws-kms.yaml \
  --stack-name fourA-kms \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1

# Get the outputs (KMS_DERIVATION_KEY_ID, region, etc.)
aws cloudformation describe-stacks \
  --stack-name fourA-kms \
  --region us-east-1 \
  --query 'Stacks[0].Outputs'
```

Then issue an access key for the gateway user (one-shot, never re-issued by CFN):

```bash
aws iam create-access-key --user-name 4a-gateway-worker
```

Drop the access key + secret + region + KMS key ARN into `/Users/evan/projects/4a/.env`, then push as wrangler secrets.

## Importing an account that was provisioned by hand

If the resources already exist (because someone walked through `docs/phase-2-aws-setup.md` before this template existed), import them into the stack with a change set:

```bash
aws cloudformation create-change-set \
  --stack-name fourA-kms \
  --change-set-name initial-import \
  --change-set-type IMPORT \
  --resources-to-import '[
    {"ResourceType":"AWS::KMS::Key","LogicalResourceId":"DerivationKey","ResourceIdentifier":{"KeyId":"<key-uuid>"}},
    {"ResourceType":"AWS::KMS::Alias","LogicalResourceId":"DerivationKeyAlias","ResourceIdentifier":{"AliasName":"alias/4a-derivation-v1"}},
    {"ResourceType":"AWS::IAM::User","LogicalResourceId":"GatewayUser","ResourceIdentifier":{"UserName":"4a-gateway-worker"}},
    {"ResourceType":"AWS::IAM::UserPolicy","LogicalResourceId":"GatewayUserPolicy","ResourceIdentifier":{"UserName":"4a-gateway-worker","PolicyName":"4a-gateway-kms-derivation"}}
  ]' \
  --template-body file://infra/aws-kms.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1
```

Inspect the change set, then execute it. All four resources (key, alias, user, inline user-policy) are imported — CFN refuses to create a change set unless every resource defined in the template is either being imported or already in the stack.

## Rotation

The KMS key has `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` — CloudFormation will never destroy it, even if the resource is removed from the template. This is deliberate: deleting the derivation key vaporizes every custodial user's Nostr identity. See `docs/phase-2-aws-setup.md` §8 for the intended rotation path.

Access keys are intentionally **not** managed by this stack. Letting CloudFormation manage `AWS::IAM::AccessKey` means a stack drift could rotate the live credentials behind the running Worker. Issue keys via `aws iam create-access-key` and rotate them with the `infra:keys:rotate` runbook (TODO).

## What's not (yet) in this stack

- Cloudflare resources (Workers, DNS, R2). Those live in `gateway/wrangler.toml`.
- AWS access keys. See above.
- AWS CloudTrail data events on the KMS key. CloudTrail management events are on by default and free; data events would be a separate (paid) decision.
