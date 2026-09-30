// `revkit mcp` — the Claude Code channel + MCP tools server
// (ADR-0007, DESIGN-0001 §5.3).
//
// One stdio-connected MCP server that:
//
//   1. Declares the `claude/channel` capability so Claude Code
//      registers a notification listener. Verified against
//      https://code.claude.com/docs/en/channels-reference (2026-09-30):
//      the capability key is `capabilities.experimental["claude/channel"] = {}`
//      and the notification method is `notifications/claude/channel`
//      with params `{content: string, meta?: Record<string,string>}`.
//      `meta` keys must be identifiers (letters, digits, underscores) —
//      the docs say hyphens are silently dropped, so we use
//      `thread_id`, `path`, `lines` here rather than kebab.
//
//   2. Registers three tools — `threads`, `reply`, `resolve` — that
//      proxy to the daemon's HTTP surface via `DaemonClient`.
//
//   3. Subscribes to `/events?for=agent` and, on each human-authored
//      `comment.created` / `comment.replied` / `thread.resolved` /
//      `thread.reopened`, emits a `notifications/claude/channel`
//      event whose `content` is a compact human-readable summary
//      and whose meta carries `thread_id`, `path`, and `lines`.
//
// The tool schemas match the DaemonClient methods. The channel
// notification body is deliberately terse — one line so a paused
// terminal still shows it, plus the file:line so the agent can
// jump straight to the source.

import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { DaemonClient } from "./daemon-client.ts";
import { startEventSubscriber, type EventSubscriberHandle, type WireEvent } from "./event-subscriber.ts";

/** The channel notification is what Claude Code sees. Body & meta are
 * built from a `WireEvent` in `formatChannelPayload`. */
export interface ChannelPayload {
  readonly content: string;
  readonly meta: Record<string, string>;
}

/** Configuration for `startChannelServer`. `client` and `url` /
 * `agentToken` are both taken so tests can pass a fake client and
 * still drive the event subscription against a real fixture daemon,
 * or vice versa. */
export interface ChannelServerOptions {
  readonly client: DaemonClient;
  readonly url: string;
  readonly agentToken: string;
  /** MCP server name — the `source="..."` attribute on the channel
   * tag. Defaults to `"revkit"`. */
  readonly name?: string;
  /** MCP server version — defaults to `"0.0.0"`. */
  readonly version?: string;
  /** Optional: test hook, replaces `startEventSubscriber` so a test
   * can drive events synchronously. */
  readonly subscribeEvents?: typeof startEventSubscriber;
  /** Optional: which transport to bind. Defaults to stdio — the only
   * transport Claude Code speaks to a channel over. Tests pass a
   * paired in-memory transport (`InMemoryTransport`) to drive the
   * server without a subprocess. */
  readonly transport?: Transport;
}

/** One running channel server. `stop()` is idempotent and closes
 * both the SSE subscriber and the MCP transport. */
export interface ChannelServerHandle {
  readonly server: Server;
  stop(): Promise<void>;
}

/** MCP tool schemas. Kept as plain JSON-Schema objects so the SDK
 * can advertise them via `tools/list` without a zod-to-json-schema
 * indirection. */
