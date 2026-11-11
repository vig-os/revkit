// Unit tests for `matchesException` / `filterUnresolved` in the axe
// fixture (`site/tests/fixtures/axe.ts`).
//
// The a11y spec's exception list is empty at the current commit, so the
// filter code path never fires in the e2e suite. This test exercises it
// with fabricated findings so a regression in the matcher (e.g. a
// looser `.includes` swap that would blanket-disable a whole rule)
// trips here instead of quietly widening the exception surface (PR #31
// review nit 6).
//
// Lives under `src/content/schemas/` because that is the exact prefix
// `justfile.project`'s `just test` recipe walks with `bun test`; the
// site-wide bun-test root would collide with the Playwright specs
// under `tests/`.
import { describe, expect, test } from "bun:test";
import {
  filterUnresolved,
  matchesException,
  type AxeFinding,
  type DocumentedException,
} from "../../../tests/fixtures/axe.ts";

function finding(rule: string, target: string, extras: Partial<AxeFinding> = {}): AxeFinding {
  return {
    rule,
    impact: "serious",
    help: "help",
    helpUrl: "https://example.invalid/",
    target,
    html: "<x/>",
    ...extras,
  };
}

function exception(rule: string, selector: string): DocumentedException {
  return {
    rule,
    selector,
    issue: "https://github.com/vig-os/revkit/issues/999",
    note: "fabricated for the matcher unit test",
  };
}

describe("matchesException", () => {
  test("matches when rule and target are identical", () => {
    expect(
      matchesException(exception("color-contrast", "main a.link"), finding("color-contrast", "main a.link")),
    ).toBe(true);
  });

  test("does NOT match on rule alone (target must be identical)", () => {
    // Guard: an exception on "a.link" MUST NOT silence a finding on
    // "a.other" of the same rule. This is the pattern that would let a
    // narrow exception blanket-disable a whole rule if the matcher
    // ever relaxed to a rule-only compare.
    expect(
      matchesException(exception("color-contrast", "main a.link"), finding("color-contrast", "main a.other")),
    ).toBe(false);
  });

  test("does NOT match on target alone (rule must be identical)", () => {
    expect(
      matchesException(exception("color-contrast", "main a.link"), finding("link-in-text-block", "main a.link")),
    ).toBe(false);
  });

  test("target compare is EXACT — a substring is not a match", () => {
    // A finding on `.wrapper main a.link` should not be silenced by an
    // exception on `main a.link` (the exception is more specific).
    expect(
      matchesException(exception("color-contrast", "main a.link"), finding("color-contrast", ".wrapper main a.link")),
    ).toBe(false);
  });
});

describe("filterUnresolved", () => {
  test("returns findings unchanged when the exception list is empty", () => {
    const findings = [finding("image-alt", "img.hero"), finding("region", "main")];
    expect(filterUnresolved(findings, [])).toEqual(findings);
  });

  test("drops exactly the findings covered by an exception", () => {
    const covered = finding("image-alt", "img.hero");
    const uncovered = finding("region", "main");
    const result = filterUnresolved([covered, uncovered], [exception("image-alt", "img.hero")]);
    expect(result).toEqual([uncovered]);
  });

  test("a single exception silences only the ONE matching (rule, target) pair", () => {
    // Two findings of the same rule on different targets: only the
    // named target should be silenced. Regression guard for the
    // "exception widens to whole rule" mistake.
    const silenced = finding("color-contrast", "main a.link");
    const stillCounted = finding("color-contrast", "main a.other");
    const result = filterUnresolved([silenced, stillCounted], [exception("color-contrast", "main a.link")]);
    expect(result).toEqual([stillCounted]);
  });
});
