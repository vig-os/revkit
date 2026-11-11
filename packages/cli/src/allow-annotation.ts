// Shared parser and verifier for the `{/* revkit-allow: #<n> */}` escape
// hatch (ADR-0005). The shape rule is offline: the annotation must be a
// single-line JSX comment carrying `revkit-allow: #<positive integer>`.
// The `--online` verification asks GitHub whether that issue is open and
// carries the `component-request` label — routed through the injectable
// GhRunner so tests never call out.
//
// Only the component-registry rule honours the escape hatch (§5, ADR-0005).
// Keeping the parse + verify in one module means the rule and the tests
// pull from the same regex, so a future annotation-syntax change can not
// silently agree between them and disagree with the docs.

import type { GhRunner } from "./gh-runner.ts";

/** Extracted shape of one annotation. `issue` is the integer issue number
 * the comment references — the online verifier consumes this. */
export interface AllowAnnotation {
  readonly issue: number;
  readonly raw: string;
}

/** Regex for the annotation's INSIDE: the value of an mdxFlowExpression /
 * mdxTextExpression is the JS between `{` and `}`, so the leading `{` /
 * trailing `}` are already stripped by the parser. The comment must be
 * the sole content — trailing prose would let a comment sneak past the
 * shape check. */
const ANNOTATION_INSIDE = /^\s*\/\*\s*revkit-allow:\s*#(\d+)\s*\*\/\s*$/;

/** Parse the interior of a JSX comment. Returns the annotation on match,
 * `null` otherwise. */
export function parseAllowAnnotation(expressionValue: string): AllowAnnotation | null {
  const match = ANNOTATION_INSIDE.exec(expressionValue);
  if (!match) return null;
  const issue = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(issue) || issue <= 0) return null;
  return { issue, raw: expressionValue };
}

/** Result of the online verification: either "OK, this annotation names
 * an open component-request issue", or a message explaining why not. */
export type OnlineVerification =
  | { readonly kind: "ok" }
  | { readonly kind: "bad"; readonly message: string };

/** Ask `gh api` for the issue's state and labels, and check both. Kept
 * pure over the runner so tests inject a canned response. The label check
 * looks for `component-request` (the label the escalation flow assigns);
 * a match by exact name only, so a nearby label like
 * `component-requested` cannot smuggle an approval. */
export async function verifyAllowAnnotationOnline(
  annotation: AllowAnnotation,
  repoSlug: string,
  gh: GhRunner,
): Promise<OnlineVerification> {
  const result = await gh([
    "api",
    `repos/${repoSlug}/issues/${annotation.issue}`,
    "--jq",
    "{state: .state, labels: [.labels[].name]}",
  ]);
  if (result.exitCode !== 0) {
    return {
      kind: "bad",
      message: `revkit-allow: #${annotation.issue}: gh api failed (${result.exitCode}): ${result.stderr.trim() || "no stderr"}.`,
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return {
      kind: "bad",
      message: `revkit-allow: #${annotation.issue}: gh api returned unparsable JSON.`,
    };
  }
  if (payload === null || typeof payload !== "object") {
    return {
      kind: "bad",
      message: `revkit-allow: #${annotation.issue}: gh api response was not an object.`,
    };
  }
  const record = payload as { state?: unknown; labels?: unknown };
  if (record.state !== "open") {
    return {
      kind: "bad",
      message: `revkit-allow: #${annotation.issue}: issue is not open (state=${JSON.stringify(record.state)}).`,
    };
  }
  const labels = Array.isArray(record.labels) ? record.labels : [];
  if (!labels.includes("component-request")) {
    return {
      kind: "bad",
      message: `revkit-allow: #${annotation.issue}: issue is missing the 'component-request' label.`,
    };
  }
  return { kind: "ok" };
}
