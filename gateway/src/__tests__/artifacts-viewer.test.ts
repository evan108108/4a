// Viewer shell tests — Task 3 of the public-artifacts plan.
//
// Plan verification contract:
//   - source-regex INVARIANT: artifact-viewer.ts contains no HTML-string
//     injection sinks (the compensator for script-src 'unsafe-inline').
//   - scenario 9, byte/crypto interop: node-side WebCrypto encrypt
//     (IV || ct) decrypts with the shell's exact algorithm parameters to
//     byte-identical plaintext.
//   - CSP header string matches the approved v1 single-origin policy
//     verbatim.
//   - manifest-derived strings cannot become active markup in the shell
//     page (metadata island encoding).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ARTIFACT_VIEWER_CSP,
  VIEWER_HTML,
  VIEWER_JS,
  VIEWER_JS_HASH,
  manifestIslandJson,
  renderViewerHtml,
  type ArtifactViewerManifest,
} from "../artifact-viewer";

const VIEWER_SOURCE = readFileSync(
  new URL("../artifact-viewer.ts", import.meta.url),
  "utf8",
);

function makeManifest(overrides: Partial<ArtifactViewerManifest> = {}): ArtifactViewerManifest {
  return {
    sha256: "ab".repeat(32),
    type: "text/html",
    pubkey: "cd".repeat(32),
    title: "Q3 Pipeline Dashboard",
    publishedAt: 1785250000,
    d: "my-dashboard",
    frozen: true,
    ...overrides,
  };
}

// ── INVARIANT: no HTML-string injection sinks in the shell ─────────────────

describe("source-regex INVARIANT", () => {
  it("artifact-viewer.ts contains no innerHTML / insertAdjacentHTML / document.write", () => {
    expect(VIEWER_SOURCE).not.toMatch(/innerHTML/);
    expect(VIEWER_SOURCE).not.toMatch(/insertAdjacentHTML/);
    expect(VIEWER_SOURCE).not.toMatch(/document\s*\.\s*write/);
  });

  it("shell inserts manifest strings via textContent", () => {
    // Not a substitute for review, but pins the mechanism the plan names.
    expect(VIEWER_JS).toMatch(/\.textContent\s*=/);
  });
});

// ── Scenario 9: byte/crypto interop ────────────────────────────────────────

describe("crypto interop (IV || AES-256-GCM ciphertext+tag)", () => {
  const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const IV = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
  const PLAINTEXT = new TextEncoder().encode(
    "<html><body><script>document.title='hi'</script>artifact round-trip</body></html>",
  );

  async function encryptBlob(): Promise<Uint8Array> {
    const encKey = await crypto.subtle.importKey("raw", KEY, "AES-GCM", false, ["encrypt"]);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: IV }, encKey, PLAINTEXT),
    );
    const blob = new Uint8Array(12 + ct.length);
    blob.set(IV, 0);
    blob.set(ct, 12);
    return blob;
  }

  it("decrypts with the shell's exact algorithm parameters to byte-identical plaintext", async () => {
    const blob = await encryptBlob();
    // GCM appends a 16-byte tag; layout is IV(12) || ciphertext+tag.
    expect(blob.length).toBe(12 + PLAINTEXT.length + 16);

    // Mirror of the shell: split at 12, importKey("raw", k, "AES-GCM"),
    // decrypt({ name: "AES-GCM", iv }, key, ct).
    const iv = blob.subarray(0, 12);
    const ct = blob.subarray(12);
    const key = await crypto.subtle.importKey("raw", KEY, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));

    expect(plain).toEqual(PLAINTEXT);
  });

  it("rejects a tampered ciphertext (GCM tag integrity)", async () => {
    const blob = await encryptBlob();
    blob[blob.length - 1]! ^= 0x01;
    const key = await crypto.subtle.importKey("raw", KEY, "AES-GCM", false, ["decrypt"]);
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12) }, key, blob.subarray(12)),
    ).rejects.toThrow();
  });

  it("shell source pins the same WebCrypto calls and blob split", () => {
    expect(VIEWER_JS).toContain('importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"])');
    expect(VIEWER_JS).toContain('crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct)');
    expect(VIEWER_JS).toContain("new Uint8Array(buf, 0, 12)");
    expect(VIEWER_JS).toContain("new Uint8Array(buf, 12)");
    expect(VIEWER_JS).toContain("keyBytes.length !== 32");
  });
});

