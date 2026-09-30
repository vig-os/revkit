# ADR-0025: Hybrid review — one core, local and hosted backends

- Status: Accepted
- Date: 2026-09-30
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: B1, B2, B3, B4, B5, B6, B7
- Amends: [ADR-0009](0009-auth-github-app-invite-links.md)

## Context

A GitHub PR is a commit plus comments. Almost everything ADR-0008/0009/0012/0014 wire up — build the PR head, render
it, comment on file+line, submit the review — can happen against the reviewer's own `gh` credentials, on
`127.0.0.1`, with no App and no Cloudflare. Under the current plan (DESIGN-0001 §5.6/§6, M3 in §8), the *only* way to
review a PR in revkit is through the hosted preview, so nobody can review a PR at all until the Worker, the App and
the deploy pipeline (M4 in the current cut) are up. That is a large human gate — org-owner approvals, an org-config
PR for the upload secret, Cloudflare OAuth, App manifest confirm — in front of what is otherwise the loudest
dogfooding surface revkit has: reviewing revkit's own PRs.

The local daemon that M2 builds already owns the anchor model (ADR-0006), the comment rail and the agent channel
(ADR-0007). All that separates it from a PR review is a GitHub adapter and a way to build a PR head safely.

## Decision

**One review core, three surfaces.**

A shared package, `@revkit/review-core`, holds:

- the thread model (ADR-0006), with the source-range + text-quote dual anchor and the re-anchoring pipeline;
- the block-anchor → `(path, line/start_line, side=RIGHT)` mapping;
- the **file-level fallback** for comments whose block lies outside the PR's diff hunks (`subject_type: file`,
  carrying the quote), per DESIGN-0001 §5.6;
- a **GitHub adapter** written against plain `fetch` REST/GraphQL, no Node-only deps, so it runs unchanged in Bun and
  in a Cloudflare Worker. It takes a `TokenSource` interface and knows nothing about where the token came from.

The three surfaces:

- **(a) Local agent feedback** (M2 as planned). `revkit serve`, `bun:sqlite` threads, the channel to the agent.
- **(b) Local PR review, self-hosted.** `revkit review <pr-number|url>` fetches the PR head into a worktree under
  `.revkit/`, builds the site there, serves it on loopback (ADR-0013: random port, launch code, HttpOnly cookie),
  imports the PR's existing review threads through the adapter and maps them to blocks. Comments accumulate in the
  reviewer's **pending review, as the reviewer**, using their own `gh` credentials; the page submits
  COMMENT / APPROVE / REQUEST_CHANGES. The agent sees the same threads through the M2 channel. No GitHub App, no
  Cloudflare, no repo secrets, no per-org setup.
- **(c) Hosted and shareable** (Worker/R2/D1, App user-to-server tokens, invite links for guests) for what genuinely
  needs a public URL: reviewers without a local checkout, guests. Same core; `TokenSource` = the App; store = D1.
  `revkit threads export|import` bridges local ↔ hosted so a local review can be published, or a hosted review
  continued locally.

**TokenSource for the local surface.** The daemon reads the reviewer's token with `gh auth token` at use time, holds
it in memory, and never sends it to the browser and never writes it to disk or logs (ADR-0013, ADR-0014). This
reuses the reviewer's existing `gh` auth: no per-repo setup and no shared secret. The trade is that a
personal-access token is broader than the App's scoped user-to-server token — it acts as the reviewer's full
identity on their own behalf — and revkit accepts that trade for the zero-setup local surface. Hosted keeps the App.

**Untrusted PR content (must be explicit).** Building a PR head must never execute PR-controlled code:

- The build uses the **reviewer's trusted revkit toolchain and config from the base branch** (or the installed
  revkit); it takes only *content* from the PR head — `docs/`, `vocab/`, `plots/`, data files, MDX.
- The PR's own `package.json` scripts, `astro.config.*`, flake changes, prek/hook changes and dependency lockfile
  changes are **not run** and **not sourced**. `revkit check` runs on the PR content before the build (ADR-0005).
- **Fork PRs, or any PR whose tooling files differ from the base**, are refused unless the reviewer passes
  `--trust`, which trusts *that specific head SHA only* and prints what changed. This is the same posture as
  ADR-0012's "untrusted island props" and ADR-0014's `preview-fork` approval, moved to the local surface.

**Head moves.** A pending review is pinned to the `commit_id` it was opened against. If the PR head moves before the
reviewer submits, the page says so and re-anchors pending comments to the new head through the ADR-0006 pipeline
(map → verify quote → fuzzy → orphan; never guess). GitHub itself marks *submitted* comments outdated when their
positions no longer resolve, so both sides converge on the same outcome.

## Milestone re-cut

The current M3 conflates the review surface with the hosted stack, which is why nothing about PR review ships until
Cloudflare is up. Split them:

- **M3 — Local PR review** (new). `revkit review <pr>`, `@revkit/review-core`, the `gh` `TokenSource`, the safe PR
  build, existing-thread import, comment / pending review / submit against GitHub. No App, no Cloudflare, no human
  gate. Dogfoodable on revkit's own PRs the day it lands.
