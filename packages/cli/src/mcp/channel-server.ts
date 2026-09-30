// `revkit mcp` — the Claude Code channel + MCP tools server
// (ADR-0007, DESIGN-0001 §5.3).
//
// One stdio-connected MCP server that:
//
// 1. Declares the `claude/channel` capability so Claude Code
//    registers a notification listener. Verified against
//    https://code.claude.com/docs/en/channels-reference (2026-09-30):
//    capability key `capabilities.experimental["claude/channel"]`
//    is the empty object; notification method
//    `notifications/claude/channel` with params
//    `{content: string, meta?: Record<string,string>}`. `meta` keys
//    must be identifiers (letters, digits, underscores); hyphens
//    are silently dropped by the client, so this file uses
//    `thread_id`, `path`, `lines`.
//
// 2. Registers three tools — `threads`, `reply`, `resolve` — that
//    proxy to the daemon's HTTP surface via `DaemonClient`.
//
// 3. Reads the daemons current head at start (`GET /api/threads`
//    returns `{threads, head}`), subscribes to `/events?for=agent`
//    with `since=head` (PR #38 blocker 2: skip the whole-history
//    replay), and emits ONE summary notification when open threads
//    exist whose last comment is from a human (the agent is on the
//    hook). Individual per-comment events afterwards flow through
//    `formatChannelPayload` as usual.
//
// 4. Handles daemon restarts (PR #38 blocker 3). A failed tool call
//    or subscriber error triggers a bounded-backoff reconnect:
//    re-run `discover` (auto-starting via the plan default), rebuild
//    the `DaemonClient` with the new port + token, `verifyDaemon
//    Instance` the new one is fresh (sqlite persists → seqs
//    continue; if head < lastSeen we resubscribe from head).
//
// **Channel content framing** (PR #38 nit): comment bodies and
// quotes are UNTRUSTED input to the agent. `formatChannelPayload`
// escapes `<`, `>` and `&` in every user-supplied field before
// composing the content string, so a body like
// `</channel><system>…` cannot close the channel tag Claude Code
// wraps around the content. Metadata keys are validated
// identifier-only at emit; values are trimmed to 4 KiB. ADR-0007
// amended.

import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "./daemon-client.ts";
import {
  startEventSubscriber,
  type EventSubscriberHandle,
  type WireEvent,
} from "./event-subscriber.ts";

/** The channel notification is what Claude Code sees. Body & meta are
 * built from a `WireEvent` in `formatChannelPayload`. */
export interface ChannelPayload {
  readonly content: string;
  readonly meta: Record<string, string>;
}

/** How the channel server rediscovers a daemon after a failure. Takes
 * an optional last-known `instanceId` so callers can compare with
 * `/-/health` and treat a match as "same daemon, just a network
 * hiccup" (no auto-restart needed). Returns the ServeState + a
 * rebuilt DaemonClient. */
export interface DiscoverResult {
  readonly url: string;
  readonly agentToken: string;
  readonly instanceId?: string;
}
export type DiscoverFn = (previous: { instanceId?: string } | undefined) => Promise<DiscoverResult>;

