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

## Amendment (2026-09-30, round 2) — Derived delivery, agent authority, ephemeral presence

Round-2 review of the PR-53 landing pointed out one root design flaw: the round-1
delivery state was split between an in-memory batch cache and an ad-hoc rehydration
that ignored the mode. Live comments and `@agent now` sends re-batched after a
restart and were delivered twice; `quiet → handover` gave different results in
memory and after a restart. Round 2 fixes this **by construction**:

- **Delivery state is fully DERIVED from the durable log.**
  - Every mode change is a `delivery.mode_changed` event carrying `from` / `to` /
    `actor`. There is NO `.revkit/delivery.json` — the round-1 file was removed.
  - Every delivery to the agent is a `handover` event with a typed `trigger`:
    `"live"` (bookkeeping for a live push — agent already saw the `comment.created`),
    `"agent-now"` (the marker comment + the prior batch, delivered together),
    `"handover"` (explicit reviewer hand-over), or `"mode-change-flush"` (only
    fires on `handover → live`, see below).
  - "Pending" is a pure function of the log: a human `comment.created` /
    `comment.replied` is pending iff its ARRIVAL MODE (the mode at its own `seq`)
    was `handover` AND no `handover` event lists its `commentId`. Live arrivals
    are delivered, never pending. Quiet arrivals are neither pending nor
    delivered (pull-only). The functions `pendingCommentIds`,
    `deliveredCommentIds` and `currentDeliveryMode` in `@revkit/review-core`
    are the single source of truth.
  - The in-memory adapter is a THIN wrapper that caches the derived answer for
    cheap `/api/delivery-mode` reads AND owns the idle-flush timer. It never
    writes state that the log does not carry.
  - **Restart property**: the pending set on the same log is identical
    before and after a restart, and no `commentId` is delivered twice or
    never. `packages/review-core/test/delivery.test.ts:PROPERTY` covers this
    over a random-ish sequence mixing modes, comments, handovers, agent-now
    flushes and prefixes.

- **`quiet` transitions (documented decision).** DESIGN §5.3 says `quiet` means
  "nothing is pushed; the agent pulls with `threads()`". The design is silent on
  what happens to comments made under quiet when the mode later changes. Round 2
  chooses: **quiet-mode comments are never pending, never auto-delivered — they
  reach the agent only through a `threads` pull OR through a subsequent explicit
  `@agent now` marker on a fresh comment.** Rationale: a quiet comment is a note
  the reviewer *deliberately* chose not to interrupt on; auto-delivering it on a
  later mode flip would surprise them. Reviewers who want a quiet-mode comment
  routed to the agent explicitly hand it over.

- **`handover → live` flushes; `handover → quiet` does NOT.** Round 1 flushed on
  every handover→X change, silently sending drafts under a mode the reviewer
  might not intend. Round 2: the daemon appends a `handover(trigger =
  "mode-change-flush")` event only on the `handover → live` transition. On
  `handover → quiet` the pending batch stays pending; a subsequent hand-over
  or flip back to handover keeps working.

- **Idle-timer restart.** On daemon boot, the adapter reads the current log
  and, if the derived pending set is non-empty AND the current mode is
  `handover`, re-arms the idle timer on the same schedule. A reviewer who
  left drafts pending before a crash still sees the auto-flush honoured.

- **Flush atomicity — cover BY IDS.** A concurrent comment appended between
  the moment the daemon decides to flush and the moment the `handover` event
  lands stays pending unless its `commentId` is on the delivery event. The
  daemon takes a `pendingCommentIds` snapshot, then appends a `handover`
  covering exactly that snapshot. Anything appended after stays pending
  until the NEXT flush covers it. Tested in
  `packages/cli/test/serve/delivery-http.test.ts`.

- **`@agent now` mention parser is Markdown-AST-aware.** Round 1 scanned
  characters and misfired on `\@agent`, 4-space indented code, inline
  `<code>`, HTML comments, and mismatched backticks. Round 2 parses the
  body on the DAEMON at append time with `remark-parse` and extracts
  mentions from prose text nodes only. `<code>...</code>` regions and
  `<!-- ... -->` comments are masked pre-parse (offsets preserved) so the
  AST never sees a mention inside them. The typed `Mention[]` list rides
  on the `comment.created` / `comment.replied` event; the rail renders
  chips from that data. This removes the parser from the browser bundle
  entirely.