// ── CSP exact match ─────────────────────────────────────────────────────────

describe("CSP header string", () => {
  it("matches the approved v1 single-origin policy verbatim", () => {
    expect(ARTIFACT_VIEWER_CSP).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "img-src blob: data:; media-src blob: data:; font-src data:; frame-src blob:; " +
        "connect-src 'self'; base-uri 'none'; form-action 'none'",
    );
  });
});

// ── HTML injection guard ────────────────────────────────────────────────────

describe("metadata island encoding", () => {
  it("a hostile title cannot become active markup", () => {
    const xss = "<script>alert(1)</script>";
    const html = renderViewerHtml(makeManifest({ title: xss }));

    expect(html).not.toContain(xss);
    expect(html).toContain("\\u003cscript>alert(1)\\u003c/script>");
    // Exactly two script opens: the JSON island and the viewer.js loader.
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).not.toContain("%%MANIFEST_JSON%%");
  });

  it("the island parses back to the original manifest", () => {
    const manifest = makeManifest({ title: "</script><script>alert(2)</script>" });
    const html = renderViewerHtml(manifest);
    const island = html.match(
      /<script type="application\/json" id="m">([\s\S]*?)<\/script>/,
    );
    expect(island).not.toBeNull();
    expect(JSON.parse(island![1]!)).toEqual(manifest);
  });

  it("dollar-sequence titles survive the slot replacement literally", () => {
    // String.replace treats $& / $' / $` in a string replacement as
    // patterns; renderViewerHtml must be immune (function replacement).
    const title = "price $& $' $` $$ 100%";
    const html = renderViewerHtml(makeManifest({ title }));
    const island = html.match(
      /<script type="application\/json" id="m">([\s\S]*?)<\/script>/,
    );
    expect(JSON.parse(island![1]!).title).toBe(title);
  });

  it("escapes U+2028/U+2029 (raw-text context hazards)", () => {
    const json = manifestIslandJson(makeManifest({ title: "a\u2028b\u2029c" }));
    expect(json).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.parse(json).title).toBe("a\u2028b\u2029c");
  });
});

// ── Shell template + sandbox discipline ─────────────────────────────────────

describe("viewer shell template", () => {
  it("VIEWER_HTML keeps the single %%MANIFEST_JSON%% slot", () => {
    expect(VIEWER_HTML.split("%%MANIFEST_JSON%%")).toHaveLength(2);
  });

  it("loads viewer.js with the content-hash cache-buster", () => {
    expect(VIEWER_JS_HASH).toMatch(/^[0-9a-f]{8}$/);
    expect(VIEWER_HTML).toContain(`src="/v0/artifacts/viewer.js?v=${VIEWER_JS_HASH}"`);
  });

  it("iframe sandbox is allow-scripts only", () => {
    expect(VIEWER_JS).toContain('setAttribute("sandbox", "allow-scripts")');
    expect(VIEWER_SOURCE).not.toContain("allow-same-origin");
    expect(VIEWER_SOURCE).not.toContain("allow-forms");
    expect(VIEWER_SOURCE).not.toContain("allow-popups");
    expect(VIEWER_SOURCE).not.toContain("allow-top-navigation");
  });

  it("the shell's only network fetch is the blossom ciphertext", () => {
    const fetches = VIEWER_JS.match(/fetch\(/g);
    expect(fetches).toHaveLength(1);
    expect(VIEWER_JS).toContain('fetch("/blossom/" + sha)');
    // The fragment key is read from location.hash and never interpolated
    // into any URL.
    expect(VIEWER_JS).not.toMatch(/fetch\([^)]*k[eE]y/);
  });

  it("SVG routes through the sandboxed iframe, not <img>", () => {
    expect(VIEWER_JS).toMatch(
      /type === "text\/html" \|\| type === "image\/svg\+xml"/,
    );
  });
});
