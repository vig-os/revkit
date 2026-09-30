// `revkit check` orchestrator. Turns a set of input paths into a list of
// diagnostics (`file:line: rule: message`) and an exit code — 0 when
// nothing was found, 1 otherwise. Kept pure over its dependencies (file
// list, vocab loader, gh runner) so unit tests exercise it without
// touching the real repo or GitHub.
//
// Rules run in a stable order (component-registry, no-hand-rolled-ui,
// vocabulary, links, plot-structure) so the printed diagnostics list is
// deterministic — a reviewer scrolling to a rule always sees the same
// section, and CI diffs against a prior run stay small.

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Parent } from "mdast";
import type { AllowAnnotation } from "./allow-annotation.ts";
import { verifyAllowAnnotationOnline } from "./allow-annotation.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { formatDiagnostic } from "./diagnostics.ts";
import type { DiscoveredSymlink } from "./file-discovery.ts";
import { repoRelative } from "./file-discovery.ts";
import type { GhRunner } from "./gh-runner.ts";
import { parseSourceFor } from "./mdx-parse.ts";
import { checkComponentRegistryFile } from "./rules/component-registry.ts";
import { checkFrontmatter } from "./rules/frontmatter.ts";
import { checkLinksFile } from "./rules/links.ts";
import { checkNoHandRolledUiFile } from "./rules/no-hand-rolled-ui.ts";
import { checkPlotSpecFile } from "./rules/plot-structure.ts";
import { checkVegaUntrusted } from "./rules/vega-untrusted.ts";
import { checkVendoredCode } from "./rules/vendored-code.ts";
import type { LoadedVocabEntry } from "./rules/vocabulary.ts";
import { checkVocabularyFile, loadVocab } from "./rules/vocabulary.ts";

/** Directories whose MDX/MD files are treated as content — the
 * component-registry, vocabulary and links rules only run there.
 * repo-root-relative POSIX. */
export const CONTENT_DIR_PREFIXES: readonly string[] = [
  "docs/",
  "site/src/content/",
];

/** Devkit-managed docs under `docs/` that the guards should not consider
 * as revkit content (they document the release process, not revkit).
 * Mirror the excludes list in the repo-docs loader so a devkit upgrade
 * dropping a new file here can not silently trip a rule. */
const DOCS_EXCLUDES: ReadonlySet<string> = new Set([
  "docs/COMMIT_MESSAGE_STANDARD.md",
  "docs/DOWNSTREAM_RELEASE.md",
]);

/** Every content-shaped file the C1/C2/C3 rules should read. Filters the
 * incoming list — pass every file, get back only the ones the rules
 * care about. */
export function contentFilesFrom(
  posixRepoRelatives: readonly string[],
): string[] {
  const kept: string[] = [];
  for (const path of posixRepoRelatives) {
    if (DOCS_EXCLUDES.has(path)) continue;
    if (!CONTENT_DIR_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    const ext = extname(path).toLowerCase();
    if (ext !== ".md" && ext !== ".mdx") continue;
    kept.push(path);
  }
  return kept;
}

/** Every plot spec the C4 rule should validate. Recognises files under
 * `plots/<name>/spec.vl.json` and drops anything else. */
export function plotSpecFilesFrom(
  posixRepoRelatives: readonly string[],
): string[] {
  return posixRepoRelatives.filter((path) => /^plots\/[^/]+\/spec\.vl\.json$/.test(path));
}

/** One file's absolute + repo-relative path. Every rule reports the
 * relative form so diagnostics stay portable across machines. */
export interface CheckFile {
  readonly absolute: string;
  readonly relative: string;
}

/** Trust posture the check runs under (ADR-0025, PR #48 round-2).
 *
 * - `trusted`: the default. Content comes from the reviewer's own
 *   checkout or the local pre-commit path. Allow-annotations honour
 *   their escape-hatch, since a maintainer authored them.
 * - `untrusted`: content comes from a PR head that the reviewer has
 *   NOT authored. The check refuses every allow-annotation from the
 *   PR (it has not passed a hosted `--online` verification the local
 *   reviewer can trust), and it applies the vega-lite executable-key
 *   refusal (no `expr` / `signal` / `calculate` at build time).
 *   Every other guard (component-registry, no-hand-rolled-ui,
 *   vocabulary, links, plot-structure, frontmatter, vendored-code)
 *   still runs. */
export type Trust = "trusted" | "untrusted";

/** Options carried through the orchestrator. `--online` toggles the
 * gh-api verification of allow annotations. `trust` picks the trust
 * posture (see `Trust`); defaults to `trusted`. */
export interface CheckOptions {
  readonly online: boolean;
  readonly repoSlug: string;
  readonly gh: GhRunner;
  readonly trust?: Trust;
}

/** The check's public result: rendered lines + the numeric exit code. */
export interface CheckOutput {
  readonly lines: readonly string[];
  readonly exitCode: number;
}

/** Convert a batch of diagnostics to lines + exit code. Sorts findings by
 * (file, line, rule) so the output is deterministic and easy to diff. */
function toCheckOutput(diagnostics: readonly Diagnostic[]): CheckOutput {
  const sorted = [...diagnostics].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.rule.localeCompare(b.rule);
  });
  const lines = sorted.map(formatDiagnostic);
  return { lines, exitCode: sorted.length === 0 ? 0 : 1 };
}

