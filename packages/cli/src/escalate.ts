// `revkit escalate "<need>"` files a `component-request` issue via `gh`
// and prints the number plus the exact annotation the caller can paste
// above their JSX element (ADR-0005, DESIGN-0001 §4). The GitHub call
// goes through the injectable `GhRunner`, so unit tests exercise the
// argv construction without spawning gh.

import type { GhRunner } from "./gh-runner.ts";

/** Prefix every escalation issue's title carries so a GH search on it
 * lists exactly the component-request queue. Kept as a constant so the
 * escalate command and any future ledger reader read the same value. */
export const ESCALATION_TITLE_PREFIX = "[COMPONENT] ";

/** Label the escalation issue gets so the `--online` allow-annotation
 * check can verify by name (ADR-0005 acceptance mirrors this exactly). */
export const ESCALATION_LABEL = "component-request";

/** Argv that `revkit escalate` builds up for `gh issue create`. Returned
 * from `buildEscalateGhArgs` so the unit test asserts on it without
 * calling gh. */
export interface EscalateGhArgs {
  readonly args: readonly string[];
  readonly title: string;
  readonly body: string;
}

/** Compose the body of an escalation issue. Kept short so a reviewer
 * scanning the queue sees the need first, then the annotation shape the
 * author will paste back once the issue is open. */
export function composeEscalationBody(need: string): string {
  return [
    `A new registered component is needed for this content need:`,
    ``,
    `> ${need}`,
    ``,
    `Once this issue is triaged, an agent may paste the following annotation`,
    `on the line immediately above the JSX element it is silencing, and the`,
    `\`revkit check\` guard will accept it (offline shape check; \`--online\``,
    `verifies the issue is open and labeled \`${ESCALATION_LABEL}\`):`,
    ``,
    `    {/* revkit-allow: #<this-issue-number> */}`,
    ``,
    `Rules that produced the escalation are described in ADR-0005 and`,
    `DESIGN-0001 §4.`,
  ].join("\n");
}

/** Turn a need string into the argv `revkit escalate` would spawn against
 * `gh issue create`. Exposed as a pure function so tests never spawn gh. */
export function buildEscalateGhArgs(need: string, repoSlug: string): EscalateGhArgs {
  const title = `${ESCALATION_TITLE_PREFIX}${need}`;
  const body = composeEscalationBody(need);
  const args: readonly string[] = [
    "issue",
    "create",
    "--repo",
    repoSlug,
    "--title",
    title,
    "--body",
    body,
    "--label",
    ESCALATION_LABEL,
  ];
  return { args, title, body };
}

/** Extract the issue number from `gh issue create`'s stdout. `gh` prints
 * the newly created issue URL, ending in `/N`. Returns `null` when the
 * output has no such suffix — the caller then surfaces gh's own message
 * instead of guessing. */
export function parseIssueNumber(stdout: string): number | null {
  const match = /\/(\d+)\s*$/.exec(stdout.trim());
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Return type of the escalate command — either the created issue or a
 * printable failure. Callers render both. */
export type EscalateOutcome =
  | { readonly kind: "created"; readonly issue: number; readonly annotation: string }
  | { readonly kind: "failed"; readonly stderr: string; readonly exitCode: number };

/** Run the escalation end-to-end against an injected gh runner. */
export async function runEscalate(
  need: string,
  repoSlug: string,
  gh: GhRunner,
): Promise<EscalateOutcome> {
  const { args } = buildEscalateGhArgs(need, repoSlug);
  const result = await gh(args);
  if (result.exitCode !== 0) {
    return { kind: "failed", stderr: result.stderr.trim(), exitCode: result.exitCode };
  }
  const issue = parseIssueNumber(result.stdout);
  if (issue === null) {
    return {
      kind: "failed",
      stderr: `revkit escalate: could not parse issue number from gh output: ${JSON.stringify(result.stdout)}`,
      exitCode: 1,
    };
  }
  return {
    kind: "created",
    issue,
    annotation: `{/* revkit-allow: #${issue} */}`,
  };
}
