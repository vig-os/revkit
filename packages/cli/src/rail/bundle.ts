// Rail bundler — assembles the browser-side rail bundle at daemon startup
// with `Bun.build`, cached in memory so the daemon serves the same
// bytes for the whole session.
//
// Rationale (DESIGN-0001 §5.2, ADR-0002, ADR-0013 amendment
// 2026-09-30):
// - The rail is a Solid island authored as `.tsx` and compiled at
//   build time with `babel-preset-solid`. Solid's JSX transform
//   emits plain DOM code with no `eval` or `new Function`, so the
//   daemon's `script-src` does NOT need `'unsafe-eval'` — a real
//   widening the previous `solid-js/html` runtime forced.
// - Bun.build takes a plugin that intercepts every `.tsx` load,
//   runs it through `@babel/core` + `babel-preset-solid`, and
//   hands the transformed JS back. Everything else Bun.build does
//   (module resolution, ESM output, minification) is unchanged.
// - Building before daemon readiness, rather than at repo build time, keeps
//   the CLI package free of a committed bundle (which would be a
//   size / diff / vendored-code question the check-dist / vendor
//   guards would then have to allowlist) and lets `bun test` run
//   the real bundle in Playwright.
// - The bundle is 1 write, cache forever: it never changes during
//   the daemon's lifetime, so there is no invalidation path.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import { transformAsync } from "@babel/core";
// `babel-preset-solid` and `@babel/preset-typescript` are consumed
// as values (the Solid ecosystem calls them the same way). Neither
// ships bundled `.d.ts` files; a narrow ts-expect-error per import
// is the accepted shape for such Babel presets.
// @ts-expect-error - babel-preset-solid ships no types
import solidPreset from "babel-preset-solid";
// @ts-expect-error - @babel/preset-typescript ships no types
import typescriptPreset from "@babel/preset-typescript";

/** Where the rail entrypoint and CSS live on disk. Computed from
 * `import.meta.url` so it stays right when the package is symlinked
 * (a Bun workspace) or vendored (a devkit install). */
function railSourceDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Absolute paths to the two source files. Exported so tests can
 * point at them directly. */
export function railEntrypointPath(): string {
  return resolve(railSourceDir(), "rail.tsx");
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

/** Bun.build plugin that runs every `.tsx` file through
 * `@babel/core` with `babel-preset-solid`. The preset compiles JSX
 * to Solid's DOM-expressions runtime — plain function calls, no
 * `eval` / `new Function`. Kept as narrow as possible: it MATCHES
 * `\.tsx$` only, so plain `.ts` files stay on Bun's native loader
 * (Bun.build already handles TS syntax stripping there). */
const solidJsxPlugin: BunPlugin = {
  name: "babel-preset-solid",
  setup(build): void {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const source = readFileSync(path, "utf8");
      const result = await transformAsync(source, {
        filename: path,
        babelrc: false,
        configFile: false,
        // `babel-preset-solid` handles JSX and reads TypeScript
        // syntax as annotations it strips; we pin `generate: "dom"`
        // (the default) so a future preset default flip cannot
        // silently swap us to the SSR runtime.
        presets: [
          [solidPreset, { generate: "dom", hydratable: false }],
          // The `.tsx` files are TypeScript — babel needs the
          // TypeScript preset to strip type syntax
          // (`import { type X }`, `as unknown`, generic params).
          // Passed as a value (not a path resolve) so a workspace
          // that hoists the preset to a different depth still
          // finds it via Node's normal module lookup.
          [typescriptPreset, { allExtensions: true, isTSX: true }],
        ],
        sourceMaps: false,
      });
      if (result === null || result.code === null || result.code === undefined) {
        throw new Error(`revkit rail: babel returned no code for ${path}`);
      }
      return { contents: result.code, loader: "js" };
    });
  },
};

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
      plugins: [solidJsxPlugin],
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