- **Presence is EPHEMERAL, not durable.** The round-1 daemon appended
  `presence` events to sqlite; a restart resurrected stale "agent is
  editing…" beacons that reflected nothing. Round 2 keeps presence in
  memory only (`packages/cli/src/serve/presence-hub.ts`) and broadcasts
  each state change to `/events` subscribers directly. Fresh subscribers
  get the current state on connect. Presence carries no `seq` on the
  wire; `event-subscriber.ts` accepts frames without seq (they never
  advance the resume point).

- **Hook + catch-up summary use the derived DELIVERED set.** Round 1 leaked
  handover drafts (and quiet-mode comments) into the UserPromptSubmit hook
  and the MCP catch-up summary. Round 2 both callers pull the derived
  `deliveredCommentIds` from `GET /api/delivered` and filter to threads
  whose last comment is in that set — handover drafts stay hidden (like a
  GitHub pending review), quiet-mode comments stay hidden.

- **Hook single-write.** The round-1 hook wrote to `env.out` internally AND
  returned `stdout` for `bin/revkit.js` to write again, so the shell saw
  the pending block twice. Round 2: the hook returns `stdout` and bin
  writes it once. A test fixture spawning the REAL bin
  (`test/hook-cli.test.ts:BLOCKER 3`) is the regression net.

- **Agent authority — MCP surface.** The MCP `mode` tool is
  **read-only**: its inputSchema declares no `set` property. There is
  no MCP `flush` / `handover` tool. So a prompt-injected agent that
  can only reach the MCP surface has no way to flip the mode or drain
  drafts through the channel.

- **What handover IS NOT.** Handover mode controls when comments are
  PUSHED to the agent's channel — it is a DELIVERY-TIMING control, not
  a confidentiality guarantee. A same-user agent that can run `Bash`
  (or read `.revkit/serve.json`, mode 600, at its own uid) can:
  - `POST /api/delivery-mode {"mode":"live"}` and trigger the batch
    flush,
  - `POST /api/handover` and get `flushed: N`,
  - `GET /api/threads` and read every draft's body,
  - call the `threads` MCP tool and get the same shape.

  Round-2 originally claimed the bearer was "filesystem-gated" and
  drafts "never leak / are private WIP". Both are false at the local
  M2 daemon: the bearer sits in a file the agent's shell can read,
  and the `threads` MCP tool intentionally returns every open thread
  including handover drafts (the pull side of ADR-0007's design).
  This amendment retracts those claims.

- **What handover IS.** A UX contract: while the reviewer is drafting,
  the channel stays quiet — no per-comment notification, no
  additionalContext preamble on the next prompt. On explicit
  hand-over the drafts land in a single coherent frame. That contract
  is enforced on the PUSH surface only (`/events?for=agent`, the
  channel notifications, the `UserPromptSubmit` hook, the catch-up
  summary). PULL surfaces — `threads` MCP tool, `GET /api/threads`,
  `revkit events --follow` — return whatever the log carries.

- **Visibility for the reviewer.** When the agent (or any local
  caller) hits `POST /api/handover` or `POST /api/delivery-mode`, the
  daemon appends a `handover` (or `delivery.mode_changed`) event that
  carries the ACTOR who triggered it. The rail shows a small "flushed
  by …" indicator so the human sees an agent-initiated flush is
  distinguishable from their own click. `handover` fan-out on
  audience `["agent","rail"]` covers this.

- **Open question (a follow-up ADR).** A real draft-privacy
  guarantee — "the agent CANNOT read my drafts until I say so" —
  needs a separate credential path: a reviewer-only bearer stored
  outside the agent's uid (a keyring, a hardware-bound key, an OS
  keychain), plus a partition on the daemon's HTTP surface (reader
  vs. reviewer). That is out of scope for M2 item 6. Tracked as a
  planned follow-up.

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
