# `revkit review <pr>` — usage

Local PR review, on loopback, with the reviewer's own `gh` identity. No App, no Cloudflare, no repo secrets
(ADR-0025).

## What it does

Given a PR number or URL, `revkit review`:

1. Resolves the PR through the GitHub adapter using the reviewer's `gh auth token` (in memory only — never
   written to disk, never sent to the browser).
2. Refuses the review if the local `origin` remote's `owner/repo` does not match the PR's
   `owner/repo`, or if the PR is from a fork whose head repo has been deleted, unless the reviewer passes
   `--trust <sha>`.
3. Fetches the PR head and base commits into the local git object DB through a hardened `git` wrapper
   (no hooks, no submodules, no filter/smudge drivers, no `protocol.file`, no `protocol.ext`).
4. Re-reads the fetched head SHA and refuses to continue unless it matches what GitHub advertised (TOCTOU
   close). If `--trust <sha>` was passed, it must equal that exact SHA too — no prefixes.
5. Computes the tooling diff against the **merge-base** of head and base (not the base tip; stale PRs are not
   refused for base-side churn). Refuses if any tooling file differs from the merge-base unless
   `--trust <sha>` is given. Prints the tooling diff either way.
6. Materializes a safe worktree under `.revkit/review/<owner>-<repo>-<pr>/head-<sha>/`: tooling files
   (everything not on the [content allowlist](../packages/cli/src/review/content-allowlist.ts)) come from the
   reviewer's trusted merge-base tree; content files (docs, vocab, plots, Starlight collections, allowlisted
   extensions only) come from the PR head. Symlinks that escape the content root, submodules, and other
   unsupported tree modes are refused. Per-blob size checked via `cat-file -s` BEFORE reading; total-size
   cap enforced. `git checkout` is never invoked, so smudge filters never run.
7. Runs `revkit check` over the materialized content in **untrusted mode**: allow-annotations are ignored
   (a PR cannot silence its own findings), and vega-lite executable keys (`expr`/`signal`/`calculate`/
   `update`/`on`) are refused.
8. Runs the astro build with a **minimal env** (no `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`,
   `HF_TOKEN`, `CF_API_TOKEN`, cloud provider keys — see `build.ts:BUILD_ENV_TOKEN_DENYLIST`) inside the
   materialised worktree. Node module resolution is pinned to the reviewer's TRUSTED `node_modules/` (no
   `bun install` inside the sandbox, so PR-controlled lifecycle scripts never run).
9. Runs `revkit check-dist` on the built output before serving it (ADR-0012 output-gate sanitiser).
10. Imports the PR's existing review threads through the adapter into the daemon's thread store, which lives
    at `.revkit/review/<owner>-<repo>-<pr>/state/threads.sqlite` — **outside** the materialised head
    directory, so a rerun that wipes `head-<sha>/` preserves comments.
11. Starts a per-review `revkit serve` daemon pointing at the built dist. ADR-0013's auth/CSP stays exactly
    as it is; only the served directory and the sqlite path change.

## Flags

- `--trust <sha>`: trust that exact head SHA. Must be the **full 40-character** commit id (no prefix). Required
  for any fork PR or any PR whose tooling files differ from the merge-base. The command prints the tooling
  diff so the reviewer sees what they are trusting.
- `--no-serve`: prepare the review (materialize + import) without starting the daemon.
- `--repo <owner/slug>`: override the default repo when passing a bare PR number.

## Content allowlist

The safe-build materializer treats a path as CONTENT only if:

- it lives under `docs/`, `vocab/`, `plots/` or `site/src/content/`, AND
- its extension is one of `.md`, `.mdx`, `.json`, `.yaml`, `.yml`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`,
  `.gif`, `.avif`.

Everything else — `package.json`, lockfiles, `flake.nix`, `.github/`, `.gitattributes`, `.githooks/`, any
`.js` / `.ts` / `.astro` / `.mjs`, `justfile*`, `astro.config.*` — is tooling. Adding a `.js` inside `docs/`
does not smuggle it in: it fails the extension check and the materializer takes it (or refuses it) from base.

The allowlist is a committed constant in `content-allowlist.ts`. Widening it needs an ADR update.

## What is refused, with no `--trust`

- Fork PRs (head repo differs from base repo).
- Any PR that changes any tooling file vs base (a change to `package.json`, `flake.nix`, `.github/workflows/*`,
  `astro.config.*`, `.gitattributes`, a new `.js` file anywhere content is not allowed).
- Symlinks whose target escapes the content root (lexical check; `realpath` is not consulted, so a check-once
  race window is closed at build time).
- Submodules and other tree modes other than `100644` / `100755` / `120000` (symlink).
- Materialization above the 512 MiB total-size cap.

## Examples

```sh
# Same-repo, content-only PR — no --trust needed.
revkit review 42

# A fork PR — refused, prints how to trust it after review.
revkit review https://github.com/vig-os/revkit/pull/100
# → refusal, then:
revkit review 100 --trust <that sha>

# A PR that changes package.json — refused with a printed tooling diff.
revkit review 200

# Same PR, with --trust — tooling comes from base, content from head.
revkit review 200 --trust <that sha>

# Prepare a review without starting the daemon (CI, agent).
revkit review 42 --no-serve
```

## Security boundary

The remaining boundary is **"no PR code executes"**. `revkit review` enforces this by:

- refusing every PR-controlled tooling change (default) and by rebuilding the whole tooling tree from the
  reviewer's TRUSTED base tip when `--trust <sha>` is passed;
- running `revkit check` in **untrusted mode** on the materialised content: no expressions, no non-static
  attributes, no allow-annotations, no ESM other than the exact `@revkit/components` / `@astrojs/starlight/components`
  root, and an **allowlist walk** of every vega-lite spec (no `filter`, `calculate`, `test`, `expr`, `signal`,
  `param`, `datum.` predicates, no `…Expr` key, no synthesising transforms);
- invoking the reviewer's OWN astro binary by absolute path (never `bun x astro`, no registry fetch, no
  `bun install`) with a scrubbed env (`HOME` and `TMPDIR` point at a per-build scratch dir; every token
  variable is dropped);
- running `revkit check-dist` on the build output before the daemon serves it (ADR-0012 output-gate
  sanitiser).

Beyond that boundary, an OS-level sandbox for the build (bwrap / nsjail with no network, read-only binds
of the trusted node_modules, a fresh cgroup for cpu/memory limits) is a plausible follow-up: it would turn
the "no PR code executes" invariant into a defence-in-depth even if a bug ever let an expression slip through
`revkit check`. Not filed here — see the PR body for the proposed issue text.

## Related

- [ADR-0025 — Hybrid review, one core](adr/0025-hybrid-review-one-core.md)
- [ADR-0013 — Local daemon security](adr/0013-local-daemon-security.md)
- [ADR-0012 — Hosted security threat model](adr/0012-hosted-security-threat-model.md) (CSP; the loopback
  daemon shares the CSP shape)
- [ADR-0006 — Comments, anchoring, event log](adr/0006-comments-anchoring-event-log.md) (the anchor model
  the imported threads land under)
- [ADR-0021 — Versioning and release](adr/0021-versioning-release.md) (why static plots refuse vega
  expressions)
