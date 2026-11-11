#!/usr/bin/env node
// Stamp the release version into every place that must carry it (#201, ADR-0021).
//
// Called by the consumer-owned prepare-release seam
// (.github/workflows/prepare-release-extension.yml) on `release/X.Y.Z`, so the
// commit every candidate and the final tag point at already carries `X.Y.Z`:
//
//   - packages/cli/package.json            top-level "version"  (the one source)
//   - packages/worker/wrangler.jsonc       vars.REVKIT_VERSION  (asset path segment)
//   - templates/default/flake.nix,
//     templates/default/README.md,
//     README.md,
//     templates/skills/revkit/SKILL.md     `github:vig-os/revkit?ref=X.Y.Z` pins
//
// Usage: node scripts/set-release-version.mjs <X.Y.Z> [--root <dir>] [--file <path>] [--dry-run]
//   --root <dir>   stamp every target under <dir> (default: this repository)
//   --file <path>  stamp only that file; its kind is chosen by name
//                  (package.json, *.jsonc, anything else = ref pins)
// Prints `changed` or `unchanged` on stdout, then (when changed) the changed
// paths relative to the root, one per line. All other bytes are preserved.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, relative, resolve } from "node:path";

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const WORKER_VAR = /("REVKIT_VERSION"\s*:\s*)"[^"]*"/g;
const REF_PIN = /(github:vig-os\/revkit\?ref=)[0-9A-Za-z._-]+/g;

function assertRelease(version) {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(`not a release version (expected X.Y.Z): ${version}`);
  }
}

/** Span [start, end) of the string value of the top-level "version" key. */
function topLevelVersionSpan(text) {
  JSON.parse(text);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const afterString = /^\s*:\s*"/.exec(text.slice(end + 1));
      if (depth === 1 && text.slice(i + 1, end) === "version" && afterString) {
        const start = end + 1 + afterString[0].length - 1;
        let close = start + 1;
        while (text[close] !== '"') close += text[close] === "\\" ? 2 : 1;
        return [start, close + 1];
      }
      i = end;
    }
  }
  return undefined;
}

/** Return `manifestText` with its top-level "version" set to `version`. */
export function stampVersion(manifestText, version) {
  assertRelease(version);
  const span = topLevelVersionSpan(manifestText);
  if (!span) throw new Error('manifest has no top-level "version" key');
  return `${manifestText.slice(0, span[0])}"${version}"${manifestText.slice(span[1])}`;
}

/** Return `configText` (wrangler.jsonc) with vars.REVKIT_VERSION set to `version`. */
export function stampWorkerVar(configText, version) {
  assertRelease(version);
  const count = [...configText.matchAll(WORKER_VAR)].length;
  if (count !== 1) throw new Error(`expected exactly one REVKIT_VERSION binding, found ${count}`);
  return configText.replace(WORKER_VAR, `$1"${version}"`);
}

/** Return `text` with every `github:vig-os/revkit?ref=<tag>` pin set to `version`. */
export function stampRefPins(text, version) {
  assertRelease(version);
  if (!REF_PIN.test(text)) throw new Error("no `github:vig-os/revkit?ref=` pin to stamp");
  REF_PIN.lastIndex = 0;
  return text.replace(REF_PIN, `$1${version}`);
}

/** Paths (relative to the repository root) and the stamper each one needs. */
export const TARGETS = [
  ["packages/cli/package.json", stampVersion],
  ["packages/worker/wrangler.jsonc", stampWorkerVar],
  ["templates/default/flake.nix", stampRefPins],
  ["templates/default/README.md", stampRefPins],
  ["README.md", stampRefPins],
  ["templates/skills/revkit/SKILL.md", stampRefPins],
];

function stamperFor(file) {
  if (basename(file) === "package.json") return stampVersion;
  if (file.endsWith(".jsonc")) return stampWorkerVar;
  return stampRefPins;
}

function main(argv) {
  const args = [...argv];
  const usage = "usage: set-release-version.mjs <X.Y.Z> [--root <dir>] [--file <path>] [--dry-run]\n";
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
      throw new Error(`${flag} needs a value\n${usage.trim()}`);
    }
    return args.splice(i, 2)[1];
  };
  const dryRun = args.includes("--dry-run");
  if (dryRun) args.splice(args.indexOf("--dry-run"), 1);
  const here = dirname(fileURLToPath(import.meta.url));
  const file = take("--file");
  const root = resolve(take("--root") ?? resolve(here, ".."));
  const [version, ...extra] = args;
  if (!version || extra.length > 0) {
    process.stderr.write(usage);
    return 2;
  }
  const targets = file
    ? [[resolve(file), stamperFor(file)]]
    : TARGETS.map(([path, stamp]) => [resolve(root, path), stamp]);
  const changed = [];
  for (const [path, stamp] of targets) {
    const before = readFileSync(path, "utf8");
    const after = stamp(before, version);
    if (after === before) continue;
    if (!dryRun) writeFileSync(path, after);
    changed.push(relative(root, path));
  }
  process.stdout.write(`${changed.length > 0 ? "changed" : "unchanged"}\n`);
  for (const path of changed) process.stdout.write(`${path}\n`);
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
