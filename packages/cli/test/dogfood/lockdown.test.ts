// Pure tests for the lockdown verifier.
//
// Each test builds a `/proc/<pid>/cmdline`-shaped byte string and a
// `/proc/<pid>/environ`-shaped one from the shared argv builder, so a
// change to the flag set can't accidentally green a test.

import { describe, expect, test } from "bun:test";
import { buildClaudeArgv } from "../../src/dogfood/argv.ts";
import { ALLOWED_TOOLS, makeExpectations, verifyLockdown } from "../../src/dogfood/lockdown.ts";
import { parseCmdline, parseEnviron } from "../../src/dogfood/proc.ts";

const BASE_OPTS = {
  claudeBin: "/nix/store/xxx-claude/bin/claude",
  envBin: "/usr/bin/env",
  mcpConfigPath: "/tmp/revkit-dogfood-abc/mcp-config.json",
  settingsPath: "/tmp/revkit-dogfood-abc/settings.json",
  claudeConfigDir: "/home/x/.claude",
  path: "/nix/store/y/bin:/usr/bin",
  home: "/home/x",
  term: "xterm-256color",
  lang: "C.UTF-8",
} as const;

/** Build a cmdline the child would present in /proc/<pid>/cmdline. */
function cmdlineFor(inject: boolean): string {
  const argv = buildClaudeArgv({ ...BASE_OPTS, injectBadFlags: inject });
  const claudeIdx = argv.indexOf(BASE_OPTS.claudeBin);
  return argv.slice(claudeIdx).join("\0");
}

/** Build the environ /proc would show for a well-behaved child. */
function environFor(extra: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    PATH: BASE_OPTS.path,
    HOME: BASE_OPTS.home,
    CLAUDE_CONFIG_DIR: BASE_OPTS.claudeConfigDir,
    TERM: BASE_OPTS.term,
    LANG: BASE_OPTS.lang,
    LD_LIBRARY_PATH: "/nix/store/aaa/lib:/nix/store/bbb/lib",
    DISABLE_AUTOUPDATER: "1",
    FORCE_AUTOUPDATE_PLUGINS: "0",
    DISABLE_INSTALLATION_CHECKS: "1",
    USE_BUILTIN_RIPGREP: "1",
    ...extra,
  };
  return Object.entries(base).map(([k, v]) => `${k}=${v}`).join("\0") + "\0";
}

describe("verifyLockdown — well-formed argv/environ", () => {
  test("passes when everything is present, exact, and env is on the allowlist", () => {
    const exp = makeExpectations(BASE_OPTS.mcpConfigPath, BASE_OPTS.settingsPath);
    const cmd = parseCmdline(cmdlineFor(false));
    const env = parseEnviron(environFor());
    const result = verifyLockdown(cmd, env, exp);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("required flags present");
  });
});

describe("verifyLockdown — bad-flags injection", () => {
  test("fails when --tools value is 'default' instead of ''", () => {
    const exp = makeExpectations(BASE_OPTS.mcpConfigPath, BASE_OPTS.settingsPath);
    const cmd = parseCmdline(cmdlineFor(true));
    const env = parseEnviron(environFor());
    const result = verifyLockdown(cmd, env, exp);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("--tools");
  });
});