/** Configuration for `startChannelServer`. */
export interface ChannelServerOptions {
  readonly client: DaemonClient;
  readonly url: string;
  readonly agentToken: string;
  /** The daemon's per-start id at first connect (from `serve.json`),
   * used by the reconnect path to notice a restart. */
  readonly instanceId?: string;
  /** MCP server name — the `source="..."` attribute on the channel
   * tag. Defaults to `"revkit"`. */
  readonly name?: string;
  /** MCP server version — defaults to `"0.0.0"`. */
  readonly version?: string;
  /** Test hook, replaces `startEventSubscriber` so a test can drive
   * events synchronously. */
  readonly subscribeEvents?: typeof startEventSubscriber;
  /** Which transport to bind. Defaults to stdio; tests use
   * `InMemoryTransport.createLinkedPair()`. */
  readonly transport?: Transport;
  /** Reconnect discovery. Called on subscriber/tool failure. Returns
   * a fresh `{url, agentToken, instanceId}`. Default: no reconnect
   * (used by tests that do not need the loop). CLI wires it to
   * `ensureDaemon` + `verifyDaemonInstance`. */
  readonly discover?: DiscoverFn;
  /** Base delay between reconnect attempts (doubles up to cap). */
  readonly reconnectBaseDelayMs?: number;
  /** Reconnect backoff cap. */
  readonly reconnectMaxDelayMs?: number;
  /** Test hook: sleep function (ms). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** One running channel server. `stop()` is idempotent and closes
 * both the SSE subscriber and the MCP transport. */
export interface ChannelServerHandle {
  readonly server: Server;
  stop(): Promise<void>;
}

/** Escape a user-supplied string before embedding it in the channel
 * notification's `content` — the receiver wraps the content in a
 * `<channel …>…</channel>` tag, so `<`/`>`/`&` in the body must be
 * neutralised to prevent tag forgery. Also collapses runs of
 * whitespace so a newline-heavy paste stays on the one summary
 * line the terminal renders. */
export function escapeContentFragment(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cap on a single meta value's length. Claude Code truncates
 * `description` / `input_preview` around 3.5 KiB; the channel
 * notification path is smaller — 4 KiB is comfortable and stops a
 * pathological path or thread id from blowing up the frame. */
export const META_VALUE_MAX = 4096;

/** MCP tool schemas. */
const THREADS_TOOL = {
  name: "threads",
  description:
    "List review threads on the daemon. Filter by anchor path or status. Returns {threads, head}.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Filter to threads whose anchor.path equals this repo-relative path.",
      },
      status: {
        type: "string",
        enum: ["open", "resolved"],
        description: "Filter to threads in this state.",
      },
    },
    additionalProperties: false,
  },
} as const;

const REPLY_TOOL = {
  name: "reply",
  description:
    "Reply to a review thread. `thread_id` and `parent_id` are the ids from `threads`; `parent_id` is the comment being replied to (usually the last comment). `body` is the reply text.",
  inputSchema: {
    type: "object",
    properties: {
      thread_id: { type: "string", description: "The thread id from `threads`." },
      parent_id: { type: "string", description: "The comment id being replied to." },
      body: { type: "string", description: "The reply text.", maxLength: 65536 },
    },
    required: ["thread_id", "parent_id", "body"],
    additionalProperties: false,
  },
} as const;

const RESOLVE_TOOL = {
  name: "resolve",
  description: "Mark a review thread resolved. Optional resolution note.",
  inputSchema: {
    type: "object",
    properties: {
      thread_id: { type: "string", description: "The thread id from `threads`." },
      resolution: {
        type: "string",
        description: "One-line summary of the resolution.",
      },
    },
    required: ["thread_id"],
    additionalProperties: false,
  },
} as const;

/** Wire shape the daemon returns for a thread. Duck-typed here so we
 * don't drag `@revkit/review-core` types into the wire boundary. */
interface WireComment {
  readonly id: string;
  readonly author?: { readonly kind?: string; readonly id?: string; readonly displayName?: string };
  readonly body: string;
}
interface WireThread {
  readonly id: string;
  readonly status: "open" | "resolved";
  readonly anchor: {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
  };
  readonly comments: readonly WireComment[];
}

/** Emit a compact "N thread(s) waiting on the agent" summary when
 * one or more open threads have a human as their last commenter.
 * The agent uses `threads` to fetch details; we don't spam per-comment
 * notifications. Returns the payload, or undefined if nothing was
 * waiting. */
export function formatCatchupSummary(
  threads: readonly WireThread[],
): ChannelPayload | undefined {
  const waiting = threads.filter((thread) => {
    if (thread.status !== "open") return false;
    const last = thread.comments[thread.comments.length - 1];
    if (last === undefined) return false;
    return last.author?.kind !== "agent";
  });
  if (waiting.length === 0) return undefined;
  // The summary lists at most the first ~10 threads (ids + paths) so
  // the notification body stays terminal-sized; the count is the
  // total.
  const sample = waiting.slice(0, 10);
  const lines = sample.map((thread) => {
    const path = escapeContentFragment(thread.anchor.path);
    const range = `${thread.anchor.startLine}-${thread.anchor.endLine}`;
    return `- ${thread.id} at ${path}:${range}`;
  });
  const more = waiting.length > sample.length
    ? `\n(+${waiting.length - sample.length} more)`
    : "";
  const content =
    `${waiting.length} review thread${waiting.length === 1 ? "" : "s"} waiting on the agent. ` +
    `Call the \`threads\` tool for details.\n` +
    lines.join("\n") +
    more;
  const meta: Record<string, string> = {
    waiting: String(waiting.length),
    kind: "catchup_summary",
  };
  return { content, meta };
}

