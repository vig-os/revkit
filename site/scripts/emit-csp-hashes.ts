// site/scripts/emit-csp-hashes.ts
//
// Post-build step for `revkit serve`'s ADR-0012 CSP (issue #22).
// Astro 7.3.5 has an experimental `security.csp` option, but it
// writes CSP as `<meta http-equiv>` inside every page and it does
// not integrate with Starlight's Shiki-inlined styles nor with
// Expressive-Code's runtime style hashes. The daemon needs the
// hashes as a HEADER-shaped source, not a meta tag. So we produce
// the artefact ourselves and reuse `check-dist`'s already-tested
// parse5-based inline-script detection — one detector, one source
// of truth: if `check-dist` allowlists a hash, the daemon allows
// the same hash at serve time.
//
// Output: `<dist>/.revkit/csp-hashes.json`. The schema pins the
// shape to `{ version, algorithm, hashes }`; the loader in
// `packages/cli/src/serve/csp-hashes.ts` is the source of truth for
// what each field means. The site/package.json wires this into
// `postbuild`, so `bun run build` runs the emitter after Astro
// finishes.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectInlineScriptHashes } from "../../packages/cli/src/check-dist.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = resolve(HERE, "..");
const DIST_DIR = resolve(SITE_DIR, "dist");
const ARTEFACT_PATH = resolve(DIST_DIR, ".revkit", "csp-hashes.json");

function main(): void {
  const seen = collectInlineScriptHashes(DIST_DIR);
  const hashes: string[] = Array.from(seen.keys()).sort();
  mkdirSync(dirname(ARTEFACT_PATH), { recursive: true });
  const artefact = {
    version: 1 as const,
    algorithm: "sha256" as const,
    hashes,
  };
  writeFileSync(ARTEFACT_PATH, `${JSON.stringify(artefact, null, 2)}\n`, "utf8");
  const rel = ARTEFACT_PATH.slice(SITE_DIR.length + 1);
  process.stdout.write(`emit-csp-hashes: wrote ${hashes.length} inline-script hash(es) to ${rel}\n`);
}

main();
