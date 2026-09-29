// Confined-read helper for plot data files (ADR-0004, C4).
//
// Every read of a plot's data file — the Vega file loader that fetches
// `data.url` at render time AND the column-check that runs before
// rendering — routes through {@link readConfinedSibling} so all three
// containment rules apply exactly once, in one place:
//
// 1. Schema shape (`isSiblingFilename`): no scheme, no leading `/`, no
//    `..` — bare sibling filename (or nested subdirectory of the spec).
// 2. Symlink refusal (`lstat`): a data file that IS a symbolic link is
//    refused outright, even when its target lives inside the spec dir,
//    so the containment check can never be misled by a link.
// 3. Real-path containment (`realpath`): the actual filesystem path of
//    the resolved file must sit inside the actual filesystem path of
//    the spec directory. Plain `resolve()` compares lexical paths,
//    which does not follow links.
//
// Errors NEVER include the target file's contents. A bug in this helper
// that let a symlinked file through would otherwise leak the target's
// first line into the CI log via the column-error message
// (`"Columns in the file: [root:x:0:0…]"`), so the helper controls both
// the read AND the shape of the failure it surfaces.

import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { isSiblingFilename } from "../content/schemas/plots.ts";

/** Result of a successful confined read: the absolute real-path of the
 * file on disk (for logging / debugging) and its UTF-8 text. */
export interface ConfinedRead {
  absolutePath: string;
  text: string;
}

/** Trim a trailing path separator from `dir` so a prefix check reads as
 * `dir + sep + rest` rather than `dir + sep + sep + rest`. */
function withoutTrailingSep(dir: string): string {
  return dir.endsWith(sep) ? dir.slice(0, -1) : dir;
}

/**
 * Read a plot's sibling data file, applying the ADR-0004 containment
 * rules in a single pass. Throws with a stable, contents-free error
 * message whenever any rule is violated — the failure never carries
 * text from the file whose reading was refused.
 *
 * The check runs once per URL, so both the pre-render field-validator
 * and the Vega runtime loader route through the same code path.
 */
export async function readConfinedSibling(
  specDir: string,
  url: string,
): Promise<ConfinedRead> {
  if (!isSiblingFilename(url)) {
    throw new Error(
      `plot loader refused a non-sibling data url: ${JSON.stringify(url)}`,
    );
  }
  const specDirReal = withoutTrailingSep(await realpath(specDir));
  const candidate = resolve(specDirReal, url);

  const stat = await lstat(candidate).catch(() => null);
  if (stat === null) {
    throw new Error(`plot loader: data file not found: ${url}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `plot loader refused a symlinked data file: ${url} ` +
        `(symlinks would let a data file escape the plot directory).`,
    );
  }
  const targetReal = await realpath(candidate);
  if (
    targetReal !== specDirReal &&
    !targetReal.startsWith(`${specDirReal}${sep}`)
  ) {
    const outside = relative(specDirReal, targetReal);
    throw new Error(
      `plot loader refused to read outside the spec dir: ${url} ` +
        `(real target ${outside} sits above the spec directory).`,
    );
  }
  const text = await readFile(targetReal, "utf8");
  return { absolutePath: targetReal, text };
}