/** Format a `WireEvent` into the channel notification's `content` and
 * `meta`. Only human-authored events are relevant (an agent event
 * would be a loopback echo of the agent's own reply, which Claude
 * does not need to hear about). Content fields (`body`, `path`,
 * `actor`) are HTML-escaped before embedding — a body containing
 * `</channel>` cannot close the tag the receiver wraps around
 * `content`. Meta keys are already validated identifiers; values
 * are trimmed to `META_VALUE_MAX` characters. */
export function formatChannelPayload(event: WireEvent): ChannelPayload | undefined {
  const kind = event.kind;
  const relevantKinds = new Set([
    "comment.created",
    "comment.replied",
    "thread.resolved",
    "thread.reopened",
  ]);
  if (!relevantKinds.has(kind)) return undefined;
  const actor = event.actor as { readonly kind?: string; readonly id?: string; readonly displayName?: string } | undefined;
  if (actor === undefined) return undefined;
  if (actor.kind === "agent") return undefined;
  const threadId = typeof event.threadId === "string" ? event.threadId : undefined;
  const anchor = event.anchor as
    | { readonly path?: string; readonly startLine?: number; readonly endLine?: number }
    | undefined;
  const path = anchor?.path;
  const startLine = anchor?.startLine;
  const endLine = anchor?.endLine;
  const rawBody = typeof event.body === "string" ? event.body : undefined;

  const meta: Record<string, string> = {};
  const put = (key: string, value: string): void => {
    // Identifier check per the docs — dropped keys silently vanish
    // on the wire, so we drop them here to make the contract visible.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    meta[key] = value.length > META_VALUE_MAX ? value.slice(0, META_VALUE_MAX) : value;
  };
  if (threadId !== undefined) put("thread_id", threadId);
  if (path !== undefined) put("path", path);
  if (startLine !== undefined && endLine !== undefined) put("lines", `${startLine}-${endLine}`);

  const safeActor = escapeContentFragment(
    actor.displayName ?? actor.id ?? actor.kind ?? "human",
  );
  const safePath = path !== undefined ? escapeContentFragment(path) : "unknown";
  const safeBody = rawBody !== undefined ? escapeContentFragment(rawBody) : undefined;
  const safeThreadId = threadId !== undefined ? escapeContentFragment(threadId) : "unknown";

  let content: string;
  switch (kind) {
    case "comment.created":
      content = safeBody !== undefined
        ? `New comment on ${safePath}:${startLine ?? "?"}-${endLine ?? "?"} from ${safeActor} — ${safeBody}`
        : `New comment on ${safePath} from ${safeActor}.`;
      break;
    case "comment.replied":
      content = safeBody !== undefined
        ? `Reply on thread ${safeThreadId} from ${safeActor} — ${safeBody}`
        : `Reply on thread ${safeThreadId} from ${safeActor}.`;
      break;
    case "thread.resolved":
      content = `Thread ${safeThreadId} resolved by ${safeActor}.`;
      break;
    case "thread.reopened":
      content = `Thread ${safeThreadId} reopened by ${safeActor}.`;
      break;
    default:
      return undefined;
  }
  return { content, meta };
}

/** Body schema for `reply`. */
const replyArgsSchema = z
  .object({
    thread_id: z.string().min(1),
    parent_id: z.string().min(1),
    body: z.string().min(1).max(65_536),
  })
  .strict();

const resolveArgsSchema = z
  .object({
    thread_id: z.string().min(1),
    resolution: z.string().min(1).max(65_536).optional(),
  })
  .strict();