describe("verifyLockdown — required / forbidden flag coverage", () => {
  test("fails when --strict-mcp-config is missing", () => {
    // Manually drop the flag from the argv the builder produces.
    const argv = buildClaudeArgv(BASE_OPTS).slice();
    const claudeIdx = argv.indexOf(BASE_OPTS.claudeBin);
    const filtered = argv.slice(claudeIdx).filter((a) => a !== "--strict-mcp-config");
    const cmd = parseCmdline(filtered.join("\0"));
    const env = parseEnviron(environFor());
    const exp = makeExpectations(BASE_OPTS.mcpConfigPath, BASE_OPTS.settingsPath);
    expect(verifyLockdown(cmd, env, exp).reason).toContain("--strict-mcp-config");
  });

  test("fails when --dangerously-skip-permissions is present", () => {
    const argv = buildClaudeArgv(BASE_OPTS).slice();
    const claudeIdx = argv.indexOf(BASE_OPTS.claudeBin);
    const child = [...argv.slice(claudeIdx), "--dangerously-skip-permissions"];
    const cmd = parseCmdline(child.join("\0"));
    const env = parseEnviron(environFor());
    const exp = makeExpectations(BASE_OPTS.mcpConfigPath, BASE_OPTS.settingsPath);
    expect(verifyLockdown(cmd, env, exp).reason).toContain("forbidden flag");
  });

  test("fails when --allowedTools has an unexpected entry", () => {
    // Replace one of the 3 allowed tools with a bogus one.
    const argv = buildClaudeArgv(BASE_OPTS).slice();
    const claudeIdx = argv.indexOf(BASE_OPTS.claudeBin);
    const child = argv
      .slice(claudeIdx)
      .map((a) => (a === ALLOWED_TOOLS[0] ? "Bash" : a));
    const cmd = parseCmdline(child.join("\0"));
    const env = parseEnviron(environFor());
    const exp = makeExpectations(BASE_OPTS.mcpConfigPath, BASE_OPTS.settingsPath);
    const result = verifyLockdown(cmd, env, exp);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/allowedTools/);
  });

  test("fails when --mcp-config path doesn't match", () => {
    const argv = buildClaudeArgv(BASE_OPTS).slice();
    const claudeIdx = argv.indexOf(BASE_OPTS.claudeBin);
    const child = argv
      .slice(claudeIdx)
      .map((a) => (a === BASE_OPTS.mcpConfigPath ? "/tmp/OTHER.json" : a));
    const cmd = parseCmdline(child.join("\0"));
    const env = parseEnviron(environFor());
    const exp = makeExpectations(BASE_OPTS.mcpConfigPath, BASE_OPTS.settingsPath);
    expect(verifyLockdown(cmd, env, exp).reason).toContain("--mcp-config");
  });

  test("fails when --setting-sources value is not empty", () => {
    const argv = buildClaudeArgv(BASE_OPTS).slice();
    const claudeIdx = argv.indexOf(BASE_OPTS.claudeBin);
    const child = argv.slice(claudeIdx);
    const settingIdx = child.indexOf("--setting-sources");
    // Replace the value after the flag.
    child[settingIdx + 1] = "user";
    const cmd = parseCmdline(child.join("\0"));
    const env = parseEnviron(environFor());
    const exp = makeExpectations(BASE_OPTS.mcpConfigPath, BASE_OPTS.settingsPath);
    expect(verifyLockdown(cmd, env, exp).reason).toContain("--setting-sources");
  });
});

describe("verifyLockdown — env allowlist", () => {
  test("fails when an unknown env var leaks in", () => {
    const exp = makeExpectations(BASE_OPTS.mcpConfigPath, BASE_OPTS.settingsPath);
    const cmd = parseCmdline(cmdlineFor(false));
    const env = parseEnviron(environFor({ SSH_AUTH_SOCK: "/tmp/sock" }));
    const result = verifyLockdown(cmd, env, exp);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("SSH_AUTH_SOCK");
  });

  test("fails when LD_LIBRARY_PATH holds a non-store entry", () => {
    const exp = makeExpectations(BASE_OPTS.mcpConfigPath, BASE_OPTS.settingsPath);
    const cmd = parseCmdline(cmdlineFor(false));
    const env = parseEnviron(environFor({ LD_LIBRARY_PATH: "/nix/store/aaa/lib:/usr/lib" }));
    const result = verifyLockdown(cmd, env, exp);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("LD_LIBRARY_PATH");
    expect(result.reason).toContain("/usr/lib");
  });

  test("accepts LD_LIBRARY_PATH with only /nix/store entries", () => {
    const exp = makeExpectations(BASE_OPTS.mcpConfigPath, BASE_OPTS.settingsPath);
    const cmd = parseCmdline(cmdlineFor(false));
    const env = parseEnviron(environFor({ LD_LIBRARY_PATH: "/nix/store/a/lib:/nix/store/b/lib" }));
    expect(verifyLockdown(cmd, env, exp).ok).toBe(true);
  });
});
