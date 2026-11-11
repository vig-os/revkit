// plot-structure (C4, ADR-0004, ADR-0005): every `plots/*/spec.vl.json`
// validates against the same schema the site uses (`plotSpecSchema`), and
// every `data.url` in the spec resolves to a real sibling file that is
// not a symlink pointing out of the spec directory. Reuses the site
// package's schema + `collectDataUrls` walker so a change to what counts
// as a plot stays in one place.

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { Diagnostic } from "../diagnostics.ts";
import { plotSpecSchema, isSiblingFilename } from "../../../../site/src/content/schemas/plots.ts";
import { collectDataUrls } from "../../../../site/src/content/loaders/plots.ts";

/** Strip a trailing separator so a prefix check reads as `dir + sep + rest`
 * rather than `dir + sep + sep + rest`. Shared with the site's confined
 * read helper — factored out so a future refactor keeps one definition. */
function withoutTrailingSep(dir: string): string {
  return dir.endsWith(sep) ? dir.slice(0, -1) : dir;
}

/** Validate that `absolute` really sits inside `containerReal`. Uses
 * `realpath` on the candidate so a symlink cannot escape the containment
 * check by pointing at a sibling directory. */
function isContainedRealPath(absolute: string, containerReal: string): boolean {
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    return false;
  }
  const container = withoutTrailingSep(containerReal);
  return real === container || real.startsWith(`${container}${sep}`);
}

/** Check one plot spec at `absoluteSpecPath`. Returns diagnostics for any
 * failure — the check does not read the data file's content (the schema
 * only cares about presence and shape). */
export function checkPlotSpecFile(
  absoluteSpecPath: string,
  reportPath: string,
): Diagnostic[] {
  // Basic shape: spec.vl.json must sit under plots/<name>/ — the schema
  // is fine with anywhere, but the loader assumes this shape. Enforce it
  // here so `plots/bundle-sizes/spec.vl.json` is required and a stray
  // `plots/spec.vl.json` gets a clear error.
  const specDir = dirname(absoluteSpecPath);
  const findings: Diagnostic[] = [];
  if (basename(absoluteSpecPath) !== "spec.vl.json") {
    findings.push({
      file: reportPath,
      line: 0,
      rule: "plot-structure",
      message: "plot spec files must be named `spec.vl.json` under `plots/<name>/` (ADR-0004, C4).",
    });
    return findings;
  }

  let raw: string;
  try {
    raw = readFileSync(absoluteSpecPath, "utf8");
  } catch (error) {
    findings.push({
      file: reportPath,
      line: 0,
      rule: "plot-structure",
      message: `cannot read spec: ${(error as Error).message}`,
    });
    return findings;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    findings.push({
      file: reportPath,
      line: 0,
      rule: "plot-structure",
      message: `not valid JSON: ${(error as Error).message}`,
    });
    return findings;
  }

  const result = plotSpecSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      findings.push({
        file: reportPath,
        line: 0,
        rule: "plot-structure",
        message: `schema: ${path}: ${issue.message}`,
      });
    }
    return findings;
  }

  // Sibling data files: each `data.url` must exist next to the spec, must
  // not be a symlink, and its real path must sit inside the spec dir.
  const specDirReal = withoutTrailingSep(realpathSync(specDir));
  for (const url of collectDataUrls(result.data)) {
    if (!isSiblingFilename(url)) {
      // The schema already flagged this — a duplicate is noisy.
      continue;
    }
    const candidate = resolve(specDirReal, url);
    // lstat: refuse a symlinked data file outright (matches
    // site/src/lib/plot-file-io.ts).
    let lstat;
    try {
      lstat = lstatSync(candidate);
    } catch {
      findings.push({
        file: reportPath,
        line: 0,
        rule: "plot-structure",
        message: `data.url '${url}' does not exist next to the spec (ADR-0004, C4).`,
      });
      continue;
    }
    if (lstat.isSymbolicLink()) {
      findings.push({
        file: reportPath,
        line: 0,
        rule: "plot-structure",
        message: `data.url '${url}' is a symlink; refused (symlinks would let a data file escape the plot directory).`,
      });
      continue;
    }
    // Also refuse a non-regular-file (fifo, socket). And check containment
    // via realpath to catch a bind-mount / hardlink escape.
    try {
      if (!statSync(candidate).isFile()) {
        findings.push({
          file: reportPath,
          line: 0,
          rule: "plot-structure",
          message: `data.url '${url}' is not a regular file.`,
        });
        continue;
      }
    } catch {
      // stat failure after a successful lstat implies a broken link or
      // permission problem — surface as missing.
      findings.push({
        file: reportPath,
        line: 0,
        rule: "plot-structure",
        message: `data.url '${url}' cannot be read.`,
      });
      continue;
    }
    if (!isContainedRealPath(candidate, specDirReal)) {
      const outside = relative(specDirReal, candidate);
      findings.push({
        file: reportPath,
        line: 0,
        rule: "plot-structure",
        message: `data.url '${url}' resolves outside the spec dir (${outside}).`,
      });
    }
  }

  return findings;
}
