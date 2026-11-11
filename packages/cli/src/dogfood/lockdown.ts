// Pure lockdown verifier. Given the parsed cmdline+environ of the child
// claude process and the expectations for this run, decide whether the
// process is safe to send instructions to.
//
// This module is deliberately I/O-free. `verifyRunning` in `runtime.ts`
// reads /proc, waits for the pre-exec race to close, and then calls
// `verifyLockdown` here with the parsed results.
//
// Round-3 (PR #42) established the properties this module preserves:
//   1. Required flags exact — presence AND value where applicable.
//   2. Forbidden flags absent.
//   3. `--allowedTools` list is EXACTLY the three MCP tools, in any order.
//   4. Env is a TRUE ALLOWLIST — every name in /proc/<pid>/environ must
//      be one we set (via env -i) OR one the nix claude wrapper adds.
//   5. LD_LIBRARY_PATH, if present, must contain only /nix/store entries.
//
// The self-test bad-flags path injects a violation and asserts this
// verifier's `ok` flag is false BEFORE the harness sends any prompt.
// See git log for `scripts/dogfood-channel.sh:verify_claude_lockdown`
// (the bash version issue #50 replaced).

import type { LockdownExpectations, LockdownResult, ProcCmdline, ProcEnviron } from "./types.ts";
import { argAfter, multiArgAfter } from "./proc.ts";

/** Names the harness sets via `env -i` at pane launch. */
export const OWNER_SET_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "TERM",
  "LANG",
];

/** Names the nix claude wrapper (makeCWrapper C binary) deterministically
 *  setenv's before exec'ing `.claude-wrapped`. Empirically stable — see
 *  `head -30 $(command -v claude)` for the wrapper source in the store. */
export const NIX_WRAPPER_ENV_ALLOWLIST: readonly string[] = [
  "LD_LIBRARY_PATH",
  "DISABLE_AUTOUPDATER",
  "FORCE_AUTOUPDATE_PLUGINS",
  "DISABLE_INSTALLATION_CHECKS",
  "USE_BUILTIN_RIPGREP",
];

/** The three MCP tools the test agent is allowed to call. */
export const ALLOWED_TOOLS: readonly string[] = [
  "mcp__revkit__threads",
  "mcp__revkit__reply",
  "mcp__revkit__resolve",
];

/** Every flag that MUST appear in the child claude's cmdline. */
export const REQUIRED_FLAGS: readonly string[] = [
  "--strict-mcp-config",
  "--mcp-config",
  "--permission-mode",
  "--tools",
  "--allowedTools",
  "--dangerously-load-development-channels",
  "--setting-sources",
  "--settings",
];

/** Every flag whose presence is a hard fail. */
export const FORBIDDEN_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--dangerously-allow-browser-network-access",
  "--bare",
];

/** Build the expectations bag for one run. */
export function makeExpectations(mcpConfigPath: string, settingsPath: string): LockdownExpectations {
  return {
    mcpConfigPath,
    settingsPath,
    allowedTools: ALLOWED_TOOLS,
    requiredFlags: REQUIRED_FLAGS,
    forbiddenFlags: FORBIDDEN_FLAGS,
    envAllowlist: [...OWNER_SET_ENV_ALLOWLIST, ...NIX_WRAPPER_ENV_ALLOWLIST],
  };
}

/** Verify every property against the parsed cmdline. Returns the FIRST
 *  reason the verification failed — callers should surface exactly that
 *  string in the log so the failure is grep-able. */
function verifyCmdline(argv: readonly string[], exp: LockdownExpectations): string | undefined {
  // 1. Required flags present.
  for (const flag of exp.requiredFlags) {
    if (!argv.includes(flag)) {
      return `required flag missing: ${flag}`;
    }
  }
  // 2. Forbidden flags absent.
  for (const flag of exp.forbiddenFlags) {
    if (argv.includes(flag)) {
      return `forbidden flag present: ${flag}`;
    }
  }
  // 3. Flag values.
  const mcpVal = argAfter(argv, "--mcp-config");
  if (mcpVal !== exp.mcpConfigPath) {
    return `--mcp-config value != ${exp.mcpConfigPath} (was: ${JSON.stringify(mcpVal)})`;
  }
  const permMode = argAfter(argv, "--permission-mode");
  if (permMode !== "dontAsk") {
    return `--permission-mode != dontAsk (was: ${JSON.stringify(permMode)})`;
  }
  // --tools "" — the value must be present and be the empty string. The
  // shell's `env -i … --tools ""` puts an empty string on argv, so the
  // /proc read gives us ""; anything else (missing, "default", etc.) fails.
  const toolsVal = argAfter(argv, "--tools");
  if (toolsVal !== "") {
    return `--tools != '' (was: ${JSON.stringify(toolsVal)})`;
  }
  // --setting-sources "" — same shape.
  const settingSources = argAfter(argv, "--setting-sources");
  if (settingSources !== "") {
    return `--setting-sources != '' (was: ${JSON.stringify(settingSources)})`;
  }
  // --settings <abs>
  const settings = argAfter(argv, "--settings");
  if (settings !== exp.settingsPath) {
    return `--settings value != ${exp.settingsPath} (was: ${JSON.stringify(settings)})`;
  }
  // 4. --allowedTools list.
  const allowed = multiArgAfter(argv, "--allowedTools");
  if (allowed.length !== exp.allowedTools.length) {
    return `--allowedTools count wrong: expected ${exp.allowedTools.length}, saw ${allowed.length} (${allowed.join(" ")})`;
  }
  const expected = new Set(exp.allowedTools);
  for (const a of allowed) {
    if (!expected.has(a)) return `unexpected --allowedTools entry: '${a}'`;
  }
  for (const e of exp.allowedTools) {
    if (!allowed.includes(e)) return `missing required --allowedTools entry: '${e}'`;
  }
  return undefined;
}

/** Verify the child's environ is a true allowlist. */
function verifyEnviron(env: ProcEnviron, exp: LockdownExpectations): string | undefined {
  const allowed = new Set(exp.envAllowlist);
  for (const name of env.names) {
    if (!allowed.has(name)) {
      return `env var not on the allowlist: '${name}'`;
    }
  }
  const ld = env.lookup("LD_LIBRARY_PATH");
  if (ld !== undefined) {
    // Every colon-separated entry must be under /nix/store.
    for (const entry of ld.split(":")) {
      if (entry === "") continue;
      if (!entry.startsWith("/nix/store/")) {
        return `LD_LIBRARY_PATH contains non-/nix/store entry: '${entry}'`;
      }
    }
  }
  return undefined;
}

/** Full lockdown verification against a parsed cmdline + environ. */
export function verifyLockdown(
  cmd: ProcCmdline,
  env: ProcEnviron,
  exp: LockdownExpectations,
): LockdownResult {
  const cmdReason = verifyCmdline(cmd.argv, exp);
  if (cmdReason !== undefined) return { ok: false, reason: cmdReason };
  const envReason = verifyEnviron(env, exp);
  if (envReason !== undefined) return { ok: false, reason: envReason };
  return {
    ok: true,
    summary: `${exp.requiredFlags.length} required flags present with correct values, ${exp.forbiddenFlags.length} forbidden flags absent, env is the explicit allowlist (${OWNER_SET_ENV_ALLOWLIST.length} ours + ${NIX_WRAPPER_ENV_ALLOWLIST.length} wrapper-added)`,
  };
}