const THREADS_TOOL = {
  name: "threads",
  description:
    "List review threads on the daemon. Optional filter by path and status. Returns {threads, head}.",
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
    "Reply to a review thread. `parentId` is the id of the comment being replied to (usually the last comment in the thread; use `threads` to find it).",
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

/** Format a `WireEvent` into the channel notification's `content` and
 * `meta`. Only human-authored events are relevant (an agent event
 * would be a loopback echo of the agent's own reply, which Claude
 * does not need to hear about). */
export function formatChannelPayload(event: WireEvent): ChannelPayload | undefined {
  const kind = event.kind;
  // Only comment/thread transitions are user-facing — a `presence`,
  // `handover`, or `ask.answered` is out of scope for item 3.
  const relevantKinds = new Set([
    "comment.created",
    "comment.replied",
    "thread.resolved",
    "thread.reopened",
  ]);
  if (!relevantKinds.has(kind)) return undefined;
  const actor = event.actor as { readonly kind?: string; readonly id?: string; readonly displayName?: string } | undefined;
  if (actor === undefined) return undefined;
  // Skip loopback of the agent's own actions — the agent already
  // knows about a reply it just sent.
  if (actor.kind === "agent") return undefined;
  const threadId = typeof event.threadId === "string" ? event.threadId : undefined;
  const anchor = event.anchor as
    | { readonly path?: string; readonly startLine?: number; readonly endLine?: number }
    | undefined;
  const path = anchor?.path;
  const startLine = anchor?.startLine;
  const endLine = anchor?.endLine;
  const body = typeof event.body === "string" ? event.body : undefined;

  const meta: Record<string, string> = {};
  if (threadId !== undefined) meta["thread_id"] = threadId;
  if (path !== undefined) meta["path"] = path;
  if (startLine !== undefined && endLine !== undefined) {
    meta["lines"] = `${startLine}-${endLine}`;
  }
  const actorLabel = actor.displayName ?? actor.id ?? actor.kind ?? "human";
  let content: string;
  switch (kind) {
    case "comment.created":
      content = body !== undefined
        ? `New comment on ${path ?? "unknown"}:${startLine ?? "?"}-${endLine ?? "?"} from ${actorLabel} — ${body}`
        : `New comment on ${path ?? "unknown"} from ${actorLabel}.`;
      break;
    case "comment.replied":
      content = body !== undefined
        ? `Reply on thread ${threadId ?? "unknown"} from ${actorLabel} — ${body}`
        : `Reply on thread ${threadId ?? "unknown"} from ${actorLabel}.`;
      break;
    case "thread.resolved":
      content = `Thread ${threadId ?? "unknown"} resolved by ${actorLabel}.`;
      break;
    case "thread.reopened":
      content = `Thread ${threadId ?? "unknown"} reopened by ${actorLabel}.`;
      break;
    default:
      return undefined;
  }
  return { content, meta };
}

/** Body schema for `reply` — kept in one place so the handler and
 * the test share it. */
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

  const server = new Server(
    { name, version },
    {
      capabilities: {
        // Presence of `claude/channel` under `experimental` is what
        // registers Claude Code's inbound notification listener.
        // Value is intentionally `{}` — the docs say so verbatim.
        experimental: { "claude/channel": {} },
        // We ship reply tools too (this is a two-way channel).
        tools: {},
      },
      // Delivered to Claude as context when the server connects.
      // Tells the agent what shape events take and which tools to
      // call in response.
      instructions:
        "Review events from revkit arrive as <channel source=\"revkit\" thread_id=... path=... lines=...>. " +
        "Read them, then respond via the `reply` tool (with thread_id + parent_id + body) or the `resolve` tool. " +
        "Use the `threads` tool to list open threads at any time.",
    },
  );

  // ── tools/list ────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [THREADS_TOOL, REPLY_TOOL, RESOLVE_TOOL],
  }));

  // ── tools/call ────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (toolName === "threads") {
      const parsed = threadsArgsSchema.safeParse(args);
      if (!parsed.success) return toolError(parsed.error.issues);
      const result = await options.client.listThreads({
        ...(parsed.data.path !== undefined ? { path: parsed.data.path } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }
    if (toolName === "reply") {
      const parsed = replyArgsSchema.safeParse(args);
      if (!parsed.success) return toolError(parsed.error.issues);
      const result = await options.client.reply(parsed.data.thread_id, parsed.data.parent_id, parsed.data.body);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }
    if (toolName === "resolve") {
      const parsed = resolveArgsSchema.safeParse(args);
      if (!parsed.success) return toolError(parsed.error.issues);
      const result = await options.client.resolve(
        parsed.data.thread_id,
        parsed.data.resolution,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }
    return {
      isError: true,
      content: [{ type: "text", text: `revkit mcp: unknown tool '${toolName}'` }],
    };
  });

  // ── SSE subscriber ────────────────────────────────────────────────
  const subscribe = options.subscribeEvents ?? startEventSubscriber;
  const subscriberHandle: EventSubscriberHandle = subscribe({
    url: options.url,
    agentToken: options.agentToken,
    onEvent: async (event: WireEvent) => {
      const payload = formatChannelPayload(event);
      if (payload === undefined) return;
      // `notification()` writes the frame to stdio and resolves. Claude
      // Code does not ack — the docs say so. If the session hasn't
      // opted this server in as a channel, the event is dropped
      // silently client-side.
      try {
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content: payload.content,
            meta: payload.meta,
          },
        });
      } catch {
        // Notification failures are non-fatal — the daemon still
        // holds the event (append-only), and a re-subscribe on
        // reconnect replays it via `since`.
      }
    },
  });

  // ── connect ───────────────────────────────────────────────────────
  // `server.connect(transport)` takes ownership of the transport
  // (Protocol JSDoc). Stdio is the default; a test can pass a paired
  // `InMemoryTransport` to drive the server without a subprocess.
  const transport: Transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);

  return {
    server,
    async stop(): Promise<void> {
      subscriberHandle.close();
      try {
        await server.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/** Format a Zod issue array as an MCP tool error. */
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
