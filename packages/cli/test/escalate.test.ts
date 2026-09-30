// Escalate command tests — assert on the argv `revkit escalate` builds
// up so no test ever spawns `gh`. Covers the happy path (issue number
// parsed from gh's URL output) and the two failure modes (non-zero
// exit, unparsable output).
import { describe, expect, test } from "bun:test";
import {
  ESCALATION_LABEL,
  ESCALATION_TITLE_PREFIX,
  buildEscalateGhArgs,
  parseIssueNumber,
  runEscalate,
} from "../src/escalate.ts";
import type { GhRunner } from "../src/gh-runner.ts";

describe("buildEscalateGhArgs", () => {
  test("emits `gh issue create` argv with the [COMPONENT] title and label", () => {
    const built = buildEscalateGhArgs("a Diff component for review deltas", "vig-os/revkit");
    expect(built.title).toBe(`${ESCALATION_TITLE_PREFIX}a Diff component for review deltas`);
    expect(built.args.slice(0, 4)).toEqual(["issue", "create", "--repo", "vig-os/revkit"]);
    // Label always applies so `revkit check --online` can verify by name.
    expect(built.args).toContain("--label");
    expect(built.args).toContain(ESCALATION_LABEL);
    // Title flag carries the composed title.
    const titleIdx = built.args.indexOf("--title");
    expect(built.args[titleIdx + 1]).toBe(built.title);
    // Body carries the paste-back annotation instructions.
    const bodyIdx = built.args.indexOf("--body");
    expect(built.args[bodyIdx + 1]).toContain("revkit-allow");
  });
});

describe("parseIssueNumber", () => {
  test("extracts N from a gh-style URL", () => {
    expect(parseIssueNumber("https://github.com/vig-os/revkit/issues/123\n")).toBe(123);
  });

  test("returns null when the output is unrecognised", () => {
    expect(parseIssueNumber("banana")).toBeNull();
    expect(parseIssueNumber("")).toBeNull();
  });
});

describe("runEscalate (fake gh runner)", () => {
  test("returns a created outcome on gh success", async () => {
    const gh: GhRunner = async (args) => {
      // The runner receives the exact args from buildEscalateGhArgs — assert
      // one identifying arg here so a regression in argv shape breaks fast.
      expect(args[0]).toBe("issue");
      return {
        stdout: "https://github.com/vig-os/revkit/issues/456\n",
        stderr: "",
        exitCode: 0,
      };
    };
    const outcome = await runEscalate("need a Diff component", "vig-os/revkit", gh);
    expect(outcome.kind).toBe("created");
    if (outcome.kind === "created") {
      expect(outcome.issue).toBe(456);
      expect(outcome.annotation).toBe("{/* revkit-allow: #456 */}");
    }
  });

  test("returns a failed outcome on non-zero exit and does not fabricate an issue number", async () => {
    const gh: GhRunner = async () => ({
      stdout: "",
      stderr: "gh: not authenticated",
      exitCode: 4,
    });
    const outcome = await runEscalate("x", "vig-os/revkit", gh);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.exitCode).toBe(4);
      expect(outcome.stderr).toContain("not authenticated");
    }
  });

  test("returns a failed outcome when gh's output has no issue URL", async () => {
    const gh: GhRunner = async () => ({
      stdout: "created a discussion instead\n",
      stderr: "",
      exitCode: 0,
    });
    const outcome = await runEscalate("x", "vig-os/revkit", gh);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.stderr).toContain("could not parse issue number");
    }
  });
});
