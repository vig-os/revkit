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
