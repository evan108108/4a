// Public Artifacts — viewer shell (Task 3 of the public-artifacts plan).
//
// This module is dependency-free on purpose: it exports string constants and
// two pure helpers. Task 2's render endpoints import `renderViewerHtml` +
// `ARTIFACT_VIEWER_CSP` and attach them to `GET /v0/artifacts/*` responses;
// `VIEWER_JS` is served at `GET /v0/artifacts/viewer.js`.
//
// Security model (plan: "Files to modify → new src/artifact-viewer.ts"):
// - The CSP below carries 'unsafe-inline' for script-src because a blob:
//   iframe inherits the embedding page's CSP (CSP3 local-scheme inheritance);
//   artifact dashboards need their inline scripts to run.
// - The compensating INVARIANT: the shell has zero HTML-string injection
//   sinks. Every manifest-derived string reaches the DOM via `.textContent`
//   (or a property assignment like `document.title` / `a.href`), never via
//   HTML parsing. A source-regex test in artifacts-viewer.test.ts enforces
//   this over this file's full text — which is why this comment describes
//   the banned sinks without naming them.
// - The single server-side interpolation is the `<script type=
//   "application/json" id="m">` metadata island, JSON-encoded with `<`
//   escaped as `\\u003c` so `</script>` breakout is impossible.
// - The `#k=` fragment is read from `location.hash` and never leaves the
//   page: the shell's only network request is `GET /blossom/<sha256>`.
//
// Crypto interop contract (normative for all clients, pinned by test):
//   key  = 32 bytes, transported as `#k=<base64url, no padding>`
//   blob = 12-byte random IV || AES-256-GCM ciphertext+tag (single shot)
//   decrypt = importKey("raw", k, "AES-GCM") →
//             decrypt({ name: "AES-GCM", iv }, key, ct)

/** Approved v1 single-origin CSP — exact string per the implementation plan.
 *  Attached by Task 2 to BOTH render endpoints, including 404/410 pages. */
export const ARTIFACT_VIEWER_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob: data:; font-src data:; frame-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'";

/** Metadata the server embeds in the island. Extra keys are tolerated by the
 *  shell; unknown/missing optional fields simply render no chrome for them. */
export interface ArtifactViewerManifest {
  /** 64-hex sha256 of the ciphertext blob (what the shell fetches). */
  sha256: string;
  /** Manifest `type` tag, e.g. "text/html". */
  type: string;
  /** Publisher pubkey, 64-hex. */
  pubkey: string;
  /** Manifest `title` tag. */
  title?: string;
  /** Manifest created_at, unix seconds. */
  publishedAt?: number;
  /** Manifest `d` tag (slug). */
  d?: string;
  /** true = frozen-content URL, false = latest-version URL. */
  frozen?: boolean;
}

/** The shell script served at GET /v0/artifacts/viewer.js. Plain ES5-ish JS,
 *  no external deps, no template literals (keeps this literal escape-free). */
