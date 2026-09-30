// Shared types for the dogfood harness (issue #50).
//
// The Bun port preserves every property PR #42 established over 7
// review rounds — see .claude/skills/revkit_dogfood/SKILL.md for the
// full runbook and the failure playbook. This module holds the shapes
// that cross module boundaries so the pure helpers stay dependency-free.

/** Where the daemon's state lives for one run. Created outside the
 *  git worktree, under `$XDG_RUNTIME_DIR` (tmpfs, per-user) or `/tmp`. */
export interface StateDir {
  readonly path: string; // absolute; never inside the repo
  readonly mcpConfigPath: string; // <path>/mcp-config.json (absolute)
  readonly settingsPath: string; // <path>/settings.json (absolute)
  readonly siteDist: string; // <path>/site-dist
}

/** Handle to the isolated `revkit serve` daemon we started. */
export interface DaemonHandle {
  readonly pid: number; // verified against serve.json.pid
  readonly url: string; // http://127.0.0.1:<port>
  readonly port: number;
  readonly agentToken: string;
  readonly stateDir: StateDir;
  readonly logPath: string; // moved to .revkit/dogfood/daemon.log on success
}

/** Handle to the disposable test claude pane, plus the agent name we
 *  used so teardown can look it up by name if PANE_ID was lost. */
export interface PaneHandle {
  paneId: string | undefined; // mutable — recoverable by name lookup
  readonly agentName: string;
}

/** Result of parsing /proc/<pid>/cmdline (NUL-separated argv). */
export interface ProcCmdline {
  readonly argv: readonly string[];
  readonly raw: string; // spaces for logging
}

/** Result of parsing /proc/<pid>/environ (NUL-separated NAME=VALUE). */
export interface ProcEnviron {
  readonly pairs: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly names: ReadonlySet<string>;
  readonly lookup: (name: string) => string | undefined;
}

/** Everything the lockdown verifier needs to know for one run. */
export interface LockdownExpectations {
  readonly mcpConfigPath: string;
  readonly settingsPath: string;
  readonly allowedTools: readonly string[]; // exactly 3
  readonly requiredFlags: readonly string[]; // must be present
  readonly forbiddenFlags: readonly string[]; // must be absent
  readonly envAllowlist: readonly string[]; // names allowed in the child
}

/** Pure result of running the lockdown check. `ok=false` explains why. */
export interface LockdownResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly summary?: string;
}
