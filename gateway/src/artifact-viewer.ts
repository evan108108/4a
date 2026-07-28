// ── STUB — the real viewer shell lives in Task 3's version of this file ──
//
// Task 2 (endpoints) needs VIEWER_HTML / VIEWER_JS to exist so the render
// endpoints and their tests can run before Task 3 lands. At integration,
// Task 3's artifact-viewer.ts replaces this file wholesale; nothing here is
// meant to survive.
//
// Contract the real file must keep (what artifacts.ts substitutes):
//   - VIEWER_HTML: full HTML document template containing the literal slot
//     %%MANIFEST_JSON%% inside a <script type="application/json" id="m">
//     island. artifacts.ts replaces it with the manifest metadata JSON
//     ({sha256, pubkey, d, title, type, created_at, event_id, mode}),
//     JSON-encoded with `<` escaped as <.
//   - Optional slot %%VIEWER_JS_HASH%%: replaced with a content hash of
//     VIEWER_JS for cache-busting the /v0/artifacts/viewer.js script tag.
//   - VIEWER_JS: the shell script served at GET /v0/artifacts/viewer.js.
//   - INVARIANT (enforced by a source-regex test): no innerHTML /
//     insertAdjacentHTML / document.write anywhere in this file.

export const VIEWER_HTML = `<html><head><meta charset="utf-8"><title>4a artifact</title></head><body>PLACEHOLDER<script type="application/json" id="m">%%MANIFEST_JSON%%</script><script src="/v0/artifacts/viewer.js?v=%%VIEWER_JS_HASH%%"></script></body></html>`;

export const VIEWER_JS = `/* PLACEHOLDER — real viewer shell ships with Task 3 (artifact-viewer.ts) */`;
