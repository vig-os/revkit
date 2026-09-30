# `revkit review <pr>` — usage

Local PR review, on loopback, with the reviewer's own `gh` identity. No App, no Cloudflare, no repo secrets
(ADR-0025).

## What it does

Given a PR number or URL, `revkit review`:

1. Resolves the PR through the GitHub adapter using the reviewer's `gh auth token` (in memory only — never
   written to disk, never sent to the browser).
2. Fetches the PR head and base commits into the local git object DB through a hardened `git` wrapper
   (no hooks, no submodules, no filter/smudge drivers, no `protocol.file`, no `protocol.ext`).
3. Refuses the review unless every non-content path is unchanged, or the reviewer passed `--trust <sha>` that
   pins to the exact head SHA. Fork PRs are refused without `--trust` too.
4. Materializes a safe worktree under `.revkit/review/<pr>-<sha>/`: tooling files (everything not on the
   [content allowlist](../packages/cli/src/review/content-allowlist.ts)) come from the reviewer's trusted
   base; content files (docs, vocab, plots, Starlight collections, allowlisted extensions only) come from
   the PR head. Symlinks that escape the content root, submodules, and other unsupported tree modes are
   refused. `git checkout` is never invoked, so smudge filters never run.
5. Runs `revkit check` over the materialized content.
6. Imports the PR's existing review threads through the adapter into the daemon's thread store (deterministic
   ids, so a re-run of `revkit review` on the same head is idempotent).
7. Starts a per-review `revkit serve` daemon pointing at `.revkit/review/<pr>-<sha>/site/dist`. ADR-0013's
   auth/CSP stays exactly as it is; only the served directory and the sqlite path change.

## Flags

- `--trust <sha>`: trust that exact head SHA. Required for any fork PR or any PR whose tooling files differ
  from base. The command prints the tooling diff so the reviewer sees what they are trusting.
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

## Related

- [ADR-0025 — Hybrid review, one core](adr/0025-hybrid-review-one-core.md)
- [ADR-0013 — Local daemon security](adr/0013-local-daemon-security.md)
- [ADR-0012 — Hosted security threat model](adr/0012-hosted-security-threat-model.md) (CSP; the loopback
  daemon shares the CSP shape)
- [ADR-0006 — Comments, anchoring, event log](adr/0006-comments-anchoring-event-log.md) (the anchor model
  the imported threads land under)