- **M4 — Hosting, deploy, hosted review, guests**. The old M3's hosted pieces (CI preview deploy + PR-comment link,
  App, two-way hosted threads) join the Worker, D1, R2, `revkit deploy init` and invite links here — one milestone
  for the entire human-gated hosted train (org-owner approvals, Cloudflare OAuth, App manifest, org-config PR).
- M8 code diffs (ADR-0024) still builds on the same core; both surfaces get them.

The other milestones renumber only if the owner wants them to; the split above is the change that matters.

## Alternatives considered

- **Hosted-only (the current plan).** Correct end state, wrong first step: it puts every PR review behind an
  org-scale setup, and revkit can't review its own PRs until that setup lands.
- **Local-only.** Skips the App and the Worker, but then there is no shareable link and no non-GitHub reviewer;
  loses B5 outright and half of B1.
- **`revkit serve --share` over a tunnel** (Cloudflare Tunnel / ngrok). The laptop must stay up, and it exposes the
  local daemon — however narrowly — to the internet. Rejected for v1. If a "quick share" ever earns its place it
  belongs behind an explicit `--share` flag with a printed audit line, not as a default.

## Consequences

- **ADR-0009 is amended, not superseded.** The App is the hosted-surface `TokenSource`; the local surface uses `gh`.
  0009 is annotated with a pointer to this ADR; its status stays Accepted.
- **DESIGN-0001 updates** in the same PR: §5.6 gains a second diagram for the local sequence (reviewer → local
  daemon → GitHub API via `gh` token); §6 mentions the local surface alongside the hosted one; §8 milestones are
  re-cut as above.
- **Feature matrix** updates: B-stories cite ADR-0025; each B-story maps to M3 (local) or M4 (hosted) as
  appropriate; a story is added for "review a PR locally with my own `gh` identity" if none of B1–B6 already covers
  it.
- **The GitHub adapter must run in both runtimes** — Bun and a Cloudflare Worker. No `node:*` imports, no
  `@octokit/*` transitive Node deps; plain `fetch` against the REST and GraphQL endpoints. This is a constraint on
  M3's implementation.
- Milestone tracking issues (#8, #9) and their descriptions are **not edited by this PR**. Acceptance of this ADR
  triggers those edits as a follow-up; the PR body lists them.

## Acceptance (2026-09-30)

- Accepted by the owner; M3 re-cut to **Local PR review** (`revkit review <pr>` on loopback via the reviewer's own
  `gh` identity, with the safe PR-head build, `@revkit/review-core` and existing-thread import), and the previously
  M3 hosted parts (CI preview deploy + PR-comment link, GitHub App, two-way hosted threads) moved to M4 alongside
  the Worker, `revkit deploy` and invite links.
- `@revkit/review-core` is the shared package; its GitHub adapter targets **plain `fetch`** REST/GraphQL with no
  `node:*` or Node-only transitive deps, so the same code runs in Bun (local) and in the Cloudflare Worker
  (hosted).
- The local `TokenSource` reads `gh auth token` at use time, holds it **in process memory only**, and never sends it
  to the browser or writes it to disk or logs (ADR-0013, ADR-0014).
- Fork PRs, or any PR whose tooling files (flake inputs, `package.json` scripts, `astro.config.*`, prek/hook
  configuration, lockfile) differ from the base, are **refused unless the reviewer passes `--trust`**; `--trust`
  binds to the exact head SHA and prints the tooling diff before proceeding.

## Amendment (PR-43 round-5)

- **LEFT-side thread import uses the merge-base**, not `originalCommit^`. GitHub's LEFT side on the full PR diff is
  the merge-base of the PR base and the commit the comment was made against — verified live-read-only against
  TypeScript#64381 (`Herebyfile.mjs:1233`) and TypeScript#64408 (`SKILL.md:16`). The adapter resolves the merge-base
  via REST `GET /repos/{o}/{r}/compare/{baseRef}...{originalCommit}` (`merge_base_commit.sha`), caches it per
  originalCommitOid, then fetches `<mergeBase>:<oldPath>`. It falls back to `<originalCommit>^:<oldPath>` on
  diffHunk mismatch (correct in single-commit view), and marks the thread `unavailable, reason: diffhunk-mismatch`
  when neither matches. Every fetched blob is verified against the comment's `diffHunk` (last stripped side-line
  must equal the file's `originalLine` content) before it is trusted.
- **Imported threads whose source content is unavailable** (blob not-found / binary / truncated / diffHunk-mismatch)
  use the new **unanchored anchor kind** on `comment.created` (see ADR-0006 amendment). The reducer parks the
  thread in `orphaned` from birth; the rail / re-anchor engine never load a snapshot for it. Resolved-on-GitHub
  metadata rides on a structured `external: { provider: "github", threadId, resolved, resolvedByLogin? }` field
  on the same event, so B4 two-way sync can reconcile the LOCAL orphan status with the REMOTE resolved status
  without regex-parsing prose. When B4 lands (M4), the reconciliation rule is:
  - GitHub resolves a locally-orphaned thread → the local UI shows "resolved on GitHub (originally imported
    unanchored)"; the thread stays orphaned on the local anchor axis.
  - The local reviewer explicitly re-anchors an orphaned imported thread → the LOCAL anchor gets a line-anchored
    revision; the `external.resolved` bit is preserved as historical metadata.
