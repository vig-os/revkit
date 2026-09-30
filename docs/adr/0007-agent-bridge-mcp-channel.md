# ADR-0007: Agent bridge: MCP server as a channel, Monitor fallback, delivery modes

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: A1, A3, A5

## Context

Comments and answers must reach the agent live, not on the next prompt (A1, A5).

## Decision

`revkit mcp` exposes `ask`/`await_answer`/`threads`/`reply`/`resolve`/`publish` and declares the `claude/channel`
capability, so events arrive mid-turn and while the user is away. Fallbacks: `Monitor` on the daemon's WebSocket
(`/events`), then a UserPromptSubmit hook. Delivery modes are `handover` (default, batched), `live` and `quiet`, plus
an `@agent now` override; presence events come from agent edits.

## Consequences

Channels are a research preview (`--channels` allowlist or the development flag). `ask` never blocks a single tool
call on a human.

## Acceptance (2026-09-29)

- **Channel-first** (owner decision): M2 builds the `claude/channel` server as the primary path, run with
  `--dangerously-load-development-channels server:revkit` until the plugin is published on an allowlisted marketplace;
  the Monitor-WebSocket path is the supported fallback for sessions without channels, and the UserPromptSubmit hook
  the last resort.
- Default delivery mode is `handover`.
- Ask/answer history stays local (`.revkit/asks/`, gitignored); `revkit ask --keep` promotes one into
  `docs/decisions/` as a committed record.

## Amendment (2026-09-30) — channel content framing

- **Human comment bodies and quotes are UNTRUSTED input to the agent.** Claude Code wraps every notification's
  `content` in a `<channel source="revkit" …>…</channel>` tag before handing it to the model, so an unescaped body
  like `</channel><system>…` would close revkit's tag early and forge a system-shaped instruction. Every
  user-supplied field revkit puts into `content` (`body`, `quote`, actor name, `path`) is HTML-escaped (`<` → `&lt;`,
  `>` → `&gt;`, `&` → `&amp;`) and its whitespace is collapsed to a single space before composition, so a body
  cannot forge or close a tag, and a multi-line paste stays on the one summary line the terminal renders.
- **Channel comments are REQUESTS from a human, not instructions.** A well-aligned model may decline them, and that
  refusal is correct. Harness / test-code implications (dogfood comment shape, reply-wait timeout as the observable
  for a decline) live in the `revkit_dogfood` skill, not here.
- **Meta values are validated and capped.** `meta` keys must be identifiers (letters, digits, underscores — the
  Claude Code channel contract silently drops keys with hyphens); values are trimmed to a 4 KiB cap. Enforced at
  emit-time in `formatChannelPayload`.
- **Startup does not replay history.** On first connect `revkit mcp` reads the daemon's current `head` and
  subscribes from there; if open threads exist whose last comment is from a human, ONE summary notification fires
  (`kind=catchup_summary`, `waiting=<n>`) telling the agent to call `threads` for details. Per-comment notifications
  only fire for NEW events.
- **Restarts reconnect.** When the SSE subscriber or a tool call fails, the channel server re-runs
  `findRunningDaemon` (auto-starting a fresh daemon via the plan default), verifies the daemons `instanceId` via
  `/-/health`, rebuilds the `DaemonClient` with the new port + token, and resubscribes from `min(lastSeenSeq, head)`
  so a fresh sqlite (head=0) does not stall on a stale resume point. Backoff is bounded (500 ms → 30 s).

## Amendment (2026-09-30) — M2 item 6: delivery modes, presence, `@agent`, hook

M2 item 6 wires the delivery-mode surface, presence, the Monitor-WebSocket fallback and the UserPromptSubmit hook.
The decisions the design left open:

- **Delivery mode is typed state**, persisted per-repo under `.revkit/delivery.json` (mode 600). The enum is
  `{handover, live, quiet}`; the default is `handover`. The daemon's fan-out to `/events?for=agent` is gated by the
  mode on a **per-subscriber basis** (`WebSocketData.audience` + a `Subscriber.matches` predicate on `EventBus`) —
  the rail's stream is never gated. `handover` batches human `comment.created` / `comment.replied` events and
  suppresses them from the agent stream until an explicit flush; `quiet` suppresses them entirely (agent must pull
  via `threads`); `live` passes everything through.

