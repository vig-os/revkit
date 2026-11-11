// Shape check for the isolated per-run settings.json.
//
// PR #42 round-5 hinged on this file's shape: no hooks, no statusLine,
// no env, no plugins, `instructionFiles: "managed-only"`,
// `permissions.defaultMode: "dontAsk"`, and an allow-list of ONLY the
// three revkit MCP tools. A regression here means the isolation the
// dogfood promises is quiet-broken — any owner-hook / statusLine / env
// / plugin from the owner's settings can start firing without the
// pre-launch cmdline check catching it.

import { describe, expect, test } from "bun:test";
import { ISOLATED_SETTINGS_JSON } from "../../src/dogfood/state.ts";

describe("isolated settings.json shape", () => {
  const parsed = JSON.parse(ISOLATED_SETTINGS_JSON) as Record<string, unknown>;

  test("hooks is present and empty", () => {
    expect(parsed.hooks).toEqual({});
  });
  test("env is present and empty", () => {
    expect(parsed.env).toEqual({});
  });
  test("no statusLine field", () => {
    expect("statusLine" in parsed).toBe(false);
  });
  test("no plugins field", () => {
    expect("plugins" in parsed).toBe(false);
  });
  test("instructionFiles = managed-only", () => {
    expect(parsed.instructionFiles).toEqual("managed-only");
  });
  test("permissions.defaultMode = dontAsk", () => {
    const permissions = parsed.permissions as { defaultMode?: string; allow?: string[] } | undefined;
    expect(permissions?.defaultMode).toEqual("dontAsk");
  });
  test("permissions.allow contains exactly the three revkit MCP tools", () => {
    const permissions = parsed.permissions as { allow?: string[] } | undefined;
    expect(permissions?.allow).toEqual([
      "mcp__revkit__threads",
      "mcp__revkit__reply",
      "mcp__revkit__resolve",
    ]);
  });
});
