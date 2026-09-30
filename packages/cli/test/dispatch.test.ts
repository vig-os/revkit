// Unit tests for @revkit/cli — verify that `dispatch` reports version, help,
// usage errors and unknown-arg errors with the exit codes callers rely on.
import { describe, expect, test } from "bun:test";
import { dispatch, ExitCode, HELP, VERSION } from "../src/index.ts";
import type { DispatchEnv } from "../src/index.ts";

const noopEnv: DispatchEnv = {
  cwd: "/",
  gh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  repoSlug: "vig-os/revkit",
};

describe("dispatch", () => {
  test("--version prints the version and exits 0", async () => {
    const result = await dispatch(["--version"], noopEnv);
    expect(result.stdout).toBe(`${VERSION}\n`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(ExitCode.ok);
  });

  test("-v is a short alias for --version", async () => {
    const result = await dispatch(["-v"], noopEnv);
    expect(result.stdout).toBe(`${VERSION}\n`);
    expect(result.exitCode).toBe(ExitCode.ok);
  });

  test("--help prints the help text and exits 0", async () => {
    const result = await dispatch(["--help"], noopEnv);
    expect(result.stdout).toBe(HELP);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(ExitCode.ok);
  });

  test("no arguments prints help and exits 0", async () => {
    const result = await dispatch([], noopEnv);
    expect(result.stdout).toBe(HELP);
    expect(result.exitCode).toBe(ExitCode.ok);
  });

  test("--version with extra args exits with usage error on stderr", async () => {
    const result = await dispatch(["--version", "extra"], noopEnv);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--version takes no arguments");
    expect(result.exitCode).toBe(ExitCode.usage);
  });

  test("unknown argument exits with usage error and shows help", async () => {
    // `serve` shipped in M2 item 2 (this PR), so it is no longer an
    // unknown argument; use a name that no future milestone will
    // claim.
    const result = await dispatch(["notarealcommand"], noopEnv);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown argument 'notarealcommand'");
    expect(result.stderr).toContain(HELP);
    expect(result.exitCode).toBe(ExitCode.usage);
  });

  test("check with an unknown flag exits with usage error", async () => {
    const result = await dispatch(["check", "--nope"], noopEnv);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown flag '--nope'");
    expect(result.exitCode).toBe(ExitCode.usage);
  });

  test("check --staged with positional paths exits with usage error", async () => {
    const result = await dispatch(["check", "--staged", "docs/adr/0001.md"], noopEnv);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("does not accept positional paths");
    expect(result.exitCode).toBe(ExitCode.usage);
  });

  test("escalate with no argument exits with usage error", async () => {
    const result = await dispatch(["escalate"], noopEnv);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("exactly one non-empty argument");
    expect(result.exitCode).toBe(ExitCode.usage);
  });

  test("serve with a bad --port value exits with usage error", async () => {
    // `serve` is a recognised subcommand as of M2 item 2; a bad value
    // is rejected before the daemon boots (no port is bound). Kept in
    // this file so the full subcommand table is covered here.
    const result = await dispatch(["serve", "--port", "notanumber"], noopEnv);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--port");
    expect(result.exitCode).toBe(ExitCode.usage);
  });

  test("review with no argument exits with usage error (M3 part 2a)", async () => {
    const result = await dispatch(["review"], noopEnv);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("expected a <pr-number|url>");
    expect(result.exitCode).toBe(ExitCode.usage);
  });

  test("review with a bad --trust value exits with usage error", async () => {
    const result = await dispatch(["review", "1", "--trust", "not-a-sha"], noopEnv);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--trust");
    expect(result.exitCode).toBe(ExitCode.usage);
  });

  test("help text advertises the review subcommand", () => {
    expect(HELP).toContain("revkit review");
    expect(HELP).toContain("--trust");
  });
});