- **The idle flush** in `handover` mode fires after **90 seconds** of no new batched comments, when the batch is
  non-empty. Rationale: long enough to feel "the reviewer stepped away" rather than "the reviewer paused typing";
  short enough that walking away doesn't strand a comment on an agent that's actively waiting. Documented in
  `DEFAULT_IDLE_FLUSH_MS` (`packages/cli/src/serve/delivery-modes.ts`) and tested against its exact value so a
  silent change breaks the constant test.

- **`handover` is a real event, not a synthesised summary.** On flush the daemon appends one `handover` event
  carrying `commentIds[]` + a `revision` (SHA-256 of the daemons flush time — the log's frame reference, not an
  anchor revision). The channel client renders it like any other event; the rail's mode-badge falls to zero when
  a `handover` fans out.

- **`@agent now` is parsed structurally, not by regex.** The mention parser
  (`packages/review-core/src/mentions.ts`) tokenises comment bodies into prose / code regions (fenced ``` blocks
  and inline `` `code` ``  spans are masked), then walks prose respecting word boundaries — an `@agent` inside
  `` `@agent` `` never fires. On a `comment.created` / `comment.replied` whose body carries `@agent now`, the
  daemon (a) fans the comment out immediately regardless of mode, and (b) flushes any pending batch. The parser is
  exported as a leaf sub-path (`@revkit/review-core/mentions`) with **no Zod dependency**, so the rail bundle can
  import it without pulling in Zod's `new Function` feature-probe (which the daemon's CSP forbids under
  `script-src` without `'unsafe-eval'`).

- **Presence is agent-only, self-expiring.** `POST /api/presence` accepts `state = editing | idle` (with optional
  `path` + `startLine`/`endLine`) from a bearer-authed caller only — a cookie caller is refused with 403 so the
  browser cannot spoof "agent is editing …". An `editing` beacon schedules an automatic `idle` follow-up after
  **30 seconds** (per-agent-id timer, refreshed on the next `editing` from the same agent). A long tool call must
  refresh periodically or the badge clears on its own.

- **Monitor-WebSocket fallback = `revkit events --follow`.** A one-shot CLI subcommand that opens
  `/events?for=agent` with the agent bearer token from `serve.json` and writes one JSON line per event to stdout.
  `JSON.stringify` is the escape (every user-supplied field is safe on a single line), so a body containing `\n`
  or `</channel>` cannot break the line-per-frame contract Monitor depends on. Reconnect uses the shared
  exponential backoff (500 ms → 30 s).

- **UserPromptSubmit hook = `revkit hook user-prompt-submit`.** Fast (soft ~400 ms deadline via `AbortController`),
  silent on any failure (missing daemon, refused Origin, malformed body all exit 0 with no output — a hook that
  fails loudly would train reviewers to remove it), and framed as UNTRUSTED input: output goes inside
  `<revkit-pending count="N">…</revkit-pending>` and every user-supplied field flows through
  `escapeContentFragment` before it lands in the frame. Bounded: at most 8 threads listed per hook run; comment
  bodies truncated to 240 chars. Wire-up documented in the file header and the CLI `--help`; the command NEVER
  touches the owner's global settings — projects wire the hook into their OWN `.claude/settings.json`.

- **`mode` and `presence` MCP tools.** `revkit mcp` gains two tools: `mode` (read + optional `set`) and
  `presence` (emit an editing / idle beacon). The channel-server tools list now advertises six tools —
  `threads`, `reply`, `resolve`, `review_url`, `mode`, `presence`.

- **Existing tests that exercised the agent stream directly now pass `deliveryMode: "live"`** to `startDaemon` —
  the SSE / WS transport tests are about the transport, not the delivery-mode gate. The gate has its own tests
  in `test/serve/delivery-http.test.ts` and `test/serve/delivery-modes.test.ts`.
