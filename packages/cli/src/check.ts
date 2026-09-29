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

import { extname, join } from "node:path";
import type { AllowAnnotation } from "./allow-annotation.ts";
import { verifyAllowAnnotationOnline } from "./allow-annotation.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { formatDiagnostic } from "./diagnostics.ts";
import { repoRelative } from "./file-discovery.ts";
import type { GhRunner } from "./gh-runner.ts";
import { checkComponentRegistryFile } from "./rules/component-registry.ts";
import { checkLinksFile } from "./rules/links.ts";
import { checkNoHandRolledUiFile } from "./rules/no-hand-rolled-ui.ts";
import { checkPlotSpecFile } from "./rules/plot-structure.ts";
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

/** Options carried through the orchestrator. `--online` toggles the
 * gh-api verification of allow annotations. */
export interface CheckOptions {
  readonly online: boolean;
  readonly repoSlug: string;
  readonly gh: GhRunner;
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
 * vocabulary and plot rules' filesystem access. */
export async function runCheck(
  repoRoot: string,
  files: readonly CheckFile[],
  options: CheckOptions,
): Promise<CheckOutput> {
  const findings: Diagnostic[] = [];
  const contentFiles = files.filter((file) =>
    contentFilesFrom([file.relative]).length === 1
  );
  const plotFiles = files.filter((file) => plotSpecFilesFrom([file.relative]).length === 1);

  // Vocabulary is loaded once so a rule run over 200 files parses the
  // YAML exactly once. Errors surface as one diagnostic against the YAML
  // file itself — the check should not silently pass when vocab is broken.
  const vocabYamlPath = join(repoRoot, "vocab", "terms.yaml");
  let vocab: LoadedVocabEntry[];
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

  // 1) component-registry — plus allow-annotation harvest.
  const usedAllowAnnotations: {
    readonly file: string;
    readonly line: number;
    readonly annotation: AllowAnnotation;
  }[] = [];
  for (const file of contentFiles) {
    const source = await readFile(file.absolute);
    const result = checkComponentRegistryFile(source, file.relative);
    findings.push(...result.diagnostics);
    for (const used of result.usedAllowAnnotations) {
      usedAllowAnnotations.push({
        file: file.relative,
        line: used.line,
        annotation: used.annotation,
      });
    }
  }

  // 2) no-hand-rolled-UI — path-only, runs on every UI-shaped input.
  for (const file of files) {
    findings.push(...checkNoHandRolledUiFile(file.relative));
  }

  // 3) vocabulary — Term/id sigils, redefinitions.
  for (const file of contentFiles) {
    const source = await readFile(file.absolute);
    findings.push(...checkVocabularyFile(source, file.relative, vocab));
  }

  // 4) links — relative links + heading anchors. Confined to repoRoot:
  //    a `../../..` traversal that escapes the workspace is flagged.
  const slugCache = new Map<string, Set<string>>();
  for (const file of contentFiles) {
    const source = await readFile(file.absolute);
    findings.push(
      ...checkLinksFile(source, file.absolute, file.relative, slugCache, repoRoot),
    );
  }

  // 5) plot-structure — schema + confined sibling files.
  for (const file of plotFiles) {
    findings.push(...checkPlotSpecFile(file.absolute, file.relative));
  }

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
];
