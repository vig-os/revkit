// Ask-page bundler — mirrors `rail/bundle.ts`. Builds the browser-
// side Solid bundle for `/ask/<id>` at first serve, caches it for
// the daemon's lifetime.
//
// Design ties to ADR-0012 + ADR-0013 amendment 2026-09-30:
//   - Authored as `.tsx`, compiled at build time by
//     `babel-preset-solid` (Solid's DOM-expressions runtime). The
//     emitted JS contains NO `eval(` / `new Function(...)`; the
//     daemon's CSP therefore does not need `'unsafe-eval'`.
//   - Built once and cached — the bundle is deterministic in the
//     package's source tree.
//   - Kept in a dedicated file so `check-dist` / mutation tests can
//     assert on the shape independently of the rail bundle.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import { transformAsync } from "@babel/core";
// @ts-expect-error - babel-preset-solid ships no types
import solidPreset from "babel-preset-solid";
// @ts-expect-error - @babel/preset-typescript ships no types
import typescriptPreset from "@babel/preset-typescript";

function askPageSourceDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function askPageEntrypointPath(): string {
  return resolve(askPageSourceDir(), "ask-page.tsx");
}

export function askPageCssPath(): string {
  return resolve(askPageSourceDir(), "ask-page.css");
}

/** In-memory bundle handle. `js` + `css` are UTF-8 bytes ready for
 * the daemon's static branch. */
export interface AskPageBundle {
  readonly js: Uint8Array;
  readonly css: Uint8Array;
}

let cached: AskPageBundle | undefined;
let inflight: Promise<AskPageBundle> | undefined;

const solidJsxPlugin: BunPlugin = {
  name: "babel-preset-solid",
  setup(build): void {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const source = readFileSync(path, "utf8");
      const result = await transformAsync(source, {
        filename: path,
        babelrc: false,
        configFile: false,
        presets: [
          [solidPreset, { generate: "dom", hydratable: false }],
          [typescriptPreset, { allExtensions: true, isTSX: true }],
        ],
        sourceMaps: false,
      });
      if (result === null || result.code === null || result.code === undefined) {
        throw new Error(`revkit ask-page: babel returned no code for ${path}`);
      }
      return { contents: result.code, loader: "js" };
    });
  },
};

/** Build the ask-page bundle (JS + CSS). Cached; concurrent callers
 * share one build via `inflight`. */
export async function buildAskPageBundle(): Promise<AskPageBundle> {
  if (cached !== undefined) return cached;
  if (inflight !== undefined) return inflight;
  inflight = (async (): Promise<AskPageBundle> => {
    const result = await Bun.build({
      entrypoints: [askPageEntrypointPath()],
      target: "browser",
      format: "esm",
      minify: true,
      sourcemap: "none",
      plugins: [solidJsxPlugin],
    });
    if (!result.success) {
      const messages = result.logs.map((log) => log.message ?? String(log)).join("\n");
      throw new Error(`revkit ask-page: Bun.build failed:\n${messages}`);
    }
    if (result.outputs.length !== 1) {
      throw new Error(
        `revkit ask-page: Bun.build produced ${result.outputs.length} artefacts; expected 1.`,
      );
    }
    const output = result.outputs[0]!;
    const js = new Uint8Array(await output.arrayBuffer());
    const css = new Uint8Array(readFileSync(askPageCssPath()));
    const bundle: AskPageBundle = { js, css };
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
export function _resetAskPageBundleForTests(): void {
  cached = undefined;
  inflight = undefined;
}
