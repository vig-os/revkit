// vendored-code (ADR-0022): every subdirectory under
// `packages/components/vendor/<pkg>/` must be a properly vendored drop
// — an upstream LICENSE file whose license is permissive and
// Apache-2.0-compatible (MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0,
// ISC), an UPSTREAM provenance file recording where the drop came
// from (repo URL + full commit SHA + upstream path), and a matching
// entry in the repo-root NOTICE. The rule also refuses phantom
// entries: a package listed in NOTICE with no directory to back it
// up.
//
// Runs once per `revkit check` invocation (no per-file filter — a
// commit that only touches NOTICE or a vendored LICENSE still needs
// the guard to fire). The vendor directory not existing is a
// silent pass so a downstream fork that deletes both the vendor tree
// and NOTICE does not trip the rule.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "../diagnostics.ts";

/** Repo-root-relative POSIX path where vendored packages live (ADR-0022). */
export const VENDOR_DIR = "packages/components/vendor";

/** Repo-root NOTICE filename. Apache-2.0 convention: the file ships
 * with any built distribution and names third-party code inside. */
export const NOTICE_FILE = "NOTICE";

/** SPDX identifiers the guard accepts. Copyleft (GPL / LGPL / AGPL /
 * MPL / EPL / SSPL) and anything unrecognised are refused so a
 * maintainer has to think before vendoring. */
const ALLOWED_SPDX: ReadonlySet<string> = new Set([
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "ISC",
]);

/** Fallback text patterns to identify each allowed license when the
 * upstream LICENSE has no SPDX-License-Identifier header (many older
 * MIT / BSD / Apache LICENSE files pre-date SPDX). Order matters:
 * BSD-3 must be probed before BSD-2 (BSD-3 is BSD-2 plus a
 * no-endorsement clause). MIT is probed before Apache to keep an MIT
 * file that happens to mention "Apache" from misclassifying. */
const LICENSE_TEXT_PATTERNS: readonly {
  readonly spdx: string;
  readonly test: (text: string) => boolean;
}[] = [
  {
    spdx: "MIT",
    test: (text) =>
      /permission is hereby granted, free of charge, to any person obtaining a copy/i.test(text) &&
      /the above copyright notice and this permission notice shall be included/i.test(text),
  },
  {
    spdx: "BSD-3-Clause",
    test: (text) =>
      /redistribution and use in source and binary forms/i.test(text) &&
      /neither the name of (?:the )?(?:copyright holder|[^\s]+) (?:nor|or) the names of (?:its|other) contributors/i.test(text),
  },
  {
    spdx: "BSD-2-Clause",
    test: (text) =>
      /redistribution and use in source and binary forms/i.test(text) &&
      /this list of conditions and the following disclaimer in the documentation/i.test(text),
  },
  {
    spdx: "Apache-2.0",
    test: (text) => /Apache License[\s,]+Version 2\.0/i.test(text),
  },
  {
    spdx: "ISC",
    test: (text) =>
      /permission to use, copy, modify,? and\/or distribute this software/i.test(text),
  },
];

/** Detect the license of an upstream LICENSE file. Prefers an
 * `SPDX-License-Identifier:` header (unambiguous); falls back to a
 * text pattern match. `null` means "unrecognised — refuse". */
export function detectSpdx(licenseText: string): string | null {
  const spdxMatch = licenseText.match(/SPDX-License-Identifier:\s*([\w.\-+]+)/);
  if (spdxMatch !== null && spdxMatch[1] !== undefined) {
    return spdxMatch[1];
  }
  for (const { spdx, test } of LICENSE_TEXT_PATTERNS) {
    if (test(licenseText)) return spdx;
  }
  return null;
}

/** Required keys in an UPSTREAM file. `path` may be an empty
 * value when the vendored drop is the entire upstream package, but
 * the key must still be present so the drop is documented. */
const UPSTREAM_REQUIRED_KEYS: readonly string[] = ["repo", "commit", "path"];

/** A full git SHA — 40 lowercase hex chars. Short SHAs move over
 * time (a rewritten history can re-issue the prefix), so the guard
 * refuses anything shorter. */
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

interface UpstreamParse {
  readonly missing: readonly string[];
  readonly badCommit: string | null;
  readonly badRepo: string | null;
}

/** Parse an UPSTREAM file into its recorded keys. Uses a simple
 * `key: value` grammar (blank lines and `#` comments ignored), which
 * matches how the vendor README documents the format. */
export function parseUpstream(text: string): UpstreamParse {
  const found = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    found.set(key, value);
  }
  const missing = UPSTREAM_REQUIRED_KEYS.filter((k) => {
    if (k === "path") return !found.has(k); // path may be empty
    const value = found.get(k);
    return value === undefined || value.length === 0;
  });
  const commit = found.get("commit") ?? "";
  const badCommit = commit.length > 0 && !COMMIT_SHA_RE.test(commit) ? commit : null;
  const repo = found.get("repo") ?? "";
  // A repo URL that is not http(s) is refused — the point of recording
  // it is that a reviewer can follow the link.
  const badRepo = repo.length > 0 && !/^https?:\/\//i.test(repo) ? repo : null;
  return { missing, badCommit, badRepo };
}

/** Regex that picks up `- packages/components/vendor/<name>` bullet
 * entries in NOTICE. The leading `-` marker and the anchor at
 * line-start keep prose that mentions the vendor path
 * (e.g. "under packages/components/vendor/") from being parsed as
 * an entry. */
const NOTICE_ENTRY_RE = /^\s*-\s+packages\/components\/vendor\/([A-Za-z0-9._-]+)/gm;