/** Run every rule that applies to `files`. `repoRoot` anchors the
 * vocabulary and plot rules' filesystem access. `symlinks` is the list
 * of symlinks discovery observed under a content/UI tree — each becomes
 * one diagnostic with rule `no-hand-rolled-ui`. */
export async function runCheck(
  repoRoot: string,
  files: readonly CheckFile[],
  symlinks: readonly DiscoveredSymlink[],
  options: CheckOptions,
): Promise<CheckOutput> {
  const findings: Diagnostic[] = [];
  const contentFiles = files.filter((file) =>
    contentFilesFrom([file.relative]).length === 1
  );
  const plotFiles = files.filter((file) => plotSpecFilesFrom([file.relative]).length === 1);

  // 0) Symlinks under content/UI trees — Astro follows them at build,
  //    so refusing at discovery keeps a `docs/evil.md -> /etc/passwd`
  //    kind of link from ever reaching a rendered page (bypass #5).
  //    A symlink under `packages/components/vendor/` is attributed to
  //    the `vendored-code` rule instead — that's the guard that owns
  //    the vendor tree (ADR-0022), so a maintainer chasing the
  //    diagnostic to its rule finds it there rather than in
  //    `no-hand-rolled-ui`.
  for (const symlink of symlinks) {
    const isUnderVendor = symlink.posixPath.startsWith("packages/components/vendor/");
    findings.push({
      file: symlink.posixPath,
      line: 0,
      rule: isUnderVendor ? "vendored-code" : "no-hand-rolled-ui",
      message: isUnderVendor
        ? "symlink refused inside packages/components/vendor/ — copy the file or directory in as a real copy (ADR-0022)."
        : "symlink refused (Astro follows symlinks during build; use a copy or a `.md` reference instead).",
    });
  }

  // Vocabulary is loaded once so a rule run over 200 files parses the
  // YAML exactly once. A MISSING vocab file is treated as an empty
  // vocab (issue #57 nit): the site build already treats vocab as
  // optional (`content.config.ts` uses an empty inline loader when
  // the consumer omits `vocab/terms.yaml`), and `check` should match
  // — a repo without any `<Term id>` usages does not need a vocab.
  // A file that exists but fails to parse still produces a finding.
  const vocabYamlPath = join(repoRoot, "vocab", "terms.yaml");
  let vocab: LoadedVocabEntry[];
  if (!existsSync(vocabYamlPath)) {
    vocab = [];
  } else {
    try {
      vocab = loadVocab(vocabYamlPath);
    } catch (error) {
      findings.push({
        file: "vocab/terms.yaml",
        line: 0,
        rule: "vocabulary",
        message: `failed to load vocab: ${(error as Error).message}`,
      });
      vocab = [];
    }
  }

  // Parse each content file ONCE and hand the mdast root to every
  // rule that needs it. A per-rule reparse would (a) double the cost
  // and (b) let the second rule crash on a parse error the first
  // rule already caught. `null` on a file means the parse failed —
  // component-registry emits the parse-error diagnostic; other rules
  // skip the file quietly.
  interface Loaded {
    readonly file: (typeof contentFiles)[number];
    readonly source: string;
    readonly root: Parent | null;
  }
  const loaded: Loaded[] = [];
  for (const file of contentFiles) {
    const source = await readFile(file.absolute);
    let root: Parent | null;
    try {
      root = parseSourceFor(file.relative, source);
    } catch {
      root = null;
    }
    loaded.push({ file, source, root });
  }

  // 1) component-registry — plus allow-annotation harvest.
  const trust: Trust = options.trust ?? "trusted";
  // Under untrusted mode, feed the rule the set of DECLARED
  // component subpaths — derived from
  // `packages/components/package.json`'s exports map — so
  // `@revkit/components/Plot` (the documented import used in the
  // site's own MDX) passes while a fantasy subpath is refused
  // (PR #48 round-4 blocker 1a).
  const untrustedAllowedSubpaths =
    trust === "untrusted" ? readComponentsExports(repoRoot) : undefined;
  const usedAllowAnnotations: {
    readonly file: string;
    readonly line: number;
    readonly annotation: AllowAnnotation;
  }[] = [];
  for (const entry of loaded) {
    const result = checkComponentRegistryFile(
      entry.source,
      entry.file.relative,
      entry.root ?? undefined,
      { trust, ...(untrustedAllowedSubpaths !== undefined ? { untrustedAllowedSubpaths } : {}) },
    );
    findings.push(...result.diagnostics);
    for (const used of result.usedAllowAnnotations) {
      usedAllowAnnotations.push({
        file: entry.file.relative,
        line: used.line,
        annotation: used.annotation,
      });
    }
  }

  // 1b) frontmatter — YAML at the top of `.md`/`.mdx` must satisfy a
  //     strict key allowlist (`rules/frontmatter.ts` uses Astro's own
  //     `parseFrontmatter` so the guard sees exactly what the build
  //     sees, plus BOM / leading-whitespace / `+++` refusals).
  for (const entry of loaded) {
    findings.push(...checkFrontmatter(entry.source, entry.file.relative));
  }

  // 2) no-hand-rolled-UI — path-only, runs on every UI-shaped input.
  for (const file of files) {
    findings.push(...checkNoHandRolledUiFile(file.relative));
  }

  // 3) vocabulary — Term/id sigils, redefinitions. Reuses the shared
  //    parse (nit 1 in round-3: one parse per file across rules).
  for (const entry of loaded) {
    findings.push(...checkVocabularyFile(
      entry.source,
      entry.file.relative,
      vocab,
      entry.root ?? undefined,
    ));
  }

  // 4) links — relative links + heading anchors. Confined to repoRoot:
  //    a `../../..` traversal that escapes the workspace is flagged.
  const slugCache = new Map<string, Set<string>>();
  for (const entry of loaded) {
    findings.push(
      ...checkLinksFile(
        entry.source,
        entry.file.absolute,
        entry.file.relative,
        slugCache,
        repoRoot,
        entry.root ?? undefined,
      ),
    );
  }

  // 5) plot-structure — schema + confined sibling files.
  for (const file of plotFiles) {
    findings.push(...checkPlotSpecFile(file.absolute, file.relative));
    // Untrusted-mode-only: also refuse executable vega keys
    // (`expr` / `signal` / `calculate` / `update` / `on`). See
    // `rules/vega-untrusted.ts` and ADR-0021 / ADR-0025.
    if (trust === "untrusted") {
      findings.push(...checkVegaUntrusted(file.absolute, file.relative));
    }
  }

  // 5b) vendored-code (ADR-0022) — one shot per invocation because
  //     the guard is repo-level (vendor tree ↔ NOTICE), not
  //     per-file. A commit that only touches NOTICE or a vendored
  //     LICENSE still fires it (the pre-commit `files` regex
  //     includes both).
  findings.push(...checkVendoredCode(repoRoot));

  // 6) --online allow-annotation verification. Runs after the offline
  //    pass so an offline failure short-circuits the network calls, and
  //    each `gh api` call happens at most once per issue per run. A bad
  //    annotation produces one diagnostic per site (file + line) that
  //    references the issue, so the reader sees every spot the bad
  //    annotation was used, not just the first.
  if (options.online && usedAllowAnnotations.length > 0) {
    const messageByIssue = new Map<number, string | null>();
    for (const used of usedAllowAnnotations) {
      const cached = messageByIssue.get(used.annotation.issue);
      let message: string | null;
      if (cached !== undefined) {
        message = cached;
      } else {
        const verification = await verifyAllowAnnotationOnline(
          used.annotation,
          options.repoSlug,
          options.gh,
        );
        message = verification.kind === "ok" ? null : verification.message;
        messageByIssue.set(used.annotation.issue, message);
      }
      if (message !== null) {
        findings.push({
          file: used.file,
          line: used.line,
          rule: "component-registry",
          message,
        });
      }
    }
  }

  return toCheckOutput(findings);
}

