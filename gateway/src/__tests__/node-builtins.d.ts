// Ambient declarations for the node builtins the viewer tests use. The
// repo's tsconfig pins `types` to @cloudflare/workers-types (no @types/node
// on purpose); vitest runs on node ≥ 20 where these exist at runtime.
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}

interface ImportMeta {
  url: string;
}
