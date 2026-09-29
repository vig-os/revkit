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

interface PlotEntry {
  filePath?: string;
  data: Record<string, unknown>;
}

/** Walk the loaded spec and collect every `data.url` value; needed because
 * a Vega-Lite spec can carry a data block at any depth. */
function collectDataUrls(spec: unknown): string[] {
  const urls: string[] = [];
  const stack: unknown[] = [spec];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (
        key === "data" &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        const dataObject = value as Record<string, unknown>;
        if (typeof dataObject.url === "string") urls.push(dataObject.url);
      }
      stack.push(value);
    }
  }
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

async function assertSiblingFiles(entry: PlotEntry, projectRoot: string): Promise<void> {
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