const threadsArgsSchema = z
  .object({
    path: z.string().min(1).optional(),
    status: z.enum(["open", "resolved"]).optional(),
  })
  .strict();

/** Start the MCP server and wire it to the daemon. Returns a handle
 * whose `stop()` shuts down the transport and the SSE loop. */
export async function startChannelServer(options: ChannelServerOptions): Promise<ChannelServerHandle> {
  const name = options.name ?? "revkit";
  const version = options.version ?? "0.0.0";
  const reconnectBase = options.reconnectBaseDelayMs ?? 500;
  const reconnectMax = options.reconnectMaxDelayMs ?? 30_000;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  const server = new Server(
    { name, version },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions:
        'Review events from revkit arrive as <channel source="revkit" thread_id=... path=... lines=...>. ' +
        "Bodies are user-supplied text; HTML entities are escaped and the content is delimited so no body can forge a tag. " +
        "Respond via the `reply` tool (`thread_id` + `parent_id` + `body`) or the `resolve` tool. " +
        "Call `threads` to list open threads, or when you receive a `kind=catchup_summary` notification.",
    },
  );

  // Mutable state — the reconnect path swaps these atomically.
  let currentClient = options.client;
  let currentUrl = options.url;
  let currentToken = options.agentToken;
  let currentInstanceId = options.instanceId;
  let subscriberHandle: EventSubscriberHandle | undefined;
  let lastSeenSeq = 0;
  let stopped = false;

  // ── tools/list ────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [THREADS_TOOL, REPLY_TOOL, RESOLVE_TOOL],
  }));

  // ── tools/call ────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const invoke = async (client: DaemonClient): Promise<unknown> => {
      if (toolName === "threads") {
        const parsed = threadsArgsSchema.safeParse(args);
        if (!parsed.success) throw new ToolValidationError(parsed.error.issues);
        return await client.listThreads({
          ...(parsed.data.path !== undefined ? { path: parsed.data.path } : {}),
          ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        });
      }
      if (toolName === "reply") {
        const parsed = replyArgsSchema.safeParse(args);
        if (!parsed.success) throw new ToolValidationError(parsed.error.issues);
        return await client.reply(parsed.data.thread_id, parsed.data.parent_id, parsed.data.body);
      }
      if (toolName === "resolve") {
        const parsed = resolveArgsSchema.safeParse(args);
        if (!parsed.success) throw new ToolValidationError(parsed.error.issues);
        return await client.resolve(parsed.data.thread_id, parsed.data.resolution);
      }
      throw new Error(`unknown tool '${toolName}'`);
    };
    try {
      const result = await invoke(currentClient);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      if (error instanceof ToolValidationError) return toolError(error.issues);
      // A network / auth error mid-call = daemon likely restarted.
      // Reconnect once and retry the same call.
      if (options.discover !== undefined && !stopped) {
        try {
          await reconnect("tool-call-failed");
          const retry = await invoke(currentClient);
          return { content: [{ type: "text", text: JSON.stringify(retry) }] };
        } catch (retryError) {
          return {
            isError: true,
            content: [{ type: "text", text: `revkit mcp: tool '${toolName}' failed after reconnect: ${(retryError as Error).message}` }],
          };
        }
      }
      return {
        isError: true,
        content: [{ type: "text", text: `revkit mcp: tool '${toolName}' failed: ${(error as Error).message}` }],
      };
    }
  });

  // ── prime: read head + emit catchup summary if any ────────────────
  // PR #38 blocker 2: on start, LIST threads (also gives us `head`),
  // subscribe from `head` (so old events don't replay), and emit ONE
  // summary notification when open threads are waiting on the agent.
  const emitNotification = async (payload: ChannelPayload): Promise<void> => {
    try {
      await server.notification({
        method: "notifications/claude/channel",
        params: { content: payload.content, meta: payload.meta },
      });
    } catch {
      // Notifications are fire-and-forget per the docs.
    }
  };

  const primeAndSubscribe = async (): Promise<void> => {
    // 1. Fetch the current state — gives us `head` and the open
    //    threads for the catchup decision.
    const listing = await currentClient.listThreads();
    lastSeenSeq = listing.head ?? 0;
    const summary = formatCatchupSummary(listing.threads as readonly WireThread[]);
    if (summary !== undefined) {
      await emitNotification(summary);
    }
    // 2. Subscribe from `head`. Only NEW events will fan out.
    const subscribe = options.subscribeEvents ?? startEventSubscriber;
    subscriberHandle = subscribe({
      url: currentUrl,
      agentToken: currentToken,
      since: lastSeenSeq,
      onEvent: async (event: WireEvent) => {
        if (event.seq > lastSeenSeq) lastSeenSeq = event.seq;
        const payload = formatChannelPayload(event);
        if (payload === undefined) return;
        await emitNotification(payload);
      },
      onError: (error) => {
        if (options.discover !== undefined && !stopped) {
          void reconnect(`subscriber-error: ${error.message}`);
        }
      },
    });
  };

  // ── reconnect loop (bounded backoff) ─────────────────────────────
  let reconnecting: Promise<void> | undefined;
  const reconnect = async (reason: string): Promise<void> => {
    if (options.discover === undefined) return;
    if (reconnecting !== undefined) {
      await reconnecting;
      return;
    }
    void reason; // Kept as a log hook — no logger in this file yet.
    reconnecting = (async (): Promise<void> => {
      let delay = reconnectBase;
      while (!stopped) {
        try {
          subscriberHandle?.close();
          subscriberHandle = undefined;
          const next = await options.discover!({ instanceId: currentInstanceId });
          currentUrl = next.url;
          currentToken = next.agentToken;
          currentInstanceId = next.instanceId;
          currentClient = new DaemonClient({ url: currentUrl, agentToken: currentToken });
          // If the daemon is fresh (new instanceId), the head may
          // be BEHIND our lastSeenSeq (a wiped sqlite would restart
          // at 1). Cap our resume at the current head.
          const listing = await currentClient.listThreads();
          const head = listing.head ?? 0;
          if (lastSeenSeq > head) lastSeenSeq = head;
          const subscribe = options.subscribeEvents ?? startEventSubscriber;
          subscriberHandle = subscribe({
            url: currentUrl,
            agentToken: currentToken,
            since: lastSeenSeq,
            onEvent: async (event: WireEvent) => {
              if (event.seq > lastSeenSeq) lastSeenSeq = event.seq;
              const payload = formatChannelPayload(event);
              if (payload === undefined) return;
              await emitNotification(payload);
            },
            onError: (error) => {
              if (!stopped) void reconnect(`re-subscriber-error: ${error.message}`);
            },
          });
          return;
        } catch {
          if (stopped) return;
          await sleep(delay);
          delay = Math.min(delay * 2, reconnectMax);
        }
      }
    })();
    try {
      await reconnecting;
    } finally {
      reconnecting = undefined;
    }
  };

  // ── connect ───────────────────────────────────────────────────────
  // Connect the transport BEFORE priming so `server.notification`
  // has somewhere to write. The MCP handshake (initialize) runs
  // over the transport once both ends are attached; the summary
  // notification the prime step emits flows in the next frame
  // after `initialize`, which is fine — Claude Code processes
  // channel notifications independent of the request/response
  // cycle.
  const transport: Transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);

  // Prime the SSE resume + emit the catchup summary.
  await primeAndSubscribe();

  return {
    server,
    async stop(): Promise<void> {
      stopped = true;
      subscriberHandle?.close();
      subscriberHandle = undefined;
      try {
        await server.close();
      } catch {
        // Already closed.
      }
    },
  };
}

class ToolValidationError extends Error {
  constructor(readonly issues: unknown) {
    super("invalid tool args");
    this.name = "ToolValidationError";
  }
}

function toolError(issues: unknown): {
  readonly isError: true;
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
} {
  return {
    isError: true,
    content: [{ type: "text", text: `revkit mcp: invalid tool args: ${JSON.stringify(issues)}` }],
  };
}

// Named exports the CLI + tests reach for.
export { threadsArgsSchema, replyArgsSchema, resolveArgsSchema };
export { THREADS_TOOL, REPLY_TOOL, RESOLVE_TOOL };
