<!-- Seeded by vigOS devkit — yours to edit; upgrades never overwrite this file. -->
<!-- Bugs / missing tools: https://github.com/vig-os/devkit/issues -->

# revkit

**HTML-first review for the agentic era.** Agents write structured documents (ADRs, designs, reports, questions) from
an opinionated, guarded component set. Humans read them rendered, answer questions through rich UIs instead of chat
prompts, and comment inline. Those comments flow back to the agent live, or become real GitHub PR review comments on
the exact source lines.

> **Status: design phase.** Nothing is runnable yet. The architecture is under review in
> [DESIGN-0001](docs/designs/DESIGN-0001-revkit-architecture.md) and ADR-0001 to ADR-0011; implementation starts
> with milestone [M1](https://github.com/vig-os/revkit/milestone/1).

## What it will do

- **Local agent loop:** the agent opens a question page (choices with previews, ranking, sliders, pick-a-region on a
  plot) and gets your answer back in under a second. Comment on any block of a doc the agent wrote; comments reach
  it live (channel / WebSocket), batched on *handover*, or on demand, and survive rebuilds.
- **PR review:** CI builds a preview per PR and posts the link. Reviewers sign in with GitHub (or a personal invite
  link) and comment on the rendered doc. Comments land on the PR as review comments on file + line, as the reviewer.
- **Guarded authoring:** registered components only, one vocabulary, validated links and doc sets, plots as spec +
  data side files, LaTeX at build time, enforced by pre-commit and build.
- **Lean:** static HTML by default, Solid islands only where interaction needs them, plots and math rendered at build.

Stack: Astro + Starlight, Solid, Bun, Vega-Lite, KaTeX; hosting on one Cloudflare Worker per org. Ships as a Nix
flake that any repo, including vig-os devkit consumers, can opt into.

## Docs

| | |
|---|---|
| [DESIGN-0001](docs/designs/DESIGN-0001-revkit-architecture.md) | Architecture, user stories, agent interaction |
| [ADRs](docs/adr/README.md) | One decision per record |
| [Feature matrix](docs/FEATURE-MATRIX.md) | Story → ADR → milestone → issue |
| [Milestones](https://github.com/vig-os/revkit/milestones) | M1–M7 roadmap |

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

## License

[Apache-2.0](LICENSE)
