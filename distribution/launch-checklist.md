# 4A Launch Checklist

**Owner:** Evan + Sona, jointly. **Created:** 2026-04-27. **Status:** active — work this list each session.

This is the live working list for finishing the 4A public launch. Cross-references to the deeper planning docs in this directory: `claude-connector-listing.md` (Claude.ai distribution), `chatgpt-gpt-listing.md` (GPT Store listing), `awesome-mcp.patch` (drafted PR for jaw9c/awesome-remote-mcp-servers).

When picking this up:
1. Read this file top-to-bottom.
2. Pick the first unchecked item under "Up next" that doesn't say "needs Evan."
3. Update this file when an item flips state — keep it the source of truth, not the email thread.

---

## Done (today, 2026-04-27)

- [x] Phase 2 gateway code complete + deployed (commits 50cef1c → ec1a557; deploy version 7a65be3d).
- [x] AWS KMS HMAC derivation set up via CFN stack `fourA-kms` (key `alias/4a-derivation-v1`, IAM user `4a-gateway-worker`).
- [x] Sonata commons + genesis events published to relays.
- [x] `/docs/connectors` landing page live at https://4a4.ai/docs/connectors/.
- [x] `/get-started` onboarding page live at https://4a4.ai/get-started/.
- [x] `/privacy` page live at https://4a4.ai/privacy/ (GPT/connector privacy URL).
- [x] OpenAPI surface (`surfaces/chatgpt-action.json`) carries publish + read paths.
- [x] Relay set hardened (commit 32d001d): dropped paid `nostr.wine`; new default = damus, nos.lol, nostr.mom, primal, offchain.pub, bitcoiner.social. Retry-with-backoff on rate-limited responses (5s base, doubling, 5min cap, max 4). RelayResult status enum `accepted | rate-limited-retrying | failed-permanent`. Post-deploy smoke 30/30.
- [x] Distribution research + tier plan written (`claude-connector-listing.md`).
- [x] GPT Store listing copy + assets spec written (`chatgpt-gpt-listing.md`).
- [x] Draft PR for jaw9c/awesome-remote-mcp-servers prepared (`awesome-mcp.patch`).
- [x] Launch posts drafted (X / HN / Nostr long-form — held in memory, not posted).

---

## Up next — needs Evan (≤30 min total)

These are quick checks/decisions only Evan can make. Doing them unblocks most of "I can do."

- [ ] **Confirm Google OAuth Publishing Status = "In production."** Evan said "we went straight to production" — verify in 30 seconds: Google Cloud Console → APIs & Services → OAuth consent screen → "Publishing status." If it says "In production," reply "good to push" on either email thread. If it says "Testing," click "Publish app." (Reference: thread 770165bd.)
- [ ] **Decide logo / favicon source.** Hand-design or punt to a tool (e.g., Figma + a few hours, or a generator)? Spec from `chatgpt-gpt-listing.md`: flat indigo `#1d4ed8`, white "4A" monospace bold. Needed for: GPT icon, Anthropic Directory submission, social cards.
- [ ] **Decide awesome-list PR cadence:** parallel (jaw9c + punkpeye + nostr-list at once) or sequenced (one merged before the next)? Default if no answer: serial — jaw9c first, observe response, then fan out.
- [ ] **Decide JWT_SIGNING_KEY rotation.** Smoke test still blocked locally because the key is write-only in wrangler. Rotation is safe IF active OAuth sessions are acceptable to invalidate (forces ChatGPT GPT + Claude.ai connector users to re-auth). Reply yes/no on thread 35820abb-d0bd-4a6b-9786-fdca055b57f9.

## Up next — Sona can do (in order, after Evan unblocks above)

- [ ] **Push the awesome-remote-mcp PR** (jaw9c). Patch is ready at `distribution/awesome-mcp.patch`; PR body in section 5 of `claude-connector-listing.md`. Trigger: Evan reply "good to push" after confirming Google OAuth is in production.
- [ ] **Submit to Official MCP Registry** via `mcp-publisher` CLI. ~1 hour. Pulls the existing surface manifest; downstream Glama/PulseMCP/mcp.so auto-mirror.
- [ ] **Open additional awesome-list PRs** in chosen cadence: punkpeye/awesome-mcp-servers (largest reach), then any Nostr-specific lists worth filing in.
- [ ] **Verify tool annotations** on the MCP surface meet Anthropic Directory reviewer expectations (description + sample input/output per tool). Patch surfaces if needed.
- [ ] **Generate the 3–5 GPT/Directory screenshots** (≥1000px PNG) once we have a logo. Subjects: read query, publish flow, addressable URL, Claude.ai install, /get-started page.
- [ ] **Submit to Anthropic Connectors Directory** at https://clau.de/mcp-directory-submission — last, after assets exist + signal accumulated. Review email: mcp-review@anthropic.com.
- [ ] **Rotate launch posts (X / HN / Nostr long-form)** out of "draft only" once Evan greenlights timing. Drafts already in memory, tagged `4a-launch-draft`.

## Up next — joint / either-of-us

- [ ] **Publish the ChatGPT GPT.** Evan: chatgpt.com/gpts/editor → Share → "Public on GPT Store" (or "Anyone with the link" first for soft launch). Sona: monitor inbox after publish for review-related emails, store any reviewer notes as memories.
- [ ] **Slow-burn community posts** — r/mcp, MCP Discord #showcase, MCP GitHub Discussions, HN Show HN. Evan posts; Sona drafts the wording per channel and watches for Q&A that needs a response.

---

## Watch list (don't act unless triggered)

- [ ] OAuth secrets on prod: `/auth/github/*` and `/auth/google/*` were 500ing earlier ("OAuth not configured"). If GPT/Claude.ai users ever hit those paths and fail, set `GITHUB_OAUTH_CLIENT_ID`/`SECRET` + Google equivalents via `wrangler secret put`.
- [ ] Phase 2 smoke test (`npm run smoke-test:phase2`) — blocked on JWT_SIGNING_KEY decision above.
- [ ] Relay retry queue — currently empty (100% acceptance on launch day). If `/v0/health` ever shows `liveConnections < 6` for >10 min, investigate the affected relay; the retry queue should hold rate-limited events but degraded-relay skip-then-probe is intentionally not implemented yet (add later if needed).

---

## Open questions (parking lot)

- After launch, do we expand to additional OAuth providers (Apple, Microsoft) or hold at Google + GitHub?
- Aggregator relay strategy — when we want a 4A-specific aggregator vs riding general-purpose relays. (Reference: `relay-economics.md`, `4a/relay-economics` wiki.)
- Custodial-only forever, or add a self-custody path (NIP-46 bunker → custom keypair) once usage warrants it?

---

## How this doc evolves

- Add new items as they surface — don't keep them in email threads.
- Move items to "Done" with a date when complete; never delete.
- If an item sits >7 days, ask Evan whether it's actually still on the plan or should be cut.
- Reference long-form context in the sibling docs (`claude-connector-listing.md`, `chatgpt-gpt-listing.md`); keep this file a checklist, not a plan.
