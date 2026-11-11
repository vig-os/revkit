# ADR-0025: Hybrid review — one core, local and hosted backends

- Status: Accepted
- Date: 2026-09-30
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: B1, B2, B3, B4, B5, B6, B7
- Amends: [ADR-0009](0009-auth-github-app-invite-links.md)
- Amended by: the 2026-10-05 (issue #70) amendment below — on the LOCAL surface,
  an agent-authored reply / resolve reaches GitHub only through an explicit
  reviewer promotion, so it is a human act like every other GitHub write. The
  subject of that claim is the agent BEARER, not the agent as a process: a
  same-user agent holding a reviewer session is out of the model (see #55).

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

## Amendment (2026-10-03, issue #9) — the header/CSP policy is part of the shared core

**The gap this closes.** "One review core" above names three things the shared
package holds: the thread model, the anchor→PR-line mapping, and the GitHub
adapter. It does not say where **response-header and Content-Security-Policy
policy** lives, and by omission the answer was "in each surface". That is
tolerable for two surfaces and untenable for three, because ADR-0012's policy is
security-relevant: a `script-src` that is tightened on the daemon and forgotten on
the Worker is not a code smell, it is the bug this ADR exists to prevent.

**Decision.** Response-header and CSP policy is **part of the shared core**, in
`packages/review-core/src/http-headers.ts` (`@revkit/review-core/http-headers`).
Every surface supplies coordinates and inherits the policy:

| Surface | Module | Supplies |
|---|---|---|
| Local daemon | `packages/cli/src/serve/headers.ts` | loopback origins; `/-/rail.js`, `/_astro/`, `/pagefind/` |
| Hosted Worker | `packages/worker/src/headers.ts` | the request's own origin; `/_revkit/<version>/` |
| any future surface | its own adapter | its own origin and paths |

What is **shared**: the directive set (`default-src 'none'`, `script-src`,
`style-src`, `img-src`, `font-src`, `connect-src`, `worker-src`,
`frame-ancestors`, `base-uri`, `form-action`, `object-src`); the hygiene quartet
(`nosniff`, `Referrer-Policy: no-referrer`, `COOP`, `CORP`) plus
`Permissions-Policy`; the `asset`-gets-no-CSP rule and the per-kind `Cache-Control`
mapping; and the hex→base64 conversion a CSP hash source needs.

What is **per surface**: which origin, and which paths. Those are the two things
ADR-0012 itself draws differently per origin — `script-src` names loopback paths on
the daemon (ADR-0013's documented exception) and `/_revkit/<version>/` on the
hosted origin — so making them configuration rather than code is not a
generalisation, it is the shape the ADR already had.

**This is consistent with "one core, three surfaces", not an extension of it.** The
alternative readings were both rejected:

- **Copy it per surface.** The `duplication` guardrails gate fires, and more to the
  point it creates the second and third implementations of one security policy.
- **Import `@revkit/cli/serve/headers` from the Worker.** Functionally correct and
  cheap to write, but it would pull the whole CLI — `bun:sqlite`, the MCP SDK,
  Astro remark plugins — into the Worker bundle to reach 346 lines of pure
  functions. ADR-0025's whole premise is that the Worker imports the CORE.

**One consequence the move forced, and it is load-bearing.**
`hexToBase64` previously used `Buffer.from(hex, "hex")`. It no longer can: measured
on workerd 2026-05-18 with `compatibility_flags: []`, `typeof Buffer`,
`typeof process` and `typeof require` are all `"undefined"`. The replacement is a
hand-written encoder, differentially tested against `Buffer` over every digest
length from 1 to 64 bytes, over both hex cases, and over every digest in the
committed release allowlist — so "hand-written" cannot quietly mean "different".
That test lives in review-core because the daemon runs in Bun, where `Buffer`
exists, and can therefore still check against it.

**What did NOT change.** The daemon's emitted CSP is byte-for-byte what it was:
`buildCspHeader`'s output order is preserved by the adapter flattening
`(rail, extras, astro, pagefind)` into one ordered `scriptPaths` list, and the
existing BYTE-EXACT test in `packages/cli/test/serve/headers.test.ts` was not
edited. The daemon's public module surface is unchanged too, so `daemon.ts` and its
tests are untouched.

## Amendment (2026-10-05, issue #70) — the local surface promotes agent drafts through a reviewer session, never the bearer

**"Comments accumulate in the pending review, as the reviewer"** (Decision,
surface (b)) is unchanged for everything the reviewer authors. This amendment
states what happens when the **agent** authors something, which the Decision
left open.

**An agent's reply or resolve is a local draft until a reviewer promotes it.**
The rail badges it "agent draft · not on GitHub" and offers one action,
**Promote to my review**, which calls `POST /api/review/promote`. That route is
**cookie-only**, in the same class as `submit` / `discard` / `refresh` /
`reanchor` / `reconcile`: the agent bearer receives `403 agent-forbidden`, and a
non-`local` actor a bare `403`. The promotion appends `draft.promoted` to the
intent log **before** any adapter call and then replays the ordinary reconcilers,
so the write that reaches GitHub is indistinguishable from one the reviewer
triggered by hand — same pending review, same viewer identity, same
`comment.linked` completion.

**This preserves the property PR #59 established, rather than relaxing it.** That
PR made every GitHub mutation cookie-only because a human's review must be
authored by the human. Promotion keeps that exactly: the agent can still author
content locally through the M2 channel (that is how B6's "agent replies, fixes,
resolves" works at all), and a human decides whether it becomes part of their
review. What changed is that the decision is now *possible*, and it is recorded
as an event whose only permitted author is the reviewer — see the ADR-0006
amendment for the log-level trust rules.

**What that property is, precisely.** *The agent bearer is refused the promote
route, and an agent-authored item reaches GitHub only via a `draft.promoted`
recorded by a cookie session.* It is a statement about the bearer and the HTTP
surface. It is **not** a statement that the agent as a process has no route to a
write: on the local surface a same-user agent can mint a launch code
(`POST /-/launch-code`) and exchange it for the reviewer's session cookie
(`GET /-/auth?code=…`), and that session is `local` like any other, so it can
promote. That is a pre-existing property of the local surface (since PR #38),
not something this amendment introduces or settles, and it is owned as a decision
on **#55**. Promotion makes a reviewer's session load-bearing for B6, so this
amendment records the limit of the claim rather than leaving it implicit.

**A refusal writes nothing, and a superseded promotion does not fire.** Every
refusal the route can return is decided before the log's first append, so a
refused promotion leaves the draft exactly where it was — still badged, still
promotable, retryable. A promotion authorizes a lifecycle change only while that
change is the thread's current one: if the agent reopens a thread whose resolve
the reviewer had promoted, the promotion is superseded, the route refuses the
stale target, and no reconcile resolves it. The rule is one derivation in
`@revkit/review-core` (`reduceThreadLifecycleStates`) read by the rail's draft
list, the route and the reconciler alike, and it is enforced in the log's
validator too — the writer is not allowed a different answer than the UI.

**The reviewer is told when their own resolve is superseded.** An agent's later
change retires a reviewer's outstanding resolve or reopen before it reaches GitHub
(above). The reconciler correctly refuses to fire it, and the rail says so — naming
the thread — rather than leaving the reviewer to believe their click posted. This is
a notice, not a prompt: nothing is stuck and nothing needs a decision.

**Promotion pins the text it approves.** The event records the promoted comment's
authoring `seq` and the SHA-256 of its body at promotion time, and a comment whose
body no longer matches is refused rather than published — so a future edit route
cannot swap the text between the reviewer's click and the write.

**A superseded change supersedes the reviewer's own intent too.** The rule is "the
thread's current lifecycle change acts, whoever authored it". Before this amendment
existed, a reviewer's own unresolved resolve survived an agent's later reopen and was
then fired, leaving GitHub resolved and the log `open`. Both orders are now pinned.

**Promotion needs an open pending review.** The route refuses
(`no-open-pending-review`) when the log's pending review is submitted or
abandoned. This is deliberate: after a submit or a discard, the reviewer's
decision was "this does not go out as drafted", and re-opening it silently on an
agent's behalf would contradict that. The reviewer comments first (which opens a
fresh pending review) and then promotes.

**Not in this amendment.** The **hosted** surface (c) is untouched: no hosted
promotion route, no Worker change, no App change. A hosted agent draft stays a
hosted draft until that surface designs the same act — and because
`reduceReviewState`'s `agentDrafts` is a derivation over the shared core, the
hosted surface gets the same *view* of the draft list for free if it wants it.
Refs: #70, #59, #8


## Amendment (2026-10-08, issue #136): promotion recovery preserves review identity

The local promotion route records the pending review's GitHub node id in
`draft.promoted.reviewNodeId`. Both route retries and boot intent recovery use the
same guard: the recorded review must still be the open pending review. A newer
review cannot inherit an incomplete promotion from a submitted, discarded, or
head-move-abandoned review. The route returns HTTP 409 with
`promotion-review-mismatch`; recovery skips and logs it.

Historical promotions without a review binding still load, but cannot be retried
or healed (`promotion-review-unbound`). ADR-0006's issue #136 amendment defines
the backward-compatible schema and validator rule. Boot recovery remains a local
append followed by read-only remote reconciliation. The hosted promotion surface
remains outside this amendment.

Refs: #136, #123, #70


### Round 1 (issue #136): destination enforcement and explicit recovery

Promoted comments and replies are posted only into the bound review, enforced at
the destination by reconciliation. Machine intents resolve their authorization
from the promotion preceding them in the event log. Terminal, mismatched, and
missing bindings record a typed sync failure and cause no comment/reply post,
including when another client submitted the review before boot or during a
promotion request. Reviewer-authored intents still post normally.

Boot healing retains its ordering before remote reconciliation; the destination
check is the guarantee. Recovery in the rail requires a fresh reviewer action
naming the current review. The route records a new promotion and intent for that
review, and boot can heal a missing new intent even if the previous review's
intent remains in the log. Ordinary reconciliation never rebinds a promotion.
ADR-0006's round-one addition specifies the error vocabulary and request shape.

Refs: #136, #148


## Amendment (issue #155): review-bound lifecycle promotion replay

The review binding for promoted agent actions also governs immediate GitHub
resolve/unresolve operations. The daemon uses the shared promotion provenance
module and observes the bound review's remote state immediately before mutation
or completion healing. It must be the current review and remotely `PENDING`.
A missing, terminal, or different binding records a typed `thread.sync_failed`
with the vocabulary specified in ADR-0006's #155 amendment and causes no lifecycle
mutation or completion. Legacy unbound promotions are refused across restart.
Reviewer-authored lifecycle intents remain independent and continue in the same
reconciliation pass.

The rail projects durable refusals and requires a fresh "Promote to this review"
click naming the current review before retrying an agent action in another review.
A new bound promotion replaces authorization for the current lifecycle change;
ordinary reconcile cannot supply that approval. The shared lifecycle reducer
continues to govern supersession and intent-correlated completions.

Refs: #155, #136, #148

Lifecycle promotions are checked immediately before each write; a submit landing
between the check and the write is detected and logged, not prevented. GitHub
cannot condition resolve/unresolve on the review remaining pending. A post-write
review read detects a terminal transition and records a structured warning naming
the thread, intent, and review; `thread.external_synced` still records the accepted
mutation. There is no automatic reversal. Read failures after acceptance warn
without losing the completion. ADR-0006's #155 addition also specifies unchanged
failure deduplication (#154), per-pass refusal caching, and sync-outcome actor
restrictions that preserve GitHub imports.

Refs: #155, #154, #151
