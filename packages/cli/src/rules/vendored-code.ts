// vendored-code (ADR-0022) — every `packages/components/vendor/<pkg>/`
// subdirectory must be a properly vendored drop:
//
//   1. `UPSTREAM` records `repo:` (https:// URL with a host, no query
//      or fragment), `commit:` (full 40-char git SHA), `path:` (may
//      be empty when the whole repo is vendored), and `license:`
//      (exactly one SPDX id from the allowlist — no compound `AND` /
//      `OR` / `WITH` expressions, no parentheses).
//   2. `LICENSE` is a real, non-symlinked file named exactly
//      `LICENSE` (case-sensitive; `LICENSE.md` / `License` /
//      `license` / `COPYING` get a rename hint).
//   3. `NOTICE` at the repo root carries an entry of the form
//      `- packages/components/vendor/<pkg> — <upstream URL> (SPDX: <id>)`
//      whose id equals the UPSTREAM `license:`.
//   4. No loose files at `packages/components/vendor/` root except
//      `README.md`; no symlinks anywhere in the vendor tree; every
//      `LICENSE`, `UPSTREAM` and `NOTICE` is a real file
//      (lstat-checked); package dir names are unscoped.
//
// Note on LICENSE-text matching. A first draft used phrase-level
// heuristics; a second draft normalised both sides and compared
// against SPDX plain-text templates. Both were bypassable: real
// upstream LICENSE files vary widely (curly quotes, per-line
// comment prefixes like `// `, condensed paragraphs), while an
// adversary can add clauses whose normalised form still contains
// the canonical text (Commons Clause after `END OF TERMS`, "Good,
// not Evil", replaced condition lines). Text matching that both
// admits real fixtures (shadcn-solid, kobalte, react, apache.org
// LICENSE-2.0.txt, re2, freebsd COPYRIGHT) AND refuses adversarial
// bodies needs a full SPDX-template matcher (SPDX License Matching
// Guidelines v2.1 with template `<<var>>` / `<<beginOptional>>`
// handling). That belongs behind a well-tested library, not a
// hand-rolled normaliser here.
//
// So LICENSE bytes are checked by MANUAL REVIEW until the
// SPDX-template matcher tracked in #33 lands. `.github/CODEOWNERS`
// REQUESTS the maintainer's review on `packages/components/vendor/`
// and `NOTICE`, but that becomes an ENFORCED merge gate only once
// branch protection on `dev` requires code-owner review — an
// org-config change outside this repo. This rule enforces every
// STRUCTURAL check (UPSTREAM validity, symlink refusal, layout /
// naming, NOTICE format + SPDX id echoing UPSTREAM) so the
// maintainer's review is over a small, known-shaped surface — the
// LICENSE bytes themselves.

import { lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "../diagnostics.ts";

/** Repo-relative POSIX path where vendored packages live (ADR-0022). */
export const VENDOR_DIR = "packages/components/vendor";

/** Repo-root NOTICE filename. Apache-2.0 convention: the file ships
 * with any built distribution and names third-party code inside. */
export const NOTICE_FILE = "NOTICE";

/** Permissive SPDX ids compatible with Apache-2.0. Copyleft
 * (GPL / LGPL / AGPL / MPL / EPL / SSPL) and compound expressions are
 * refused: the vendored-code contract wants one clear license per
 * drop. */
export const ALLOWED_SPDX: readonly string[] = [
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
];
const ALLOWED_SPDX_SET: ReadonlySet<string> = new Set(ALLOWED_SPDX);

// -----------------------------------------------------------------------------
// UPSTREAM parser
// -----------------------------------------------------------------------------

const UPSTREAM_REQUIRED: readonly string[] = ["repo", "commit", "path", "license"];
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const SPDX_ID_RE = /^[A-Za-z0-9.\-+]+$/;
/** Compound SPDX expression markers — bare AND/OR/WITH tokens or
 * parentheses. `AND` / `OR` / `WITH` are matched case-insensitively
 * with word boundaries. */
const COMPOUND_SPDX_RE = /\b(?:AND|OR|WITH)\b|[()]/i;

export interface UpstreamProblem {
  readonly message: string;
}

export interface UpstreamResult {
  readonly problems: readonly UpstreamProblem[];
  /** SPDX id when a permitted single-license value was parsed;
   * `null` otherwise (missing, compound, unknown, or forbidden). */
  readonly license: string | null;
}

/** Parse UPSTREAM into recorded keys + a list of problems. Uses a
 * simple `key: value` grammar; blank lines and `#` comments ignored.
 * Duplicate keys are refused. */
export function parseUpstream(text: string): UpstreamResult {
  const problems: UpstreamProblem[] = [];
  const found = new Map<string, string>();
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) {
      problems.push({
        message: `UPSTREAM line is not 'key: value' (got: '${rawLine}').`,
      });
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    if (seen.has(key)) {
      problems.push({ message: `UPSTREAM key '${key}' is set more than once.` });
      continue;
    }
    seen.add(key);
    found.set(key, line.slice(idx + 1).trim());
  }

  for (const req of UPSTREAM_REQUIRED) {
    const value = found.get(req);
    if (value === undefined) {
      problems.push({ message: `UPSTREAM is missing required key '${req}:'.` });
      continue;
    }
    if (req !== "path" && value.length === 0) {
      problems.push({ message: `UPSTREAM key '${req}:' has an empty value.` });
    }
  }

  const repo = found.get("repo") ?? "";
  if (repo.length > 0) {
    let url: URL | null = null;
    try {
      url = new URL(repo);
    } catch {
      url = null;
    }
    if (url === null) {
      problems.push({ message: `UPSTREAM 'repo:' is not a valid URL ('${repo}').` });
    } else if (url.protocol !== "https:") {
      problems.push({
        message: `UPSTREAM 'repo:' must use https:// (got '${url.protocol}//' in '${repo}').`,
      });
    } else if (url.host.length === 0) {
      problems.push({ message: `UPSTREAM 'repo:' has no host ('${repo}').` });
    } else if (url.search.length > 0 || url.hash.length > 0) {
      problems.push({
        message: `UPSTREAM 'repo:' must not carry a query or fragment ('${repo}').`,
      });
    }
  }

  const commit = found.get("commit") ?? "";
  if (commit.length > 0 && !COMMIT_SHA_RE.test(commit)) {
    problems.push({
      message: `UPSTREAM 'commit:' must be a full 40-char git SHA (got '${commit}'); short SHAs are not stable.`,
    });
  }

  let license: string | null = null;
  const licenseRaw = found.get("license") ?? "";
  if (licenseRaw.length > 0) {
    if (COMPOUND_SPDX_RE.test(licenseRaw)) {
      problems.push({
        message: `UPSTREAM 'license:' must be exactly one SPDX id, not a compound expression (got '${licenseRaw}'). Split the drop, or pick the single SPDX id that governs the vendored source.`,
      });
    } else if (!SPDX_ID_RE.test(licenseRaw)) {
      problems.push({
        message: `UPSTREAM 'license:' is not a valid SPDX id (got '${licenseRaw}').`,
      });
    } else if (!ALLOWED_SPDX_SET.has(licenseRaw)) {
      problems.push({
        message: `UPSTREAM 'license:' '${licenseRaw}' is not permitted; only ${ALLOWED_SPDX.join(" / ")} are compatible with Apache-2.0 (ADR-0022).`,
      });
    } else {
      license = licenseRaw;
    }
  }

  return { problems, license };
}

// -----------------------------------------------------------------------------
// NOTICE parser
// -----------------------------------------------------------------------------

/** NOTICE entry regex — strict:
 *   `- packages/components/vendor/<name> ... (SPDX: <id>)`
 * The line-start anchor + the leading `- ` bullet keep prose that
 * mentions the vendor path in passing from being captured. `<name>`
 * is the unscoped package-dir name (see PACKAGE_NAME_RE). */
const NOTICE_ENTRY_RE = /^\s*-\s+packages\/components\/vendor\/([A-Za-z0-9][A-Za-z0-9._-]*)\b.*?\(SPDX:\s*([^\)]+)\)/gm;

export interface NoticeEntry {
  readonly spdx: string;
}

