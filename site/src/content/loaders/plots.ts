// Loader for the `plots` collection. Wraps Astro's `glob()` so it emits one
// entry per `plots/<name>/spec.vl.json`, then adds the "url points at an
// existing sibling file" check that the schema (a purely structural pass)
// cannot enforce (ADR-0004, C4). A `data.url` that resolves to a missing
// file fails the build with a message that names the spec.
import type { Loader } from "astro/loaders";
import { glob } from "astro/loaders";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isObject, walkObjects } from "../utils/vega-lite-walk.ts";

interface PlotEntry {
  filePath?: string;
  data: Record<string, unknown>;
}

/** Every `data.url` in the spec, at any depth. Shares the tree walk with
 * the schema-side inline-data check so the loader can never validate a
 * different set of nodes than the schema rejects. */
export function collectDataUrls(spec: unknown): string[] {
  const urls: string[] = [];
  walkObjects(spec, (node) => {
    if (isObject(node.data) && typeof node.data.url === "string") {
      urls.push(node.data.url);
    }
  });
  return urls;
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/** Validate that every `data.url` in a plot entry resolves to a file next
 * to the spec on disk. Exported so unit tests can exercise it against
 * fixtures without standing up a full Astro loader context. */
export async function assertSiblingFiles(entry: PlotEntry, projectRoot: string): Promise<void> {
  if (!entry.filePath) return; // glob loader always populates it; guard for safety
  const specAbsolute = isAbsolute(entry.filePath)
    ? entry.filePath
    : resolve(projectRoot, entry.filePath);
  const specDir = dirname(specAbsolute);
  for (const url of collectDataUrls(entry.data)) {
    const dataAbsolute = resolve(specDir, url);
    if (!(await fileExists(dataAbsolute))) {
      throw new Error(
        `plots loader: ${entry.filePath}: data.url '${url}' does not exist next to the spec (looked at ${dataAbsolute}). Add the file or fix the url (ADR-0004, C4).`,
      );
    }
  }
}

/**
 * Load Vega-Lite plot specs from `../plots/<name>/spec.vl.json` and validate
 * that every `data.url` points at an existing sibling file — the sibling-
 * exists check the schema cannot perform on its own.
 */
export function plotsLoader(baseFromProjectRoot = "../plots"): Loader {
  const wrapped = glob({ base: baseFromProjectRoot, pattern: "**/spec.vl.json" });
  return {
    name: "revkit-plots-loader",
    async load(context) {
      await wrapped.load(context);
      const projectRoot = fileURLToPath(context.config.root);
      // The glob loader stores each entry with a data record and a
      // filePath (relative to the project root); PlotEntry mirrors that so
      // the sibling-file check runs on real parsed data, not raw JSON.
      for (const entry of context.store.entries()) {
        await assertSiblingFiles(entry[1] as PlotEntry, projectRoot);
      }
    },
  };
}