export const VIEWER_JS = `"use strict";
(function () {
  var mount = document.getElementById("mount");
  var panel = document.getElementById("panel");
  var panelTitle = document.getElementById("panel-title");
  var panelDetail = document.getElementById("panel-detail");

  function showPanel(title, detail) {
    panelTitle.textContent = title;
    panelDetail.textContent = detail || "";
    panel.hidden = false;
  }

  function readManifest() {
    var island = document.getElementById("m");
    if (!island) return null;
    try {
      var parsed = JSON.parse(island.textContent);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function b64urlDecode(s) {
    var t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4 !== 0) t += "=";
    var bin = atob(t);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function setChrome(manifest) {
    var title =
      typeof manifest.title === "string" && manifest.title !== ""
        ? manifest.title
        : "Untitled artifact";
    document.title = title + " - 4a artifact";
    document.getElementById("title").textContent = title;

    var pubkey = typeof manifest.pubkey === "string" ? manifest.pubkey : "";
    if (/^[0-9a-f]{64}$/i.test(pubkey)) {
      document.getElementById("signer").textContent =
        "signed by " + pubkey.slice(0, 8) + "\\u2026";
      var copyBtn = document.getElementById("copy-pubkey");
      copyBtn.hidden = false;
      copyBtn.addEventListener("click", function () {
        navigator.clipboard.writeText(pubkey).then(
          function () {
            copyBtn.textContent = "copied";
            setTimeout(function () { copyBtn.textContent = "copy"; }, 1200);
          },
          function () {}
        );
      });
    }

    if (typeof manifest.publishedAt === "number" && isFinite(manifest.publishedAt)) {
      document.getElementById("published").textContent =
        "published " + new Date(manifest.publishedAt * 1000).toISOString().slice(0, 10);
    }

    if (manifest.frozen === true) {
      document.getElementById("state").textContent = "frozen version";
    } else if (manifest.frozen === false) {
      document.getElementById("state").textContent = "latest version";
    }
  }

  function renderFramed(plaintext, type) {
    var url = URL.createObjectURL(new Blob([plaintext], { type: type }));
    var frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", "artifact content");
    frame.id = "artifact-frame";
    frame.src = url;
    mount.appendChild(frame);
  }

  function renderImage(plaintext, type, title) {
    var img = document.createElement("img");
    img.alt = title || "artifact image";
    img.src = URL.createObjectURL(new Blob([plaintext], { type: type }));
    mount.appendChild(img);
  }

  function renderText(plaintext) {
    var pre = document.createElement("pre");
    pre.textContent = new TextDecoder().decode(plaintext);
    mount.appendChild(pre);
  }

  function renderMedia(plaintext, type, kind) {
    var el = document.createElement(kind);
    el.controls = true;
    el.src = URL.createObjectURL(new Blob([plaintext], { type: type }));
    mount.appendChild(el);
  }

  function renderDownload(plaintext, type, sha) {
    var a = document.createElement("a");
    a.className = "download";
    a.href = URL.createObjectURL(
      new Blob([plaintext], { type: type || "application/octet-stream" })
    );
    a.download = "artifact-" + sha.slice(0, 8);
    a.textContent = "Download artifact (" + plaintext.length + " bytes)";
    mount.appendChild(a);
  }

  function render(manifest, plaintext, sha) {
    var type = (typeof manifest.type === "string" ? manifest.type : "")
      .toLowerCase()
      .split(";")[0]
      .trim();
    // SVG goes through the sandboxed-iframe path: SVG documents can carry
    // scripts, and the opaque-origin sandbox is the containment for that.
    if (type === "text/html" || type === "image/svg+xml") {
      renderFramed(plaintext, type);
    } else if (
      type === "image/png" || type === "image/jpeg" ||
      type === "image/gif" || type === "image/webp"
    ) {
      renderImage(plaintext, type, manifest.title);
    } else if (type === "text/plain" || type === "application/json") {
      renderText(plaintext);
    } else if (type.indexOf("audio/") === 0) {
      renderMedia(plaintext, type, "audio");
    } else if (type.indexOf("video/") === 0) {
      renderMedia(plaintext, type, "video");
    } else {
      renderDownload(plaintext, type, sha);
    }
  }

  var manifest = readManifest();
  if (!manifest) {
    showPanel("Viewer error", "Missing or malformed artifact metadata.");
    return;
  }
  setChrome(manifest);

  var sha = typeof manifest.sha256 === "string" ? manifest.sha256.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    showPanel("Viewer error", "Metadata is missing a valid blob hash.");
    return;
  }
  var rawLink = document.getElementById("raw-link");
  rawLink.href = "/blossom/" + sha;
  rawLink.hidden = false;

  // The key rides in the URL fragment, which the browser never sends to any
  // server; it is decoded here and used only for the local decrypt below.
  var hash = location.hash || "";
  if (hash.indexOf("#k=") !== 0) {
    showPanel(
      "Missing key",
      "This link must include its #k= fragment. Ask the sender for the complete URL."
    );
    return;
  }
  var keyBytes = null;
  try { keyBytes = b64urlDecode(hash.slice(3)); } catch (e) { keyBytes = null; }
  if (!keyBytes || keyBytes.length !== 32) {
    showPanel("Bad key", "The #k= fragment is not a valid 32-byte key.");
    return;
  }

  showPanel("Decrypting\\u2026", "");
  fetch("/blossom/" + sha)
    .then(function (res) {
      if (!res.ok) {
        throw new Error("Ciphertext fetch failed (HTTP " + res.status + ").");
      }
      return res.arrayBuffer();
    })
    .then(function (buf) {
      if (buf.byteLength < 28) {
        throw new Error("Blob is too short to be IV + AES-GCM ciphertext.");
      }
      var iv = new Uint8Array(buf, 0, 12);
      var ct = new Uint8Array(buf, 12);
      return crypto.subtle
        .importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"])
        .then(function (key) {
          return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
        })
        .catch(function () {
          throw new Error("Wrong or truncated key - decryption failed.");
        });
    })
    .then(function (plainBuf) {
      panel.hidden = true;
      render(manifest, new Uint8Array(plainBuf), sha);
    })
    .catch(function (err) {
      showPanel(
        "Could not display artifact",
        err && err.message ? err.message : "Unexpected viewer error."
      );
    });
})();
`;

