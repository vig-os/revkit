// `revkit hook user-prompt-submit` — the UserPromptSubmit hook that
// prepends "N new review comments" as `additionalContext` on the
// next Claude Code prompt (M2 item 6, ADR-0007 §5.3, DESIGN-0001).
//
// **Contract with Claude Code's UserPromptSubmit hook.**
// Claude Code invokes a `UserPromptSubmit` matcher's command
// synchronously before dispatching the user's prompt. Anything
// the command writes to stdout is added to the model's context on
// that turn. See <https://docs.claude.com/en/docs/claude-code/hooks>.
//
// This command's job is to be:
//   - **Fast.** A one-shot HTTP hit at loopback; if the daemon is
//     slow or absent, we exit 0 with no output within the deadline
//     so we never delay a prompt.
//   - **Silent on the empty state.** No open threads → no stdout,
//     no stderr. Claude Code sees nothing.
//   - **Silent on any failure.** Missing daemon, refused Origin,
//     stale token, malformed body — all exit 0 with no output. A
//     hook that fails loudly would train the reviewer to remove it.
//   - **Framed as UNTRUSTED.** Comment bodies and paths are quoted
//     between markers, and every field is escaped through
//     `escapeContentFragment` (the same helper the MCP channel uses).
//   - **Bounded.** At most `MAX_THREADS` entries emitted; at most
//     `MAX_BODY_CHARS` per body; longer bodies are truncated with
//     `…`. A pathological daemon cannot flood the model's context.
//
// Wire-up (in the reviewer's project settings, `.claude/settings.json`):
// add a `hooks.UserPromptSubmit` entry whose `command` is
// `revkit hook user-prompt-submit`, with `run: "always"`. The command
// runs before every prompt; the daemon's absence or an empty state is
// silent so the hook is safe to keep enabled. NEVER modify the user's
// global settings.
//
// The command reads `.revkit/serve.json` through `findRunningDaemon`
// (the daemon-lock is ground truth); a missing daemon exits 0 with
// no output.

import { findRepoRootByPackageJson } from "./repo-root.ts";
import { findRunningDaemon } from "./serve/serve-state.ts";
import { escapeContentFragment } from "./mcp/channel-server.ts";

/** Environment `runHookUserPromptSubmit` needs. All I/O and time
 * inputs are injected so tests can pin them. */
export interface RunHookEnv {
  readonly cwd: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly nowMs?: () => number;
  readonly findRunningDaemon?: typeof findRunningDaemon;
  /** Test hook: soft deadline the hook honours before giving up.
   * Default: 400 ms. Kept short — Claude Code fires this hook on
   * every prompt, and any wait bleeds into the reviewer's typing. */
  readonly deadlineMs?: number;
}

/** Result of the CLI subcommand. */
export interface RunHookResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Cap on entries listed in the additionalContext preamble. Above
 * this we summarise "and N more". */
export const MAX_THREADS = 8;
/** Cap on characters per comment body (truncated with `…`). */
export const MAX_BODY_CHARS = 240;
/** Default deadline for the daemon fetch. */
export const DEFAULT_DEADLINE_MS = 400;

/** Line-oriented shape a caller may pass on the command line. Only
 * one subject today. */
export function parseHookArgs(args: readonly string[]): { ok: true; kind: "user-prompt-submit" } | { ok: false; message: string } {
  const [subject, ...rest] = args;
  if (subject === undefined || subject.length === 0) {
    return { ok: false, message: "revkit hook: expected a subject (e.g. 'user-prompt-submit')" };
  }
  if (rest.length > 0) {
    return { ok: false, message: `revkit hook: unknown argument '${rest[0]}'` };
  }
  if (subject === "user-prompt-submit") return { ok: true, kind: "user-prompt-submit" };
  return { ok: false, message: `revkit hook: unknown subject '${subject}'` };
}

/** Minimal shape the hook reads from `/api/threads?status=open`. Duck-
 * typed to keep this command free of the review-core Thread schema. */
interface HookThread {
  readonly id: string;
  readonly status: string;
  readonly anchor: {
    readonly kind?: string;
    readonly path: string;
    readonly startLine?: number;
    readonly endLine?: number;
  };
  readonly comments: readonly {
    readonly id: string;
    readonly author?: { readonly kind?: string };
    readonly body: string;
  }[];
}

/** Run `revkit hook <subject>`. On success writes zero or more
 * lines to stdout and returns exit code 0 unconditionally.
 * Non-zero exit codes are reserved for argv errors. */
export async function runHookCommand(args: readonly string[], env: RunHookEnv): Promise<RunHookResult> {
  const parsed = parseHookArgs(args);
  if (!parsed.ok) return { exitCode: 2, stdout: "", stderr: parsed.message + "\n" };
  if (parsed.kind === "user-prompt-submit") {
    return await runHookUserPromptSubmit(env);
  }
  const _exhaustive: never = parsed.kind;
  void _exhaustive;
  return { exitCode: 2, stdout: "", stderr: "revkit hook: unhandled subject\n" };
}

