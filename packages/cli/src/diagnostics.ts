// One place that defines what a `revkit check` finding looks like and how
// it renders. Every rule returns a `Diagnostic[]`, and the CLI prints them
// as `file:line: rule: message` — the format editors and pre-commit
// runners already anchor onto (ADR-0005; DESIGN-0001 §4).
//
// Kept as a value module (no I/O) so rules stay unit-testable without
// spawning the CLI, and so a reviewer can see the shape of every finding
// at a glance rather than inferring it from the runtime prints.

/** Names of the rules `revkit check` knows about. Kept as a `const` union
 * so tests assert against a value the compiler already agrees with — a
 * typo in a rule id becomes a build error instead of a runtime miss. */
export const ruleIds = [
  "component-registry",
  "no-hand-rolled-ui",
  "vocabulary",
  "links",
  "plot-structure",
] as const;

export type RuleId = (typeof ruleIds)[number];

/** One finding from one rule against one file. `line` is 1-based; `0`
 * means "the whole file" (used when the rule cannot map to a source
 * range — e.g. a spec.vl.json that fails to parse as JSON). */
export interface Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly rule: RuleId;
  readonly message: string;
}

/** Format one diagnostic as `file:line: rule: message`, the shape a
 * reviewer's editor jumps to. `line: 0` is elided so the location reads
 * as a bare path (`docs/adr/foo.md: rule: message`) instead of the
 * confusing `docs/adr/foo.md:0`. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const where = diagnostic.line > 0
    ? `${diagnostic.file}:${diagnostic.line}`
    : diagnostic.file;
  return `${where}: ${diagnostic.rule}: ${diagnostic.message}`;
}
