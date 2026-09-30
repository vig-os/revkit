// Rail bundler — assembles the browser-side rail bundle on demand
// with `Bun.build`, cached in memory so the daemon serves the same
// bytes for the whole session.
//
// Rationale (DESIGN-0001 §5.2, ADR-0002):
// - The rail is a Solid island; Solid ships as ESM in `node_modules`,
//   so `Bun.build({target: "browser"})` resolves and minifies it
//   without a babel-preset-solid step.
// - Building at first serve, rather than at repo build time, keeps
//   the CLI package free of a committed bundle (which would be a
//   size / diff / vendored-code question the check-dist / vendor
//   guards would then have to allowlist) and lets `bun test` run the
//   real bundle in Playwright.
// - The bundle is 1 write, cache forever: it never changes during
//   the daemon's lifetime, so there is no invalidation path.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the rail entrypoint and CSS live on disk. Computed from
 * `import.meta.url` so it stays right when the package is symlinked
 * (a Bun workspace) or vendored (a devkit install). */
function railSourceDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Absolute paths to the two source files. Exported so tests can
 * point at them directly. */
export function railEntrypointPath(): string {
  return resolve(railSourceDir(), "rail.ts");
}
export function railCssPath(): string {
  return resolve(railSourceDir(), "rail.css");
}

/** In-memory bundle handle — bytes plus content type. */
export interface RailBundle {
  readonly js: Uint8Array;
  readonly css: Uint8Array;
}

let cached: RailBundle | undefined;
let inflight: Promise<RailBundle> | undefined;

/** Build the rail bundle (JS + CSS). Cached; concurrent callers share
 * one build via `inflight`. */
export async function buildRailBundle(): Promise<RailBundle> {
  if (cached !== undefined) return cached;
  if (inflight !== undefined) return inflight;
  inflight = (async (): Promise<RailBundle> => {
    // `Bun.build` is the runtime bundler — resolves node_modules,
    // minifies, and targets the browser. `format: "esm"` gives us a
    // module the daemon can serve as `type="module"`. `sourcemap:
    // "none"` keeps the payload small (a paths-in-map would also
    // leak absolute source paths, ADR-0013).
    const result = await Bun.build({
      entrypoints: [railEntrypointPath()],
      target: "browser",
      format: "esm",
      minify: true,
      sourcemap: "none",
    });
    if (!result.success) {
      const messages = result.logs.map((log) => log.message ?? String(log)).join("\n");
      throw new Error(`revkit rail: Bun.build failed:\n${messages}`);
    }
    if (result.outputs.length !== 1) {
      throw new Error(
        `revkit rail: Bun.build produced ${result.outputs.length} artefacts; expected 1.`,
      );
    }
    const output = result.outputs[0]!;
    const js = new Uint8Array(await output.arrayBuffer());
    const css = new Uint8Array(readFileSync(railCssPath()));
    const bundle: RailBundle = { js, css };
    cached = bundle;
    return bundle;
  })();
  try {
    return await inflight;
  } finally {
    inflight = undefined;
  }
}

/** Test-only: drop the memoised bundle so the next call rebuilds. */
export function _resetRailBundleForTests(): void {
  cached = undefined;
  inflight = undefined;
}