// Content-hash query param for the shell's script tag: viewer.js is served
// immutable-cached, so the URL must change whenever the script does.
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const VIEWER_JS_HASH = fnv1aHex(VIEWER_JS);

/** Shell page template. `%%MANIFEST_JSON%%` is the ONLY server-side slot;
 *  fill it via `renderViewerHtml` (never by hand-concatenating JSON). */
export const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>4a artifact</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box;margin:0}
:focus{outline:none}
body{font:14px/1.5 system-ui,sans-serif;background:#f5f5f4;color:#1c1917;min-height:100vh;display:flex;flex-direction:column}
@media (prefers-color-scheme:dark){body{background:#1c1917;color:#e7e5e4}iframe{background:#fff}}
header{display:flex;align-items:baseline;gap:12px;padding:10px 16px;border-bottom:1px solid rgba(128,128,128,.35);flex-wrap:wrap}
#title{font-weight:600}
#meta{display:flex;gap:10px;align-items:baseline;font-size:12px;opacity:.75;flex-wrap:wrap}
#meta a{color:inherit}
button{font:inherit;font-size:11px;padding:0 6px;border:1px solid rgba(128,128,128,.5);border-radius:4px;background:transparent;color:inherit;cursor:pointer}
main{flex:1;display:flex;flex-direction:column}
iframe{flex:1;width:100%;border:0;background:#fff}
img,audio,video{max-width:100%;margin:16px auto;display:block}
pre{padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-word}
#panel{margin:48px auto;max-width:480px;text-align:center;padding:24px}
#panel-title{font-weight:600;margin-bottom:8px}
#panel-detail{font-size:13px;opacity:.75}
a.download{margin:48px auto;display:inline-block;padding:10px 18px;border:1px solid rgba(128,128,128,.5);border-radius:6px;color:inherit;text-decoration:none}
</style>
</head>
<body>
<header>
<div id="title"></div>
<div id="meta">
<span id="signer"></span><button id="copy-pubkey" type="button" hidden>copy</button>
<span id="published"></span>
<span id="state"></span>
<a id="raw-link" hidden>raw ciphertext</a>
</div>
</header>
<main id="mount">
<div id="panel" hidden><div id="panel-title"></div><div id="panel-detail"></div></div>
</main>
<script type="application/json" id="m">%%MANIFEST_JSON%%</script>
<script src="/v0/artifacts/viewer.js?v=${VIEWER_JS_HASH}"></script>
</body>
</html>
`;

/** JSON-encode manifest metadata for the `<script type="application/json">`
 *  island. `<` becomes `\\u003c` (valid JSON, same bytes after parse), which
 *  makes `</script>` breakout impossible; U+2028/U+2029 are escaped for the
 *  same raw-text-context reason. */
export function manifestIslandJson(manifest: ArtifactViewerManifest): string {
  return JSON.stringify(manifest)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Fill the metadata island. The replacement is passed as a function so `$`
 *  sequences in the JSON are inert (String.replace treats a string
 *  replacement's `$&`/`$'` as patterns — an injection footgun). */
export function renderViewerHtml(manifest: ArtifactViewerManifest): string {
  const json = manifestIslandJson(manifest);
  return VIEWER_HTML.replace("%%MANIFEST_JSON%%", () => json);
}
