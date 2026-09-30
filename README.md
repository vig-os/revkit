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

Automated end-to-end proof: `just dogfood` runs the same loop headless in a disposable, locked-down flock pane. No
built-in tools; only `mcp__revkit__{threads,reply,resolve}` allowed. `env -i` at pane launch strips `SSH_AUTH_SOCK`
/ `FLOCK_SOCKET_PATH` / `GH_TOKEN` / etc. The pane's cwd is an isolated temp state dir under `$XDG_RUNTIME_DIR`
OUTSIDE the git worktree. `--setting-sources ""` + `--settings <state-dir>/settings.json` isolates the pane from
the owner's user / project / local settings (no hooks, no statusLine, no env block, no plugins,
`instructionFiles: "managed-only"` drops the owner's global CLAUDE.md). The lockdown is verified PRE-LAUNCH against
the real claude process — after `/proc/<pid>/exe` resolves to `.claude-wrapped`, the harness hard-fails on any
missing required flag, any forbidden flag, or any env var not on the explicit allowlist — AND POST-RUN via three
empirical isolation checks (owner statusline / hook / CLAUDE.md markers must be absent from the pane and the
transcript). The dogfood comment is a natural reviewer's note (channel content is untrusted; a well-aligned model
may decline). Requires `flk` and a logged-in Claude; not part of `just test` or CI. See
[`.claude/skills/revkit_dogfood/SKILL.md`](.claude/skills/revkit_dogfood/SKILL.md) for the runbook.

## Adopt revkit (one line)

revkit ships as a flake ([ADR-0010](docs/adr/0010-distribution-flake-opt-in.md), D1). This is **M5 part 1**: the
flake plumbing (packages, template, hooks) that a consumer picks up in one input. It does NOT yet include
`revkit build` — the step that renders a consumer's `docs/` through revkit's packaged Astro/Starlight site.
Until M5 part 2 lands, an external consumer can lint their docs (`revkit check`) and consume revkit as a Nix
input, but the packaged site does not render consumer docs. See
[DESIGN-0002 §5](docs/designs/DESIGN-0002-devkit-review-module.md#5-gap-between-m5-part-1-and-full-d1-acceptance)
for the exact gap and the follow-up plan.

Scaffold a fresh docs repo from the template:

```bash
mkdir my-docs && cd my-docs && git init
nix flake init -t github:vig-os/revkit
direnv allow                          # or: nix develop
revkit check                          # ADR-0005 authoring guards
nix build                             # runs revkit check under a docs derivation
# revkit serve                        # M5 part 2 — needs `revkit build` first
```

Or wire it into an existing flake:

```nix
# your flake.nix
{
  inputs.revkit.url = "github:vig-os/revkit";
  outputs = { self, nixpkgs, revkit, ... }: let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};
  in {
    # 1. Put `revkit` on the dev-shell PATH.
    devShells.${system}.default = pkgs.mkShell {
      packages = [ revkit.packages.${system}.revkit ];
    };
    # 2. (Optional) merge revkit's pre-commit hooks into your devkit hooks.
    #    See docs/designs/DESIGN-0002-devkit-review-module.md.
    #      hooks = revkit.lib.hooks.mkHooks {
    #        revkit = revkit.packages.${system}.revkit;
    #      } // { /* your own hooks */ };
  };
}
```

The one-line marker for a consumer repo is a `package.json` at the workspace root carrying `"revkit": {}` — the
CLI walks the tree from that manifest. The template ships one; an existing repo appends it to its own manifest.

Flake outputs (M5 part 1):

| Output | What it is |
|---|---|
| `packages.<system>.revkit` | Reproducible Bun-based CLI: `revkit --help`, `revkit check`, `revkit serve` |
| `packages.<system>.default` | Same drv as `packages.revkit` |
| `apps.<system>.revkit` | `nix run github:vig-os/revkit -- <args>` |
| `templates.default` | `nix flake init -t github:vig-os/revkit` — a minimal docs repo |
| `lib.hooks.mkHooks` | Reusable pre-commit hook definitions (see `nix/hooks.nix`) |

**Supported systems.** `packages.<system>` is exposed only for the systems CI verifies with a captured deps
hash: `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`. `x86_64-darwin` is NOT supported today — GitHub-hosted
`macos-*` runners are arm64 only, so verifying that system would need a self-hosted runner. A `nix build`
target on an unsupported system fails at eval with an "attribute missing" error rather than at build time with
a mismatched hash.

A `review` capability module for vig-os/devkit — `DEVKIT_MODULES="node review"` for the whole opt-in — is
proposed in [DESIGN-0002](docs/designs/DESIGN-0002-devkit-review-module.md) and tracked at the vig-os/revkit
elevation ledger [#1](https://github.com/vig-os/revkit/issues/1). This repo does not open the upstream issue on
its own; the ledger candidate is the design note itself.

## License

[Apache-2.0](LICENSE)