/** Extract the set of vendored package names listed as entries in a
 * NOTICE text. */
export function noticeEntries(noticeText: string): Set<string> {
  const names = new Set<string>();
  // Reset lastIndex — the regex has the `g` flag and is a module
  // singleton, so successive calls would otherwise resume mid-string.
  NOTICE_ENTRY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NOTICE_ENTRY_RE.exec(noticeText)) !== null) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

/** Run the vendored-code guard against a repo root. Emits one
 * diagnostic per problem, keyed to the specific file (NOTICE, the
 * vendor package's LICENSE, its UPSTREAM, or the package dir
 * itself). */
export function checkVendoredCode(repoRoot: string): Diagnostic[] {
  const findings: Diagnostic[] = [];
  const vendorAbs = join(repoRoot, VENDOR_DIR);
  const noticeAbs = join(repoRoot, NOTICE_FILE);

  // Vendor dir missing means the rule stays silent. A revkit tree
  // ships one, so a downstream fork that deletes it is opting out.
  if (!existsSync(vendorAbs)) return findings;

  let entries;
  try {
    entries = readdirSync(vendorAbs, { withFileTypes: true });
  } catch (error) {
    findings.push({
      file: `${VENDOR_DIR}/`,
      line: 0,
      rule: "vendored-code",
      message: `cannot read vendor dir: ${(error as Error).message}`,
    });
    return findings;
  }

  const packageDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const noticeExists = existsSync(noticeAbs) && statSync(noticeAbs).isFile();
  const noticeText = noticeExists ? readFileSync(noticeAbs, "utf8") : "";

  if (!noticeExists && packageDirs.length > 0) {
    findings.push({
      file: NOTICE_FILE,
      line: 0,
      rule: "vendored-code",
      message: `NOTICE is missing but ${packageDirs.length} vendored package(s) exist under ${VENDOR_DIR}/ (ADR-0022).`,
    });
  }

  const listedInNotice = noticeEntries(noticeText);

  for (const pkg of packageDirs) {
    const pkgRel = `${VENDOR_DIR}/${pkg}`;
    const pkgAbs = join(vendorAbs, pkg);

    // (1) Upstream LICENSE — required, permissive.
    const licenseAbs = join(pkgAbs, "LICENSE");
    if (!existsSync(licenseAbs) || !statSync(licenseAbs).isFile()) {
      findings.push({
        file: `${pkgRel}/`,
        line: 0,
        rule: "vendored-code",
        message: "missing upstream LICENSE file (ADR-0022).",
      });
    } else {
      const licenseText = readFileSync(licenseAbs, "utf8");
      const spdx = detectSpdx(licenseText);
      if (spdx === null) {
        findings.push({
          file: `${pkgRel}/LICENSE`,
          line: 0,
          rule: "vendored-code",
          message:
            "unrecognised license — add an `SPDX-License-Identifier:` header, or use one of MIT / BSD-2-Clause / BSD-3-Clause / Apache-2.0 / ISC (ADR-0022).",
        });
      } else if (!ALLOWED_SPDX.has(spdx)) {
        findings.push({
          file: `${pkgRel}/LICENSE`,
          line: 0,
          rule: "vendored-code",
          message: `license '${spdx}' is not permitted; only MIT / BSD-2-Clause / BSD-3-Clause / Apache-2.0 / ISC are compatible with Apache-2.0 (ADR-0022).`,
        });
      }
    }

    // (2) UPSTREAM provenance file — repo + commit + path.
    const upstreamAbs = join(pkgAbs, "UPSTREAM");
    if (!existsSync(upstreamAbs) || !statSync(upstreamAbs).isFile()) {
      findings.push({
        file: `${pkgRel}/`,
        line: 0,
        rule: "vendored-code",
        message:
          "missing UPSTREAM file — must record `repo:`, `commit:` and `path:` (see packages/components/vendor/README.md).",
      });
    } else {
      const parsed = parseUpstream(readFileSync(upstreamAbs, "utf8"));
      if (parsed.missing.length > 0) {
        findings.push({
          file: `${pkgRel}/UPSTREAM`,
          line: 0,
          rule: "vendored-code",
          message: `UPSTREAM is missing required key(s): ${parsed.missing.join(", ")}.`,
        });
      }
      if (parsed.badCommit !== null) {
        findings.push({
          file: `${pkgRel}/UPSTREAM`,
          line: 0,
          rule: "vendored-code",
          message: `UPSTREAM 'commit:' must be a full 40-char git SHA (got '${parsed.badCommit}'); short SHAs are not stable.`,
        });
      }
      if (parsed.badRepo !== null) {
        findings.push({
          file: `${pkgRel}/UPSTREAM`,
          line: 0,
          rule: "vendored-code",
          message: `UPSTREAM 'repo:' must be an http(s):// URL (got '${parsed.badRepo}').`,
        });
      }
    }

    // (3) Listed in NOTICE.
    if (!listedInNotice.has(pkg)) {
      findings.push({
        file: NOTICE_FILE,
        line: 0,
        rule: "vendored-code",
        message: `vendored package '${pkg}' is not listed in NOTICE — add '- ${pkgRel} — <upstream URL> (SPDX: <id>)'.`,
      });
    }
  }

  // (4) NOTICE lists packages that do not exist.
  const existing = new Set(packageDirs);
  for (const listed of [...listedInNotice].sort()) {
    if (!existing.has(listed)) {
      findings.push({
        file: NOTICE_FILE,
        line: 0,
        rule: "vendored-code",
        message: `NOTICE lists '${VENDOR_DIR}/${listed}' but no such directory exists under ${VENDOR_DIR}/.`,
      });
    }
  }

  return findings;
}
