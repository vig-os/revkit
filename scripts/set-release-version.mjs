#!/usr/bin/env node
// Stamp the release version into the single version source (#201, ADR-0021).
//
// Called by the consumer-owned prepare-release seam
// (.github/workflows/prepare-release-extension.yml) on `release/X.Y.Z`, so the
// commit every candidate and the final tag point at already carries `X.Y.Z`.
//
// Usage: node scripts/set-release-version.mjs <X.Y.Z> [--file <package.json>] [--dry-run]
// Prints `changed` or `unchanged` on stdout. Only the top-level "version" line
// is rewritten; the rest of the file is byte-for-byte preserved.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_LINE = /^(\s*"version"\s*:\s*)"[^"]*"/m;

/** Return `manifestText` with its top-level "version" set to `version`. */
export function stampVersion(manifestText, version) {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(`not a release version (expected X.Y.Z): ${version}`);
  }
  if (!VERSION_LINE.test(manifestText)) {
    throw new Error('manifest has no top-level "version" line');
  }
  return manifestText.replace(VERSION_LINE, `$1"${version}"`);
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    return args.splice(i, 2)[1];
  };
  const dryRun = args.includes("--dry-run");
  if (dryRun) args.splice(args.indexOf("--dry-run"), 1);
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(take("--file") ?? resolve(here, "../packages/cli/package.json"));
  const [version, ...extra] = args;
  if (!version || extra.length > 0) {
    process.stderr.write("usage: set-release-version.mjs <X.Y.Z> [--file <package.json>] [--dry-run]\n");
    return 2;
  }
  const before = readFileSync(file, "utf8");
  const after = stampVersion(before, version);
  if (after !== before && !dryRun) writeFileSync(file, after);
  process.stdout.write(`${after === before ? "unchanged" : "changed"}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`set-release-version: ${error.message}\n`);
    process.exitCode = 1;
  }
}
