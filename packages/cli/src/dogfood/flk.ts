// Thin typed wrappers around the `flk` CLI. `flk` prints JSON envelopes
// on stdout when a subcommand is called with the `--json` shape or with
// no flags at all; both `agent start` and `agent list` return
// `{ result: { … } }`.
//
// Every function fails soft — a non-zero exit from flk is common at
// teardown when the pane is already gone. Callers use `undefined` as
// the "no data" signal.

import { spawnSync } from "node:child_process";

/** Return type of `flk agent start`. */
interface AgentStartResult {
  agent?: { pane_id?: string };
  pane_id?: string;
}

interface AgentListEntry {
  name?: string;
  pane_id?: string;
  agent_session?: string | null;
}

interface FlkEnvelope<T> {
  result?: T;
}

/** Start a flock agent, running `argv` with the given cwd. */
export function agentStart(opts: {
  readonly name: string;
  readonly cwd: string;
  readonly argv: readonly string[];
}): { readonly paneId: string | undefined; readonly raw: string } {
  const args = ["agent", "start", opts.name, "--cwd", opts.cwd, "--no-focus", "--", ...opts.argv];
  const r = spawnSync("flk", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const raw = (r.stdout?.toString?.() ?? "") + (r.stderr?.toString?.() ?? "");
  if (r.status !== 0) {
    return { paneId: undefined, raw };
  }
  try {
    const parsed = JSON.parse(r.stdout?.toString?.() ?? "{}") as FlkEnvelope<AgentStartResult>;
    const paneId = parsed.result?.agent?.pane_id ?? parsed.result?.pane_id;
    return { paneId, raw };
  } catch {
    return { paneId: undefined, raw };
  }
}

/** List agents. Returns undefined when flk failed or produced junk. */
export function agentList(): readonly AgentListEntry[] | undefined {
  const r = spawnSync("flk", ["agent", "list"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  if (r.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(r.stdout?.toString?.() ?? "{}") as FlkEnvelope<{ agents?: AgentListEntry[] }>;
    return parsed.result?.agents ?? [];
  } catch {
    return undefined;
  }
}

/** Look up a pane id by agent name. */
export function paneIdByName(name: string): string | undefined {
  const agents = agentList();
  if (agents === undefined) return undefined;
  const hit = agents.find((a) => a.name === name);
  return hit?.pane_id;
}

/** Read the pane's on-screen text (last `lines` lines). Undefined on failure. */
export function paneRead(paneId: string, lines = 80): string | undefined {
  const r = spawnSync("flk", ["agent", "read", paneId, "--lines", String(lines)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (r.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(r.stdout?.toString?.() ?? "{}") as FlkEnvelope<{ read?: { text?: string } }>;
    return parsed.result?.read?.text ?? "";
  } catch {
    return undefined;
  }
}

/** Close a pane by its id. Best-effort. */
export function paneClose(paneId: string): boolean {
  const r = spawnSync("flk", ["pane", "close", paneId], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return r.status === 0;
}

/** Send a semantic key ("Enter", "Down", …) to a pane. */
export function paneSendKeys(paneId: string, key: string): boolean {
  const r = spawnSync("flk", ["pane", "send-keys", paneId, key], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return r.status === 0;
}

/** Send raw text (or escape sequences) to a pane. */
export function paneSendText(paneId: string, text: string): boolean {
  const r = spawnSync("flk", ["pane", "send-text", paneId, text], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return r.status === 0;
}

/** Wait for the pane's agent to reach the "ready" state. */
export function agentWaitReady(paneId: string, timeoutMs = 30_000): boolean {
  const r = spawnSync("flk", ["agent", "wait", paneId, "--ready", "--timeout", String(timeoutMs)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return r.status === 0;
}

/** Run an instruction inside a pane. */
export function paneRun(paneId: string, prompt: string): boolean {
  const r = spawnSync("flk", ["pane", "run", paneId, prompt], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return r.status === 0;
}

/** Get the JSON row for one agent by name; returns `null` for
 *  `agent_session`'s empty state, `undefined` if the row is missing. */
export function agentSessionOf(name: string): string | null | undefined {
  const agents = agentList();
  if (agents === undefined) return undefined;
  const row = agents.find((a) => a.name === name);
  if (row === undefined) return undefined;
  return row.agent_session ?? null;
}