/** Read a UTF-8 file via Bun.file so the orchestrator does not import
 * node:fs directly — makes it easier to fake in a unit test. */
async function readFile(absolutePath: string): Promise<string> {
  return await Bun.file(absolutePath).text();
}

/** Turn a list of absolute paths + a repo root into the CheckFile shape
 * every downstream rule expects. Exported so the CLI dispatcher can
 * build the same input a unit test does. */
export function toCheckFiles(
  absolutePaths: readonly string[],
  repoRoot: string,
): CheckFile[] {
  return absolutePaths.map((absolute) => ({
    absolute,
    relative: repoRelative(repoRoot, absolute),
  }));
}

/** Rule ids to include when running as `revkit check` with no path
 * filter — the orchestrator runs each rule against every applicable
 * file. Exported so the CLI's help text can list them in the same order
 * the check reports them. */
export const CHECK_RULES: readonly string[] = [
  "component-registry",
  "no-hand-rolled-ui",
  "vocabulary",
  "links",
  "plot-structure",
  "vendored-code",
];

/** Read `packages/components/package.json`'s `exports` map and
 * return the SET of full subpath specifiers (like
 * `"@revkit/components/Plot"`). Under untrusted PR review, only
 * these subpaths are admitted — a fantasy `.../Playground` is
 * refused. Falls back to an empty set (which admits only the exact
 * root specifiers) when the file is missing or malformed; the check
 * still refuses subpaths in that case rather than opening the gate.
 * (PR #48 round-4 blocker 1a.) */
export function readComponentsExports(repoRoot: string): ReadonlySet<string> {
  const out = new Set<string>();
  const pkgPath = join(repoRoot, "packages", "components", "package.json");
  let raw: string;
  try {
    raw = readFileSync(pkgPath, "utf8");
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== "object") return out;
  const pkgName = (parsed as { name?: unknown }).name;
  const exportsMap = (parsed as { exports?: unknown }).exports;
  if (typeof pkgName !== "string" || pkgName.length === 0) return out;
  if (exportsMap === null || typeof exportsMap !== "object") return out;
  for (const key of Object.keys(exportsMap as Record<string, unknown>)) {
    // `"."` is the root, admitted separately. Every other key
    // starts with `"./"` — turn it into the FULL specifier.
    if (key === ".") continue;
    if (!key.startsWith("./")) continue;
    // Refuse wildcards for now: a `./features/*` key would let
    // any subpath resolve, which is exactly what untrusted mode
    // means to close. If revkit ever adds a wildcard export, the
    // allowlist gate needs a targeted widening + a fresh review.
    if (key.includes("*")) continue;
    out.add(`${pkgName}${key.slice(1)}`);
  }
  return out;
}
