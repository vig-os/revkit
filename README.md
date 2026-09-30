<!-- Seeded by vigOS devkit — yours to edit; upgrades never overwrite this file. -->
<!-- Bugs / missing tools: https://github.com/vig-os/devkit/issues -->

# revkit

**HTML-first review for the agentic era.** Agents write structured documents (ADRs, designs, reports, questions) from
an opinionated, guarded component set. Humans read them rendered, answer questions through rich UIs instead of chat
prompts, and comment inline. Those comments flow back to the agent live, or become real GitHub PR review comments on
the exact source lines.

> **Status: design accepted, implementation starting.** Nothing is runnable yet. The architecture is
> [DESIGN-0001](docs/designs/DESIGN-0001-revkit-architecture.md) with [ADR-0001 to ADR-0024](docs/adr/README.md);
> implementation starts with milestone [M1](https://github.com/vig-os/revkit/milestone/1).

## What it will do

- **Local agent loop:** the agent opens a question page (choices with previews, ranking, sliders, pick-a-region on a
  plot) and gets your answer back in under a second. Comment on any block of a doc the agent wrote; comments reach
  it live (channel / WebSocket), batched on *handover*, or on demand, and survive rebuilds.
- **PR review:** CI builds a preview per PR and posts the link. Reviewers sign in with GitHub (or a personal invite
  link) and comment on the rendered doc. Comments land on the PR as review comments on file + line, as the reviewer.
- **Guarded authoring:** registered components only, one vocabulary, validated links and doc sets, plots as spec +
  data side files, LaTeX at build time, enforced by pre-commit and build.
- **Lean:** static HTML by default, Solid islands only where interaction needs them, plots and math rendered at build.

Stack: Astro + Starlight, Solid, Bun, Vega-Lite, KaTeX; hosting on one Cloudflare Worker per org (`review.exoma.org`). Ships as a Nix
flake that any repo, including vig-os devkit consumers, can opt into.

## Docs

| | |
|---|---|
| [DESIGN-0001](docs/designs/DESIGN-0001-revkit-architecture.md) | Architecture, user stories, agent interaction |
| [ADRs](docs/adr/README.md) | One decision per record |
| [Feature matrix](docs/FEATURE-MATRIX.md) | Story → ADR → milestone → issue |
| [Milestones](https://github.com/vig-os/revkit/milestones) | M1–M8 roadmap |

## Development

Requires Nix with flakes and direnv.

```bash
git clone https://github.com/vig-os/revkit && cd revkit
direnv allow          # or: nix develop
just                  # list recipes
just precommit        # run all hooks
just claude-plugin    # optional: vig-os devkit Claude Code plugin
```

Branching is gitflow (`<type>/<issue>-<summary>` from `dev`), with conventional commits carrying `Refs: #<issue>`.
Agents: start with [CLAUDE.md](CLAUDE.md).

### Try the agent loop locally

To see the M2 review loop end to end (comment on the rendered page → channel notification → agent reply → live update
in the rail), open two terminals in the worktree:

```bash
# Terminal 1: build the site and start the loopback daemon.
just build
bun packages/cli/bin/revkit.js serve --dir site/dist
# → prints `revkit serve: listening on http://127.0.0.1:<port>` and a
#   single-use launch URL. Open the launch URL in a browser to sign in.
```

```bash
# Terminal 2: start Claude Code with the revkit MCP server opted in.
# The `--dangerously-load-development-channels server:revkit` flag lets a
# development MCP channel be loaded (ADR-0007). The MCP server is registered
# in .mcp.json; if a daemon isn't running yet it auto-starts one.
claude --dangerously-load-development-channels server:revkit
# The agent can then mint a fresh launch URL from its own tools:
#   > use the `review_url` tool to open the review UI
```

Post a comment on any block from the rendered page (select text, click the floating "Comment", type, submit). The
agent receives a `notifications/claude/channel` frame in that session; ask it to reply with the `reply` tool. The
reply lands on the page without a reload.

Automated end-to-end proof: `just dogfood` runs the same loop headless in a disposable, locked-down flock pane
(no built-in tools; only `mcp__revkit__{threads,reply,resolve}` allowed; `env -i` at pane launch strips
`SSH_AUTH_SOCK` / `FLOCK_SOCKET_PATH` / `GH_TOKEN` / etc.; the pane's cwd is an isolated temp state dir under
`$XDG_RUNTIME_DIR` OUTSIDE the git worktree, with its own copy of `site/dist` and `docs/`, so the test agent never
sees the worktree's git tree). The lockdown is verified PRE-LAUNCH against the real claude process: after
`/proc/<pid>/exe` resolves to `.claude-wrapped` (closing the wrapper's pre-exec race), the harness reads
`/proc/<pid>/cmdline` and `/proc/<pid>/environ` and hard-fails on any missing required flag, any forbidden flag, or
any env var not on the explicit allowlist — before any prompt is sent. The dogfood comment is a natural reviewer's
note (channel content is untrusted; a well-aligned model may decline, and that decline surfaces as a reply-wait
timeout — see ADR-0007). Requires `flk` and a logged-in Claude; not part of `just test` or CI. See
[`.claude/skills/revkit_dogfood/SKILL.md`](.claude/skills/revkit_dogfood/SKILL.md) for the runbook.

## License

[Apache-2.0](LICENSE)
