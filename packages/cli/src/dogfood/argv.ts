// Build the argv the pane runs the child claude with. Kept as a pure
// helper so the lockdown-verifier tests can build the same argv the
// runtime will send.
//
// The invariant: this is the ONLY place the flag set is defined. The
// `verifyLockdown` check reads /proc/<pid>/cmdline and asserts every
// flag matches; a stray edit here fails that check before any prompt
// is sent.

import { ALLOWED_TOOLS } from "./lockdown.ts";

export interface ClaudeArgvOpts {
  readonly claudeBin: string;
  readonly envBin: string;
  readonly mcpConfigPath: string;
  readonly settingsPath: string;
  readonly claudeConfigDir: string;
  readonly path: string;
  readonly home: string;
  readonly term: string;
  readonly lang: string;
  /** For DOGFOOD_SELFTEST_BAD_FLAGS=1 only: replace `--tools ""` with
   *  `--tools default`. The self-test asserts verifyLockdown catches
   *  this BEFORE any prompt is sent. */
  readonly injectBadFlags?: boolean;
}

export function buildClaudeArgv(opts: ClaudeArgvOpts): readonly string[] {
  const toolsValue = opts.injectBadFlags === true ? "default" : "";
  const claudeArgs: string[] = [
    opts.claudeBin,
    "--model",
    "haiku",
    "--strict-mcp-config",
    "--mcp-config",
    opts.mcpConfigPath,
    "--dangerously-load-development-channels",
    "server:revkit",
    "--permission-mode",
    "dontAsk",
    "--tools",
    toolsValue,
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--setting-sources",
    "",
    "--settings",
    opts.settingsPath,
  ];
  // `env -i` — start claude with an EMPTY env, then set only what it needs.
  const envArgs: string[] = [
    opts.envBin,
    "-i",
    `PATH=${opts.path}`,
    `HOME=${opts.home}`,
    `CLAUDE_CONFIG_DIR=${opts.claudeConfigDir}`,
    `TERM=${opts.term}`,
    `LANG=${opts.lang}`,
  ];
  return [...envArgs, ...claudeArgs];
}
