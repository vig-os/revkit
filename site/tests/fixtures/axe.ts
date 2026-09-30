// Shared axe-core setup for the Playwright suite (ADR-0016 axe layer,
// ADR-0017 WCAG 2.2 AA).
//
// One helper owns:
//   - the WCAG tag set the ADR gate uses (2.0/2.1/2.2 A + AA);
//   - the AxeBuilder construction;
//   - the "does an exception match this violation" rule that
//     `documentedExceptionsFor()` in `a11y.spec.ts` relies on.
//
// Callers get a single async function `scanAxe(page)` that returns
// `{ violations }` — an array of flattened per-node findings. Kept
// small so specs read straight and duplication does not creep back
// (PR #31 review nit 4).
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** WCAG 2.2 AA gate tag set. axe's `wcag2a` / `wcag2aa` cover WCAG 2.0
 * A/AA, `wcag21a` / `wcag21aa` cover the 2.1 delta, and `wcag22aa`
 * covers the 2.2 delta at AA — the union is the ADR-0017 target
 * surface. Kept `readonly` and exported so tests that need to prove the
 * tag set out (documentation, meta-assertions) can import it. */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

/** One flattened axe finding, indexed by both the rule id and the node
 * selector — the same shape the exception matcher works against. */
export interface AxeFinding {
  readonly rule: string;
  readonly impact: string | null | undefined;
  readonly help: string;
  readonly helpUrl: string;
  /** `node.target` joined with " " so specs can print / match it as a
   * single string. axe returns an array of alternate selectors for
   * the same node; the join is the axe-conventional debug shape. */
  readonly target: string;
  readonly html: string;
}

/** Run axe with the ADR-0017 WCAG tag set and return every violation
 * FLATTENED to one entry per (rule, node) pair. Rules that fire on
 * multiple nodes produce multiple findings so a per-selector exception
 * cannot accidentally silence a second occurrence.
 *
 * The suite fails on ANY violation, regardless of `impact`. The
 * previous per-page specs gated on `serious|critical` only — this
 * gate is stricter (ADR-0017 accepted note, PR #31 review nit 5). */
export async function scanAxe(page: Page): Promise<{ violations: AxeFinding[] }> {
  const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
  const violations = results.violations.flatMap((violation) =>
    violation.nodes.map((node) => ({
      rule: violation.id,
      impact: violation.impact,
      help: violation.help,
      helpUrl: violation.helpUrl,
      target: node.target.join(" "),
      html: node.html,
    })),
  );
  return { violations };
}

/** A narrowly documented axe exception. Each entry pairs one rule id
 * with the ONE CSS selector for the node whose finding is being
 * suppressed, plus a tracking issue for the underlying fix. A blanket
 * disable (missing `selector`, or a `*` selector) is refused by the
 * enforcement in `a11y.spec.ts`. */
export interface DocumentedException {
  readonly rule: string;
  readonly selector: string;
  readonly issue: `https://github.com/vig-os/revkit/issues/${number}`;
  readonly note: string;
}

/** Does this exception silence this finding? Rule id AND full target
 * selector must match exactly — a rule-only match would let one node's
 * exception cover a whole class of new violations of the same rule. */
export function matchesException(
  exception: DocumentedException,
  finding: Pick<AxeFinding, "rule" | "target">,
): boolean {
  return exception.rule === finding.rule && exception.selector === finding.target;
}

/** Filter findings down to those NOT covered by any documented
 * exception. The empty-`exceptions` case is the common one (no
 * exceptions on file), and returns `findings` unchanged. */
export function filterUnresolved(
  findings: readonly AxeFinding[],
  exceptions: readonly DocumentedException[],
): AxeFinding[] {
  if (exceptions.length === 0) return [...findings];
  return findings.filter((finding) => !exceptions.some((exception) => matchesException(exception, finding)));
}
