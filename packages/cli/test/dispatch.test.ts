// Unit tests for @revkit/cli — verify that `dispatch` reports version, help,
// usage errors and unknown-arg errors with the exit codes callers rely on.
import { describe, expect, test } from "bun:test";
import { dispatch, ExitCode, HELP, VERSION } from "../src/index.ts";

describe("dispatch", () => {
  test("--version prints the version and exits 0", () => {
    const result = dispatch(["--version"]);
    expect(result.stdout).toBe(`${VERSION}\n`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(ExitCode.ok);
  });

  test("-v is a short alias for --version", () => {
    const result = dispatch(["-v"]);
    expect(result.stdout).toBe(`${VERSION}\n`);
    expect(result.exitCode).toBe(ExitCode.ok);
  });

  test("--help prints the help text and exits 0", () => {
    const result = dispatch(["--help"]);
    expect(result.stdout).toBe(HELP);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(ExitCode.ok);
  });

  test("no arguments prints help and exits 0", () => {
    const result = dispatch([]);
    expect(result.stdout).toBe(HELP);
    expect(result.exitCode).toBe(ExitCode.ok);
  });

  test("--version with extra args exits with usage error on stderr", () => {
    const result = dispatch(["--version", "extra"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--version takes no arguments");
    expect(result.exitCode).toBe(ExitCode.usage);
  });

  test("unknown argument exits with usage error and shows help", () => {
    const result = dispatch(["serve"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown argument 'serve'");
    expect(result.stderr).toContain(HELP);
    expect(result.exitCode).toBe(ExitCode.usage);
  });
});
