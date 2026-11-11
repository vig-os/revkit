// Pure tests for /proc parsers. No I/O.

import { describe, expect, test } from "bun:test";
import { argAfter, multiArgAfter, parseCmdline, parseEnviron } from "../../src/dogfood/proc.ts";

describe("parseCmdline", () => {
  test("splits NUL-separated argv and drops the trailing empty slot", () => {
    const raw = "claude\0--tools\0\0--allowedTools\0mcp__revkit__threads\0";
    const parsed = parseCmdline(raw);
    expect(parsed.argv).toEqual(["claude", "--tools", "", "--allowedTools", "mcp__revkit__threads"]);
  });

  test("preserves an empty-string arg in the middle", () => {
    const raw = "claude\0--tools\0\0-x\0";
    expect(parseCmdline(raw).argv).toEqual(["claude", "--tools", "", "-x"]);
  });

  test("raw round-trips into a space-joined string for logs", () => {
    const raw = "claude\0--tools\0\0--allowedTools\0";
    expect(parseCmdline(raw).raw).toEqual("claude --tools  --allowedTools");
  });
});

describe("parseEnviron", () => {
  test("splits NUL-separated NAME=VALUE and drops malformed rows", () => {
    const raw = "PATH=/nix/store/x/bin\0HOME=/home/x\0INVALID\0=noname\0LANG=C.UTF-8\0";
    const parsed = parseEnviron(raw);
    expect(parsed.names).toEqual(new Set(["PATH", "HOME", "LANG"]));
    expect(parsed.lookup("PATH")).toEqual("/nix/store/x/bin");
    expect(parsed.lookup("INVALID")).toBeUndefined();
  });

  test("handles values that contain =", () => {
    const raw = "LD_LIBRARY_PATH=/nix/store/a=b/lib:/nix/store/c/lib\0";
    const parsed = parseEnviron(raw);
    expect(parsed.lookup("LD_LIBRARY_PATH")).toEqual("/nix/store/a=b/lib:/nix/store/c/lib");
  });
});

describe("argAfter / multiArgAfter", () => {
  test("argAfter returns the value that follows a flag", () => {
    expect(argAfter(["claude", "--tools", "", "--allowedTools", "a"], "--tools")).toEqual("");
    expect(argAfter(["claude", "--allowedTools", "a", "b"], "--allowedTools")).toEqual("a");
    expect(argAfter(["claude"], "--tools")).toBeUndefined();
  });

  test("multiArgAfter collects tokens up to the next --flag", () => {
    const argv = ["c", "--allowedTools", "a", "b", "c", "--other"];
    expect(multiArgAfter(argv, "--allowedTools")).toEqual(["a", "b", "c"]);
  });

  test("multiArgAfter returns [] when the flag is missing", () => {
    expect(multiArgAfter(["c"], "--allowedTools")).toEqual([]);
  });
});
