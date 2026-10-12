# Power-cut handoff — 2026-10-12

## Current state

Stopped at coordinator request; no builds or background jobs started.
Working branch: `feature/175-block-map`.
Implementation commit: `94042a197f81921951b25eddb15ff6568b51ff28`, already pushed to
`origin/feature/175-block-map`. Working tree was clean before this handoff.
PR into `dev`: https://github.com/vig-os/revkit/pull/179.

Brief #175 slice 1 is implemented: versioned Markdown block maps and validation,
shared mdast extraction, runtime-neutral GFM/math parser, renderer capture and
parity tests, sparse correspondence with split/merge refusal, Unicode snapshot
tables, cached raw alignments and daemon snapshot/map reuse. Production
re-anchoring acceptance and exact-move policy remain unchanged. MDX preparation
stays unavailable. A8 matrix row and design note updated; no ADR amendment.

## Completed verification

- `git merge origin/dev`: already up to date at `763f2571` during implementation.
- `nix develop -c just lint`: exit 0.
- Review-core: 557 pass, 2 optional skips, 0 fail.
- CLI: 1657 pass, 16 opt-in skips, 0 fail.
- Local workerd parser test: 1 pass, 0 fail, 17 assertions.
- Existing anchoring assertions unchanged; commit hooks passed.
- New tests fail against origin/dev's missing APIs/cache diagnostics and pass
  with the implementation. RED module-load failures are documented honestly.

## Open items and next steps

1. Resume from this file; inspect git status and PR #179 review/CI status.
2. Await coordinator/architect review; apply any requested fix on this branch.
3. The supplied report has literal R1/R2 fixtures but no literal R6 sources.
   An asynchronous request for R6 was sent. Its described merge-plus-append
   behavior is tested; original verbatim replay remains pending those inputs.
4. Slice 2 remains tracked by #175: structural acceptance, endpoint walking and
   scoring, R4/R7, M5/M6 mutation witnesses and the frozen differential gate.
   Do not claim zero WRONG or improved acceptance from slice 1.

## Constraints and recovery notes

Read the brief at `~/Projects/revkit/.architect/briefs/175a.md` and hard rules at
`~/Projects/revkit/.architect/briefs/_rules.md` before further work. No Cloudflare
access or credentials; no deployments; PRs target dev. Commit inside nix develop.
No sub-agent work was started.

Worker parser bundling requires production mode and workerd/worker conditions:
Bun test's development condition pulls in debug/Electron code, while the browser
entity decoder requires a DOM. The test explicitly exercises the compatible
bundle in local workerd without nodejs_compat.

Additional handoff: `~/Projects/revkit/.architect/handoff-175.md`.
Scratch logs and RED checkout were under `/dev/shm/revkit-175`; they may disappear
on shutdown. Persistent PR body contains validation and RED/GREEN evidence.
