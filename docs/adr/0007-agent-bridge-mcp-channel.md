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

## Amendment (2026-09-30) — asks (M2 item 7, story A1)

Details of the M2 asks build-out (issue #7):

- **Wire.** Two MCP tools, `ask` and `await_answer`, alongside the existing `threads` / `reply` / `resolve` /
  `review_url`. `ask` returns `{ ask, url }` immediately (the daemon assigns the id, writes `.revkit/asks/<id>.json`
  at mode 0600, and appends `ask.created` to the event log); `await_answer` long-polls up to `timeout_ms` (capped at
  9 s to stay under the MCP tool deadline) and returns as soon as a terminal `ask.*` event lands. A `pending` return
  is normal — the agent calls again. The daemon pushes `ask.answered` over `/events`, so answer-to-agent latency is
  under 1 second (measured: median ~15 ms in the MCP contract test).
- **Lifecycle.** `pending` → `answered` | `cancelled` | `expired`. All four states live on the log (`ask.created`,
  `ask.answered`, `ask.cancelled`, `ask.expired`); `validateNext` refuses any second terminal transition with
  `ask-not-pending` naming the current status. Expiry is lazy: on `GET /api/asks[/:id]` and on the pre-answer sweep
  the daemon appends `ask.expired` for any pending ask past its `expiresAtMs`, so a slow answer POST that raced the
  deadline lands as `ask-not-pending` rather than winning silently.
- **HTTP roles.** `POST /api/asks` is agent-bearer only; `POST /api/asks/:id/answer` is session-cookie only (bearer
  alone is refused with 403 so a rogue agent cannot self-answer); `POST /api/asks/:id/cancel` is agent-bearer only.
  Every write goes through the shared Origin gate + `Sec-Fetch-Site` check; the answer body has its own 256 KiB cap
  on top of the 1 MiB request cap.
- **`/ask/<id>` page.** Session-cookie authenticated HTML served by the daemon. The Solid island is compiled at
  build time by `babel-preset-solid` (via `packages/cli/src/ask-page/bundle.ts`) and served at `/-/ask.js`; the CSP
  names that exact path and never carries `'unsafe-eval'`. The record is inlined as a JSON `<script>` tag —
  `encodeBootJson` escapes `</script`, `<!--` and `-->` so an agent-supplied `spec.title` cannot break out. All
  visible strings land through Solid's text-node path, never `innerHTML`. axe passes at ADR-0017's strict "any
  violation" gate on all six kinds (choice, rank, scale, text, region, review).
