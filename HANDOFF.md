# Power-cut handoff — 2026-10-12

## Current state

- Worktree: /home/larsgerchow/.flock/worktrees/revkit-7befa4bc/bugfix-176-cf-tooling-hardening
- Branch: bugfix/176-cf-tooling-hardening
- Implementation commit: 631a31f287c472560b4c08dd1ea025d06001e8e7, already pushed. Before this handoff, worktree was clean and HEAD matched upstream (0 ahead / 0 behind).
- PR: https://github.com/vig-os/revkit/pull/177
- PR base: feature/160-dev-cloudflare-env (stacked on PR #168, original base 6e6542c1).
- Requested implementation is complete. No running build or test jobs from this task.

## Completed

- Wrangler environment allowlist; refuse forbidden caller target/transport and proxy variables by name only; clear ambient credentials before loading selected credentials; preserve NO_COLOR.
- Pin private empty env files; disable Bun dotenv discovery; reject worker .env*/.dev.vars* in dev recipes; regenerate durable ignores.
- Invert mutation gate to reviewed non-destructive commands; all other verbs require --yes-really and TTY confirmation. Validate dev allowlist before prompting; forward cf-dev-deploy flags.
- Confine --file to repository, exclude credential directory and escaping symlinks; refuse general file aliases and repeated ambiguous flags.
- Prune only generated backups, recognize previous double-dot names, migrate legacy backup once, preserve user files.
- Update operator docs, append ADR-0014 amendment, update matrix Q7 and changelog. Document R8 PTY limitation.
- PR body records changed assertions/fixtures and RED→GREEN evidence.

## Verification already completed

- nix develop -c just lint: exit 0.
- nix develop -c bun test packages/worker/test/cf-dev.test.ts: 142 pass, 0 fail, 636 assertions, exit 0.
- Strict pinned TypeScript check for scripts/cf*.ts: passed.
- All commit hooks: passed.
- Baseline 6e6542c1 with new R1–R7 tests: 59 fail, 1 existing .env ignore check pass, 82 filtered out, exit 1.
- No real credentials read and no Cloudflare requests made. All wrapper executions used fake Wrangler/dummy credentials and localhost listeners.

## Open items / next steps after restart

1. Read this handoff and inspect git status/upstream before making changes.
2. Implementation needs no further work unless coordinator/architect requests the single fix round on this same branch/PR.
3. If requested, inspect PR #177 review/CI state and address concrete findings; CI status was not checked during the emergency shutdown.
4. Keep the stacked base; do not merge dev or change the base without instructions.

## Constraints and references

- Brief: /home/larsgerchow/Projects/revkit/.architect/briefs/176.md
- Hard rules: /home/larsgerchow/Projects/revkit/.architect/briefs/_rules.md
- Detailed prior handoff: /home/larsgerchow/Projects/revkit/.architect/handoff-176.md
- OFFLINE ONLY: never read/source ~/.config/revkit/cf.env or contact Cloudflare. Use fake Wrangler and localhost listeners.
- Scratch/TMPDIR under /dev/shm; these volatile logs/checkouts may disappear on shutdown. Test summaries and PR evidence above persist.
- Do not run the full Worker suite; existing #158 harness limitation. Commit inside nix develop; never bypass hooks or use git stash.