/** Extract every NOTICE bullet entry as `{name: {spdx}}`. If the same
 * package appears twice, the first entry wins. */
export function parseNoticeEntries(noticeText: string): Map<string, NoticeEntry> {
  const entries = new Map<string, NoticeEntry>();
  const re = new RegExp(NOTICE_ENTRY_RE.source, NOTICE_ENTRY_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(noticeText)) !== null) {
    const name = match[1] as string;
    const spdx = (match[2] as string).trim();
    if (!entries.has(name)) entries.set(name, { spdx });
  }
  return entries;
}

// -----------------------------------------------------------------------------
// Vendor tree walking
// -----------------------------------------------------------------------------

/** Package-dir name allowlist: `[A-Za-z0-9][A-Za-z0-9._-]*`. This is
 * DELIBERATELY unscoped — an upstream npm package named `@foo/bar`
 * must be flattened (e.g. `foo__bar` or `foo-bar`) in the vendor
 * tree. Rationale: NOTICE entry parsing and pre-commit `files`
 * regexes stay simple with a single-segment name; a slash inside a
 * "dir name" would need extra escaping everywhere it appears. */
const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Files allowed loose at `packages/components/vendor/` root. Every
 * vendored drop lives in its own subdirectory; anything else at the
 * top is a smell (a stray LICENSE at the root would try to apply
 * repo-wide, for example). */
const VENDOR_ROOT_ALLOWED_FILES: ReadonlySet<string> = new Set(["README.md"]);

/** Names an author might have used for a LICENSE file; when present
 * beside a missing `LICENSE`, we say "rename `X` to `LICENSE`". Case
 * matters — see the case-sensitivity note on `siblingHasName`. */
const LICENSE_RENAME_CANDIDATES: readonly string[] = [
  "LICENSE.md",
  "LICENSE.txt",
  "LICENSE.rst",
  "License",
  "License.md",
  "License.txt",
  "license",
  "license.md",
  "license.txt",
  "COPYING",
  "COPYING.md",
  "COPYING.txt",
];

/** Case-sensitive directory-entry check. macOS's HFS+/APFS default
 * is case-insensitive, so `existsSync('LICENSE')` matches `license`
 * — we want a Linux-CI-shaped answer everywhere. Reading the
 * directory entries and comparing byte-for-byte is portable. */
function siblingHasName(pkgAbs: string, wanted: string): boolean {
  try {
    return readdirSync(pkgAbs, { withFileTypes: true }).some((e) => e.name === wanted);
  } catch {
    return false;
  }
}

/** Return the first LICENSE-shaped filename present (case-sensitive)
 * beside `LICENSE`, or `null` when there's nothing to suggest. */