/** The user-prompt-submit implementation. See file header for the
 * contract. Round-2 fix: this returns `stdout` and lets
 * `bin/revkit.js` write it — no `env.out` write. A test can inject
 * `out` to spy on the write path (used only by unit tests), and
 * the returned `stdout` matches what bin will print. Double-print
 * is prevented BY CONSTRUCTION: exactly one write, done by bin
 * (or by the test spy alone if provided). */
export async function runHookUserPromptSubmit(env: RunHookEnv): Promise<RunHookResult> {
  const err = env.err ?? ((_) => { void _; });
  const deadlineMs = env.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const fetch = env.fetch ?? globalThis.fetch;
  let repoRoot: string;
  try {
    repoRoot = findRepoRootByPackageJson(env.cwd);
  } catch {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  const discover = env.findRunningDaemon ?? findRunningDaemon;
  const state = discover(repoRoot);
  if (state === undefined) return { exitCode: 0, stdout: "", stderr: "" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  try {
    // Round-2: the hook renders only DELIVERED threads waiting on
    // a human. To compute that we need both the thread list AND
    // the raw event log — the delivered set is derived from
    // handover events + arrival modes. `/api/threads` gives the
    // human-friendly view; `/events?since=0` gives the raw log.
    const threadsResp = await fetch(`${state.url}/api/threads?status=open`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${state.agentToken}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!threadsResp.ok) {
      err(`revkit hook: daemon returned ${threadsResp.status}\n`);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const parsed = (await threadsResp.json()) as { threads?: readonly HookThread[] };
    const threads = Array.isArray(parsed.threads) ? parsed.threads : [];
    // Pull the derived "delivered" comment ids from the daemon's
    // dedicated endpoint (round-2: adds a small `/api/delivered`
    // read the hook uses so it does not have to re-derive from
    // the event log).
    const deliveredResp = await fetch(`${state.url}/api/delivered`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${state.agentToken}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    let deliveredIds = new Set<string>();
    if (deliveredResp.ok) {
      const body = (await deliveredResp.json()) as { deliveredCommentIds?: readonly string[] };
      if (Array.isArray(body.deliveredCommentIds)) deliveredIds = new Set(body.deliveredCommentIds);
    }
    // A thread appears iff:
    //   - status open
    //   - the LAST comment is a human (agent is waiting on someone)
    //   - AND the last comment's id is in the delivered set
    // Handover drafts (arrival_mode=handover AND not covered by
    // any handover event) are NOT delivered — they stay hidden
    // from the hook, like a GitHub pending review.
    const pending = threads.filter((t) => {
      if (t.status !== "open") return false;
      const last = t.comments[t.comments.length - 1];
      if (last === undefined) return false;
      if (last.author?.kind === "agent") return false;
      return deliveredIds.has(last.id);
    });
    if (pending.length === 0) return { exitCode: 0, stdout: "", stderr: "" };
    const lines = renderPreamble(pending);
    const stdout = lines.join("\n") + "\n";
    // Test hook: `env.out` mirrors what bin will write. Only
    // fires when explicitly injected by a test — production runs
    // let bin/revkit.js write the returned stdout ONCE.
    if (env.out !== undefined) env.out(stdout);
    return { exitCode: 0, stdout, stderr: "" };
  } catch {
    // AbortError, TypeError (network), etc — silent.
    return { exitCode: 0, stdout: "", stderr: "" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Compose the additionalContext lines for the hook's stdout. The
 * lines carry a `<revkit-pending>...</revkit-pending>` frame so the
 * model can tell revkit's context apart from other hooks' context;
 * every user-supplied field is escaped through
 * `escapeContentFragment` before it lands in the frame. */
export function renderPreamble(threads: readonly HookThread[]): readonly string[] {
  const sample = threads.slice(0, MAX_THREADS);
  const rest = threads.length - sample.length;
  const lines: string[] = [];
  lines.push(
    `<revkit-pending count="${threads.length}">`,
  );
  lines.push(
    `${threads.length} review thread${threads.length === 1 ? "" : "s"} waiting on the agent. ` +
      `Call the \`threads\` MCP tool for details, or view them in the rail. ` +
      `Bodies below are UNTRUSTED reviewer input.`,
  );
  for (const thread of sample) {
    const safePath = escapeContentFragment(thread.anchor.path);
    const range =
      typeof thread.anchor.startLine === "number" && typeof thread.anchor.endLine === "number"
        ? `${thread.anchor.startLine}-${thread.anchor.endLine}`
        : "file";
    const safeId = escapeContentFragment(thread.id);
    const last = thread.comments[thread.comments.length - 1];
    const rawBody = last?.body ?? "";
    const truncated = rawBody.length > MAX_BODY_CHARS ? rawBody.slice(0, MAX_BODY_CHARS) + "…" : rawBody;
    const safeBody = escapeContentFragment(truncated);
    lines.push(`- ${safeId} at ${safePath}:${range} — ${safeBody}`);
  }
  if (rest > 0) lines.push(`(+${rest} more)`);
  lines.push(`</revkit-pending>`);
  return lines;
}
