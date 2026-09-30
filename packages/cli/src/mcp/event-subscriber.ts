// SSE subscriber that watches the daemon's `/events?for=agent`
// stream and hands each `ReviewEvent` to a callback (the channel
// server's dispatch → `notifications/claude/channel`).
//
// Uses `fetch` streaming (available in Bun + Node ≥ 18) rather than
// `EventSource` — `EventSource` only accepts GET without body and
// pre-sets the `Origin` header in some runtimes. `fetch` lets us set
// exactly the headers the daemon expects (bearer, `Last-Event-ID` on
// resume) and no others.
//
// Resume: the subscriber tracks the last seen `seq`. On reconnect
// (network hiccup, daemon restart), the next request passes it as
// the `Last-Event-ID` header, and the daemon replays anything
// missed. `seq` must be strict decimal — the field carries a
// server-assigned integer, so no `NaN` slipping through.
//
// No `Origin` header is ever set. Sec-Fetch-Site is also omitted:
// the daemon's non-GET Origin check does not run against GETs, and
// even if it did, no header = "not a browser navigation", which the
// daemon accepts for a bearer-authenticated caller.

/** One review event as seen from the wire. The subscriber does not
 * validate against `reviewEventSchema` — the daemon already validated
 * before appending — but does insist on `seq` being an integer so
 * `Last-Event-ID` on reconnect is well-formed. */
export interface WireEvent {
  readonly seq: number;
  readonly kind: string;
  readonly ts: string;
  readonly threadId?: string;
  readonly [key: string]: unknown;
}

/** Options for `startEventSubscriber`. */
export interface EventSubscriberOptions {
  readonly url: string;
  readonly agentToken: string;
  /** Called for every event delivered on the stream (both replay-on-
   * connect and live). Returning a promise back-pressures the read
   * loop but never blocks the daemon side. */
  readonly onEvent: (event: WireEvent) => Promise<void> | void;
  /** Called on unrecoverable subscription errors (repeated fetch
   * failures). The caller may exit or restart. */
  readonly onError?: (error: Error) => void;
  /** Base delay between reconnect attempts (doubles on each retry
   * up to `maxRetryDelayMs`). Defaults to 500 ms. */
  readonly baseRetryDelayMs?: number;
  /** Cap on the reconnect backoff. Defaults to 30 s. */
  readonly maxRetryDelayMs?: number;
  /** Where to start on first connect. Defaults to 0 (replay from
   * scratch); the caller can pass the daemon's `head` from
   * `listThreads()` to skip the past. */
  readonly since?: number;
  /** Test hook: swap `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Test hook: injected sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Handle returned by `startEventSubscriber`. `close()` is
 * idempotent; awaiting the promise resolves when the subscriber has
 * finished tearing down. */
export interface EventSubscriberHandle {
  close(): void;
  readonly done: Promise<void>;
}

/** Start the subscriber. Runs a self-driven loop that reconnects on
 * failure with exponential backoff up to `maxRetryDelayMs`. */
export function startEventSubscriber(options: EventSubscriberOptions): EventSubscriberHandle {
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const baseDelay = options.baseRetryDelayMs ?? 500;
  const maxDelay = options.maxRetryDelayMs ?? 30_000;
  const url = new URL(options.url.replace(/\/+$/, "") + "/events");
  url.searchParams.set("for", "agent");

  let closed = false;
  let controller: AbortController | undefined;
  let lastSeen = options.since ?? 0;
  let delay = baseDelay;

  const loop = async (): Promise<void> => {
    while (!closed) {
      controller = new AbortController();
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.agentToken}`,
        accept: "text/event-stream",
      };
      if (lastSeen > 0) headers["last-event-id"] = String(lastSeen);
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          headers,
          signal: controller.signal,
        });
      } catch (cause) {
        if (closed) return;
        options.onError?.(new Error(`revkit mcp: /events connect failed: ${(cause as Error).message}`));
        await backoff();
        continue;
      }
      if (!response.ok || response.body === null) {
        options.onError?.(
          new Error(`revkit mcp: /events returned ${response.status}${response.body === null ? " (no body)" : ""}`),
        );
        await backoff();
        continue;
      }
      // Successful connect: reset backoff.
      delay = baseDelay;
      try {
        await consume(response.body, options.onEvent, (seq) => {
          if (Number.isInteger(seq) && seq > lastSeen) lastSeen = seq;
        });
      } catch (cause) {
        // A cancellation via `close()` throws AbortError — do not
        // report or retry that.
        if (closed) return;
        options.onError?.(new Error(`revkit mcp: /events stream broke: ${(cause as Error).message}`));
      }
      if (closed) return;
      // Stream ended (daemon exit, network reset) — reconnect.
      await backoff();
    }
  };

  const backoff = async (): Promise<void> => {
    if (closed) return;
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  };

  const done = loop();
  return {
    close(): void {
      if (closed) return;
      closed = true;
      controller?.abort();
    },
    done,
  };
}

/** Read an SSE stream: split on `\n\n`, ignore comment lines (`:`),
 * parse `id: <n>` and `data: <json>` fields, hand parsed events to
 * `onEvent`. The daemon emits at most one `data:` field per event
 * (`event-bus.ts:sseFrame`); keeps the parser small. */
async function consume(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: WireEvent) => Promise<void> | void,
  onSeq: (seq: number) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    // Frames are separated by a blank line.
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseFrame(frame);
      if (parsed !== undefined) {
        onSeq(parsed.seq);
        await onEvent(parsed);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

/** Parse one SSE frame into a `WireEvent`, or `undefined` if it was
 * a keepalive / malformed. Only fields `id:` and `data:` matter to
 * this consumer — `event:` and `retry:` are ignored by the daemon
 * anyway. */
function parseFrame(frame: string): WireEvent | undefined {
  let dataJson: string | undefined;
  for (const line of frame.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // SSE comment / keepalive
    if (line.startsWith("data:")) {
      dataJson = line.slice("data:".length).trimStart();
    }
    // We do not need to read the `id:` line — the event's own `seq`
    // field is authoritative (the daemon assigns `id: <seq>` from
    // the same value).
  }
  if (dataJson === undefined || dataJson.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const event = parsed as Partial<WireEvent>;
  if (typeof event.seq !== "number" || !Number.isInteger(event.seq)) return undefined;
  if (typeof event.kind !== "string") return undefined;
  if (typeof event.ts !== "string") return undefined;
  return event as WireEvent;
}