function suggestLicenseRename(pkgAbs: string): string | null {
  let names: Set<string>;
  try {
    names = new Set(
      readdirSync(pkgAbs, { withFileTypes: true })
        .filter((e) => !e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return null;
  }
  for (const alt of LICENSE_RENAME_CANDIDATES) {
    if (names.has(alt)) return alt;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Rule entry point
// -----------------------------------------------------------------------------

/** Run the vendored-code guard against a repo root. Emits one
 * diagnostic per problem. Silent-pass when no vendor directory
 * exists at all (a fork that deletes both the vendor tree and NOTICE
 * opts out). */
export function checkVendoredCode(repoRoot: string): Diagnostic[] {
  const findings: Diagnostic[] = [];
  const vendorAbs = join(repoRoot, VENDOR_DIR);
  const noticeAbs = join(repoRoot, NOTICE_FILE);

  let vendorEntries: Dirent[] | null = null;
  try {
    const st = lstatSync(vendorAbs);
    if (st.isSymbolicLink()) {
      findings.push({
        file: `${VENDOR_DIR}/`,
        line: 0,
        rule: "vendored-code",
        message: `${VENDOR_DIR}/ itself is a symlink — refused (the vendor tree must be a real directory).`,
      });
      return findings;
    }
    if (!st.isDirectory()) return findings;
    vendorEntries = readdirSync(vendorAbs, { withFileTypes: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return findings;
    findings.push({
      file: `${VENDOR_DIR}/`,
      line: 0,
      rule: "vendored-code",
      message: `cannot read vendor dir: ${err.message}`,
    });
    return findings;
  }

  // Walk vendor/: collect legitimate package dirs, refuse loose
  // files and symlinks and mal-named dirs outright.
  const packageDirs: string[] = [];
  for (const entry of vendorEntries) {
    const relPath = `${VENDOR_DIR}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      findings.push({
        file: relPath,
        line: 0,
        rule: "vendored-code",
        message: `symlink refused inside ${VENDOR_DIR}/ — copy the file or directory in as a real copy (a symlink could point out of the vendor tree at any time).`,
      });
      continue;
    }
    if (entry.isDirectory()) {
      if (!PACKAGE_NAME_RE.test(entry.name)) {
        findings.push({
          file: `${relPath}/`,
          line: 0,
          rule: "vendored-code",
          message: `package dir name '${entry.name}' must match [A-Za-z0-9][A-Za-z0-9._-]* (unscoped). An npm-scoped upstream '@scope/name' must be flattened (e.g. 'scope__name') in the vendor tree.`,
        });
        continue;
      }
      packageDirs.push(entry.name);
      continue;
    }
    if (entry.isFile()) {
      if (!VENDOR_ROOT_ALLOWED_FILES.has(entry.name)) {
        findings.push({
          file: relPath,
          line: 0,
          rule: "vendored-code",
          message: `loose file '${entry.name}' at ${VENDOR_DIR}/ root — only README.md is allowed here; vendored source lives in <pkg>/ subdirs.`,
        });
      }
    }
  }
  packageDirs.sort();

  // Read NOTICE with lstat (symlinked NOTICE refused) + guarded
  // readFileSync (surface a read failure as a finding).
  let noticeText = "";
  let noticeExists = false;
  let noticeStat;
  try {
    noticeStat = lstatSync(noticeAbs);
  } catch {
    noticeStat = null;
  }
  if (noticeStat !== null) {
    if (noticeStat.isSymbolicLink()) {
      findings.push({
        file: NOTICE_FILE,
        line: 0,
        rule: "vendored-code",
        message: "NOTICE is a symlink — refused (must be a real file so its content ships with any distribution as-is).",
      });
    } else if (noticeStat.isFile()) {
      try {
        noticeText = readFileSync(noticeAbs, "utf8");
        noticeExists = true;
      } catch (error) {
        findings.push({
          file: NOTICE_FILE,
          line: 0,
          rule: "vendored-code",
          message: `cannot read NOTICE: ${(error as Error).message}.`,
        });
      }
    } else {
      findings.push({
        file: NOTICE_FILE,
        line: 0,
        rule: "vendored-code",
        message: "NOTICE is not a regular file.",
      });
    }
  }
  if (!noticeExists && packageDirs.length > 0 && noticeStat === null) {
    findings.push({
      file: NOTICE_FILE,
      line: 0,
      rule: "vendored-code",
      message: `NOTICE is missing but ${packageDirs.length} vendored package(s) exist under ${VENDOR_DIR}/ (ADR-0022).`,
    });
  }
  const noticeEntries = parseNoticeEntries(noticeText);

  for (const pkg of packageDirs) {
    const pkgRel = `${VENDOR_DIR}/${pkg}`;
    const pkgAbs = join(vendorAbs, pkg);
    const upstreamResult = readUpstream(pkgAbs, pkgRel, findings);
    checkLicensePresent(pkgAbs, pkgRel, findings);

    const entry = noticeEntries.get(pkg);
    if (entry === undefined) {
      findings.push({
        file: NOTICE_FILE,
        line: 0,
        rule: "vendored-code",
        message: `vendored package '${pkg}' is not listed in NOTICE — add '- ${pkgRel} — <upstream URL> (SPDX: <id>)'.`,
      });
    } else if (
      upstreamResult !== null &&
      upstreamResult.license !== null &&
      entry.spdx !== upstreamResult.license
    ) {
      findings.push({
        file: NOTICE_FILE,
        line: 0,
        rule: "vendored-code",
        message: `NOTICE entry for '${pkg}' declares SPDX '${entry.spdx}' but UPSTREAM says '${upstreamResult.license}' — they must match.`,
      });
    }
  }

  // Phantom NOTICE entries.
  const existing = new Set(packageDirs);
  for (const listed of [...noticeEntries.keys()].sort()) {
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

// -----------------------------------------------------------------------------
// Per-package readers — pulled out so `checkVendoredCode` reads as a
// pipeline of checks rather than one long function.
// -----------------------------------------------------------------------------

function readUpstream(
  pkgAbs: string,
  pkgRel: string,
  findings: Diagnostic[],
): UpstreamResult | null {
  const upstreamAbs = join(pkgAbs, "UPSTREAM");
  let stat;
  try {
    stat = lstatSync(upstreamAbs);
  } catch {
    findings.push({
      file: `${pkgRel}/`,
      line: 0,
      rule: "vendored-code",
      message: "missing UPSTREAM file — must record 'repo:', 'commit:', 'path:' and 'license:' (see packages/components/vendor/README.md).",
    });
    return null;
  }
  if (stat.isSymbolicLink()) {
    findings.push({
      file: `${pkgRel}/UPSTREAM`,
      line: 0,
      rule: "vendored-code",
      message: "UPSTREAM is a symlink — refused (provenance must be a real file so it ships with the vendor tree).",
    });
    return null;
  }
  // Case-sensitive filename check: a lowercase `upstream` must not
  // satisfy the guard on macOS.
  if (!siblingHasName(pkgAbs, "UPSTREAM")) {
    findings.push({
      file: `${pkgRel}/`,
      line: 0,
      rule: "vendored-code",
      message: "missing UPSTREAM file (case-sensitive; the file must be named exactly 'UPSTREAM').",
    });
    return null;
  }
  if (!stat.isFile()) {
    findings.push({
      file: `${pkgRel}/UPSTREAM`,
      line: 0,
      rule: "vendored-code",
      message: "UPSTREAM is not a regular file.",
    });
    return null;
  }
  let text: string;
  try {
    text = readFileSync(upstreamAbs, "utf8");
  } catch (error) {
    findings.push({
      file: `${pkgRel}/UPSTREAM`,
      line: 0,
      rule: "vendored-code",
      message: `cannot read UPSTREAM: ${(error as Error).message}.`,
    });
    return null;
  }
  const result = parseUpstream(text);
  for (const p of result.problems) {
    findings.push({
      file: `${pkgRel}/UPSTREAM`,
      line: 0,
      rule: "vendored-code",
      message: p.message,
    });
  }
  return result;
}

function checkLicensePresent(
  pkgAbs: string,
  pkgRel: string,
  findings: Diagnostic[],
): void {
  const licenseAbs = join(pkgAbs, "LICENSE");
  let stat;
  try {
    stat = lstatSync(licenseAbs);
  } catch {
    stat = null;
  }
  const nameOnDisk = siblingHasName(pkgAbs, "LICENSE");
  if (stat === null || !nameOnDisk) {
    const rename = suggestLicenseRename(pkgAbs);
    const hint = rename !== null
      ? ` — a '${rename}' exists; rename it to 'LICENSE' (no extension) with the upstream file's bytes.`
      : "";
    findings.push({
      file: `${pkgRel}/`,
      line: 0,
      rule: "vendored-code",
      message: `missing upstream LICENSE file (case-sensitive; the file must be named exactly 'LICENSE')${hint}`,
    });
    return;
  }
  if (stat.isSymbolicLink()) {
    findings.push({
      file: `${pkgRel}/LICENSE`,
      line: 0,
      rule: "vendored-code",
      message: "LICENSE is a symlink — refused (it must be a real copy of the upstream LICENSE; a symlink to the repo's own LICENSE would silently drop upstream attribution).",
    });
    return;
  }
  if (!stat.isFile()) {
    findings.push({
      file: `${pkgRel}/LICENSE`,
      line: 0,
      rule: "vendored-code",
      message: "LICENSE is not a regular file.",
    });
  }
  // Present + real. Bytes are gated by CODEOWNERS review; this rule
  // deliberately does NOT try to canonicalise / match against SPDX
  // templates. See the header comment.
}
