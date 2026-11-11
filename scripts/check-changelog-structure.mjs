#!/usr/bin/env node
// Structural check for CHANGELOG.md (#228): no `## ` section may repeat a `### ` heading.
//
// A hand-resolved merge conflict leaves a second `### Fixed` (or any other heading) in one
// section, and the release train reads only the first block of each heading, so the rest
// would be dropped at freeze time. This is the whole check: content is not judged, so an
// empty `## Unreleased` (the shape on a release branch after the freeze, and on dev after a
// release reset) is valid.
//
// Usage: node scripts/check-changelog-structure.mjs [path]   (default: CHANGELOG.md)
// Exits 1 and names each repeated heading with its section and line numbers.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const FENCE = /^\s*(```|~~~)/;

/** Every `### ` heading repeated inside one `## ` section, with 1-based line numbers. */
export function findRepeatedHeadings(text) {
  const repeats = [];
  let section = "(preamble)";
  let seen = new Map();
  let fenced = false;
  const flush = () => {
    for (const [heading, lines] of seen) {
      if (lines.length > 1) repeats.push({ section, heading, lines });
    }
  };
  text.split("\n").forEach((line, index) => {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) return;
    if (/^## /.test(line)) {
      flush();
      section = line.slice(3).trim();
      seen = new Map();
    } else if (/^### /.test(line)) {
      const heading = line.slice(4).trim();
      seen.set(heading, [...(seen.get(heading) ?? []), index + 1]);
    }
  });
  flush();
  return repeats;
}

function main(argv) {
  const file = argv[0] ?? "CHANGELOG.md";
  const repeats = findRepeatedHeadings(readFileSync(file, "utf8"));
  for (const { section, heading, lines } of repeats) {
    console.error(`${file}: "## ${section}" repeats "### ${heading}" (lines ${lines.join(", ")}); merge into one block.`);
  }
  return repeats.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
