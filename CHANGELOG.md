# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

## [0.1.0] - TBD

### Added

- **Deployment targets and pluggable auth** ([#195](https://github.com/vig-os/revkit/issues/195), [#192](https://github.com/vig-os/revkit/issues/192))
  - ADR-0026 decides four targets (local, private VPN, plain Linux host/VM, Cloudflare) and a minimal auth-provider
    interface (none, trusted-proxy headers, per-site tokens, Cloudflare Access).
  - It amends ADR-0008 and ADR-0013 and supersedes parts of ADR-0009; stories D3–D5 are `planned` in the feature matrix.
- **The hosted kernel** ([#9](https://github.com/vig-os/revkit/issues/9))
  - `@revkit/worker` is a real Cloudflare Worker that boots on workerd with
    `compatibility_flags: []`, so ADR-0025's "same core in a Worker" is enforced
    by the platform rather than by a lint: workerd has no `Buffer`, `process`
    or `require` to fall back on.
  - `D1ThreadStore` is the hosted `ThreadStore` (ADR-0006), a port of the
    daemon store's shape rather than its code — `bun:sqlite` is absent from
    workerd and D1 refuses `BEGIN IMMEDIATE`. The head read, the catch-up read
    and the insert are ONE `db.batch([...])`, which is the measured condition
    for not colliding.
  - One store conformance suite runs against all THREE `ThreadStore`
    implementations — `InMemoryThreadStore`, the daemon's `SqliteThreadStore`
    and this package's `D1ThreadStore` — with no skip mechanism to reach for.
  - `migrations/0001_init.sql` is the hosted schema: the event log plus
    `snapshots`, and `guests` / `invites` / `sessions` with ADR-0015's and
    ADR-0009's constraints enforced by the database. No purge yet.
  - A structured JSON logger with a request id per request (ADR-0020) and a
    bounded redactor (ADR-0015): the message must be one of five event names, so
    a comment body cannot be logged at all; sensitive-named fields are replaced;
    and credential- and email-shaped strings are dropped wherever they appear.
    Free-form prose under an unrecognised key is NOT detected, so the caller rule
    "never pass review content as a log field" is the actual control and the
    redactor is the backstop.
  - `/api/threads` deliberately answers **501 for every verb**: ADR-0012 requires
    authorization on every request and this slice has no session, so neither the
    read nor the write is reachable over HTTP. The read is the larger exposure —
    an open GET needs no CSRF bypass and returns comment bodies. Read and append
    are proven through the store suites instead. (Slice 2 opens the read behind
    the gate below.)

- **Sessions, CSRF, and ADR-0012's per-request authorization gate**
  ([#9](https://github.com/vig-os/revkit/issues/9),
  [ADR-0012](docs/adr/0012-hosted-security-threat-model.md))
  - `GET /api/threads` and `GET /api/threads?since=<n>` are **open**, behind one
    gate every route but `/healthz` passes through. `POST /api/threads` stays
    **501**; its hosted write shape is a later slice, and it now reaches that
    answer only after the gate and the CSRF check have both passed.
  - A session is a 256-bit `crypto.getRandomValues` value in an
    `HttpOnly; Secure; SameSite=Lax; Path=/` cookie named
    `__Host-revkit_session`, resolved per request by `sha256(cookie)` against
    `sessions.id`. **Neither the session id nor the CSRF token is recoverable
    from the database** — both are stored as digests — and expiry is enforced
    on every read, with an unparsable `expires_at` failing closed.
  - Every state-changing call needs `x-revkit-csrf`, satisfied only by that
    session's own token, and declares `application/json`. `POST
    /api/session/refresh` is the one state-changing route this slice opens, so
    both rules have a reachable path to be load-bearing on; it rotates the id
    and the token in one atomic D1 batch.
  - An `identity_kind` the gate does not recognise is **refused**, not defaulted
    to allowed, and a session is issued out of band by whoever holds D1 write
    access (`revkit deploy init`) — there is deliberately no
    `POST /api/session`. Slice 3's invite redemption is the first way a session
    reaches a person.
  - **Not** implemented, and recorded in the ADR-0012 amendment: ADR-0012's
    *scope* clause. No `TokenSource`, no invite, and `events` has no `repo`
    column, so a valid session currently receives the whole log.

### Changed

- **Response-header and CSP policy is now shared, not per surface**
  ([#9](https://github.com/vig-os/revkit/issues/9),
  [ADR-0025](docs/adr/0025-hybrid-review-one-core.md))
  - `packages/cli/src/serve/headers.ts` was pure and had zero imports, which
    is what made it shareable. It moves to `@revkit/review-core/http-headers`
    and both the local daemon and the hosted Worker import it; each keeps a
    thin adapter supplying its own origin and script paths.
  - One consequence was forced: `hexToBase64` used `Buffer.from(hex, "hex")`,
    and `Buffer` does not exist in workerd without `nodejs_compat`. It is now
    hand-written and differentially tested against `Buffer`, so it cannot
    quietly produce a different digest.
  - The daemon's emitted CSP is byte-for-byte unchanged; its existing
    BYTE-EXACT test was not edited.

### Fixed

- **MCP cold-start no longer spawns duplicate daemons during a slow auto-build**
  ([#251](https://github.com/vig-os/revkit/issues/251),
  [#212](https://github.com/vig-os/revkit/issues/212))
  - `revkit serve` now takes `.revkit/daemon.lock` BEFORE the cold-start
    auto-build (`packages/cli/src/serve/cli.ts`). While the build runs,
    `.revkit/serve.json` carries a `status: "starting"` record with the
    daemon's pid and placeholder url/token. A concurrent `revkit mcp`'s
    `ensureDaemon` sees the "starting" state and waits on the readiness
    transition — it never spawns a second daemon that races into the
    same `.revkit/dist`. Pre-fix, `ensureDaemon`'s 10-second wait would
    time out during a cold build and every tool-call retry spawned
    another `revkit serve`.
  - `ensureDaemon` detects a daemon that dies while starting PROMPTLY:
    the OS releases `daemon.lock` on process exit, the next poll sees
    the lock free, and the caller gets a `died while starting (pid N)`
    error without burning the rest of the deadline. A daemon that stays
    "starting" past its deadline surfaces as a clear
    `building, N s elapsed` diagnostic the agent can retry.
  - `revkit mcp` answers `initialize` immediately — it no longer calls
    `ensureDaemon` synchronously before `server.connect(transport)`.
    Daemon bootstrap runs through the channel server's existing reconnect
    path on the first tool call, so the client's `initialize` round-trip
    stays well under a second even when the daemon cannot start.
  - Legacy callers (`revkit events`, `revkit open`, `revkit hook`) keep
    their pre-#251 "ready-only" view through `findRunningDaemon`; MCP
    uses a new `findRunningOrStartingDaemon` that also returns a
    "starting" daemon. `acquireAndPublish` is unchanged for programmatic
    callers.
  - **SIGKILL safety through output staging, not fd inheritance (round
    3).** The cold auto-build writes to a private
    `.revkit/dist.staging-<pid>-<nonce>/` directory which the holding
    `revkit serve` atomically renames to `.revkit/dist` after
    `check-dist` passes. If the parent is SIGKILLed mid-build, the
    orphaned astro child writes only its own staging dir — never
    promoted — and the next `revkit serve` sweeps stale staging dirs
    whose pid is dead (`cleanupOrphanedStagingDirs`). The earlier
    round-2 attempt handed the daemon-lock fd to the astro child via
    `Bun.spawn`'s `stdio` to keep the flock alive on a parent SIGKILL;
    Bun closes stdio fds on Subprocess garbage collection, so a GC
    during serve would then drop the serving daemon's OWN lock fd and
    a second `revkit serve` could bind on the same repo
    (reproduced). The lock is now always CLOEXEC; mutual exclusion is
    the kernel flock, and the build race is closed through atomic
    output promotion. SIGTERM / SIGINT still abort the build via an
    AbortController threaded into `spawnAstroBuild`, and the default
    spawner kills the astro child's whole process group so nested
    vite / node sub-processes die with it.
  - **Building diagnostic is prompt and accurate.** The per-tool-call
    `discover` now calls `ensureDaemon` with
    `onStartingDaemon: "diagnose"`: a live "starting" record throws
    `DaemonBuildingError` immediately with elapsed computed from the
    record's `startedAt` (not the waiter's start). The channel
    server's tool-call catch passes the message through unwrapped,
    so the agent reads "daemon is building (cold-start auto-build,
    pid X, N s elapsed since YYYY-…)" well inside the tool-call
    deadline — ending the 10 s race that gave 30 of 36 calls the
    generic "reconnect did not complete" error in a 3-minute build.
    The pid is omitted from the diagnostic when the recorded serve
    process is dead, so a mid-race read never points the agent at a
    vanished pid.
  - **Build failure reaches the MCP caller through an input-aware
    record (round 3, widened in round 4).** `revkit serve`
    persists `.revkit/start-failed.json` ONLY for a genuine build
    or check-dist failure — never for lock contention, a SIGTERM /
    SIGINT abort, or a bind-time race. Round 4 widens the input
    fingerprint to the WHOLE repo-root file listing: SHA-256 over
    the paths returned by `git ls-files -co --exclude-standard`
    (tracked + untracked-not-ignored) in a git working tree, or a
    fallback filesystem walk that skips `.revkit/`, `node_modules/`,
    `.git/` and common dist/cache dirs otherwise. For each listed
    file the hash mixes repo-relative POSIX path + size +
    integer-millisecond mtime; revkit's own CLI version is also
    mixed in so a CLI upgrade invalidates every prior record (#251
    round 4 test 4), and `package.json` is always-mixed as
    belt-and-braces. See `packages/cli/src/serve/input-fingerprint.ts`,
    `FINGERPRINT_WALK_SKIP` / `FINGERPRINT_CONFIG_FILES`.
    `ensureDaemon` refuses to respawn only while the current
    fingerprint matches the recorded one; any edit anywhere in the
    tree, a successful `revkit check`, a successful `revkit build`,
    or a successful `revkit serve` bind clears or invalidates the
    record. Pre-round-4, the hash only covered `docs/`, `vocab/`,
    `plots/` and `package.json`, so fixing or deleting a broken
    file outside those trees (e.g. `components/Widget.tsx` — refused
    by `revkit check`'s `no-hand-rolled-ui`) left the recorded hash
    unchanged and MCP kept suppressing. **The fingerprint is
    computed ONCE, BEFORE the build starts**, and carried through
    to the record (#251 round 4 BLOCKER 2) — a user fix saved
    mid-build is NEVER absorbed into the recorded hash. The pre-
    round-4 code recomputed after the failure, so a fix saved
    during the build matched the recorded hash on the next poll
    and MCP suppressed retries for a bug that was already fixed.
    **Known limit.** A same-size, same-mtime edit (`touch -r a b`
    style surgery, or a byte-identical overwrite restored to its
    prior mtime) is not detected — we hash metadata, not contents,
    because walking every byte of a consumer tree on every MCP
    `ensureDaemon` call is too expensive. The manual escape (`rm
    .revkit/start-failed.json`, `revkit serve` directly) is
    documented in `SKILL.md`. The round-2 shape also wrote
    `stage: "aborted"` on every SIGTERM, which then wedged MCP
    until the user removed the file by hand; that was resolved in
    round 3.
  - **Prompt SIGKILL escalation on a signalled cold build (#251
    round 4 BLOCKER 3).** Astro installs its own SIGTERM handler
    that runs an orderly-shutdown path; a real cold build observed
    it holding `.revkit/daemon.lock` for 131 s after `revkit
    serve` forwarded SIGTERM. The shared default spawner now
    sends SIGTERM to the astro child's whole process group and,
    if the group is still alive after `SIGKILL_GRACE_MS` (5 s
    named constant in `packages/cli/src/review/build.ts`),
    SIGKILLs the group. `revkit serve` therefore exits promptly on
    a user signal, releases the lock, and leaves `.revkit/dist`
    alone (the orphan's staging dir is never promoted); no start-
    failure record is planted for a signal abort.
  - **`revkit open` during a cold-start.** Now reports
    `a daemon is starting (cold-start auto-build, pid X, N s
    elapsed since …)` instead of the misleading "no daemon is
    running. Start one with `revkit serve` first" — which would
    only be refused by the still-held `.revkit/daemon.lock`. The
    pid is omitted from the message if the recorded serve process
    is dead (round 3 nit).
- **A page whose body fails to render fails the build**
  ([#237](https://github.com/vig-os/revkit/issues/237))
  - Astro's glob loader wraps every per-entry markdown render in a try/catch
    (`astro/dist/content/loaders/glob.js`): on failure it logs the error and
    stores the entry with `rendered: undefined`. Starlight then renders an
    empty `sl-markdown-content`, `revkit build` exits 0 and `check-dist`
    accepts the HTML — a review surface that silently ships empty pages,
    which is a release-grade defect class.
  - A new `guardedDocsLoader` wraps Starlight's docs loader in
    `site/src/content.config.ts` and, after every load pass, asserts every
    docs entry with a non-empty source body carries non-empty
    `rendered.html`. A violation throws from `load()`, which astro surfaces
    as a non-zero `revkit build` exit code; the error names the entry id and
    the source file, with astro's underlying render error in the lines
    above. Frontmatter-only docs (empty body) stay green, and entries
    marked `deferredRender` are skipped (they render later via a virtual
    module).
  - Defense in depth lives in `revkit check-dist`: when `revkit build` hands
    it the set of pages whose source bodies are non-empty, any page whose
    content root (`<div class="sl-markdown-content">`) is empty fails,
    naming the page. The empty-root check is backward-compatible — a
    standalone `revkit check-dist <dir>` without the source-body map keeps
    its pre-#237 behaviour.
- **`revkit build` launches Astro through the staged dependency graph** ([#238](https://github.com/vig-os/revkit/issues/238))
  - In the isolated (Bun workspace) layout, Astro ran from `site/node_modules/.bin/astro`, which Node resolves to
    its real path in Bun's store. With `NODE_PRESERVE_SYMLINKS=1`, packages reached from there walked up into Bun's
    shared fallback folder (`node_modules/.bun/node_modules`), which holds one version per name. Since
    `hast-util-raw` 9.2.0 (parse5 8) that loaded parse5 7, every Markdown body rendered empty.
  - Astro now starts from `<staging>/node_modules/astro` with `--preserve-symlinks-main`, so the CLI and every
    import resolve through `.revkit-deps` in both layouts. The hoisted (nix package) layout was never affected: its
    flat tree nests conflicting versions under their dependants.
  - A regression test stages a fixture whose fallback folder holds an incompatible version and asserts the staged
    one is rendered.
- **Worker tests derive their version from `wrangler.jsonc` instead of a
  hard-coded dev-placeholder literal** ([#231](https://github.com/vig-os/revkit/issues/231))
  - Seven Worker tests used to hand-write the dev placeholder in bundle paths
    and expectations, so `scripts/set-release-version.mjs` rewriting
    `vars.REVKIT_VERSION` on `release/X.Y.Z` turned the release PR's `Tests`
    job red: six headers cases asked for `/_revkit/<placeholder>/invite.js`
    against a Worker now serving `/_revkit/X.Y.Z/…`, and the runtime gate
    expected the unstamped placeholder in the `/healthz` body.
  - Every test under `packages/worker/test/` now derives the version from the
    single source (`wrangler.jsonc` `vars.REVKIT_VERSION`) through one
    semver-validated helper in `test/harness.ts` (`TEST_REVKIT_VERSION`); the
    existing per-file reads in `invites.test.ts` and `preview.test.ts` collapse
    onto it.
  - A regression guard in `test/worker-config.test.ts` fails on `dev` if any
    file under `packages/worker/test/` hand-writes the dev-placeholder
    literal again, so the next literal fails the branch every change touches
    rather than the release branch nobody rebuilds on green.
- **The changelog gate no longer breaks release branches** ([#228](https://github.com/vig-os/revkit/issues/228))
  - The commit hook checks structure only (no `###` heading repeated inside a `##` section) via
    `scripts/check-changelog-structure.mjs`; an empty `## Unreleased` is valid, as it is after the release freeze.
- **One version source, stamped by the release train** ([#201](https://github.com/vig-os/revkit/issues/201))
  - `revkit --version` and the flake package version both derive from `packages/cli/package.json`; the duplicate
    `VERSION` constant is gone and a test fails if a second literal appears.
  - The prepare-release seam stamps `X.Y.Z` into it on `release/X.Y.Z` (`scripts/set-release-version.mjs`), so
    candidates and finals carry the release version. `--version` also prints the build revision (`X.Y.Z (<rev>)`):
    a candidate reports its base `X.Y.Z` plus rev, a final exactly `X.Y.Z` (ADR-0021 amendment).
  - Stamping `-rcN` itself needs a devkit change: [vig-os/devkit#2070](https://github.com/vig-os/devkit/issues/2070).
  - The Worker's `REVKIT_VERSION` var is stamped by the same script, and the MCP server's version falls back to the
    CLI version instead of a hidden `"0.0.0"`; a test fails on any semver literal in package sources.
  - The template, README and installed SKILL.md pin `?ref=X.Y.Z` instead of floating on `dev`; the script stamps those
    pins on `release/X.Y.Z`, so candidates and the final carry the tag that exists after promotion. Before the final
    exists, pin a candidate tag or a commit SHA (ADR-0021 amendment).
  - `set-release-version.mjs` rewrites only the top-level `version` key and refuses a `--file` with no value.
- Packaged MCP auto-start reuses its executable without Bun on PATH; daemon
  startup errors keep MCP available. Templates and `revkit skill install`
  supply a project MCP registration with conflict checks and backups (#197, #198).
- A daemon that is down when MCP starts is primed on the first successful late
  connect (subscribe from head, one catch-up summary) instead of replaying from
  seq 0; the startup error no longer repeats the `revkit mcp:` prefix; an
  existing registration that only adds keys is accepted, and the registration
  installs without `--force` replacing an existing `SKILL.md` (#197, #198).
- MCP reconnect is single-flight: a tool call during a background reconnect awaits
  the same attempt, and attaching a subscriber closes any previous one, so live
  events are no longer delivered twice after a late daemon connect (#197, #198).

- **Raw-source comment provenance** ([#200](https://github.com/vig-os/revkit/issues/200)): full builds and request-time rendering preserve frontmatter source coordinates and stamp the published source revision, so comments on documents with code blocks are accepted (A2, ADR-0006).

- **Legacy quote recovery stays linear on deeply nested blocks and
  repetitive text**, and rebuilds yield between threads to keep the local
  review daemon responsive
  ([#161](https://github.com/vig-os/revkit/issues/161),
  [#162](https://github.com/vig-os/revkit/issues/162)).

- **Consumer `revkit build` now preserves transitive dependency resolution and
  conflicting versions with Bun’s isolated workspace install**
  ([#141](https://github.com/vig-os/revkit/issues/141)).

- **`ask-page` Playwright suite no longer fails 5 of 11 tests at CI's `workers: 1`** ([#74](https://github.com/vig-os/revkit/issues/74))
  - The spec booted one daemon in `beforeAll` and replayed that daemon's
    single-use startup launch URL from 11 call sites, so every navigation
    after the first got a 403 from `/-/auth`. Each test now mints its own
    code through the existing `POST /-/launch-code` agent endpoint, which
    also removes the 60 s expiry path. `fullyParallel` hid this locally
    (one worker, and so one daemon, per test) and `retries: 2` hid it in
    CI (a retry re-runs `beforeAll` and gets a fresh code).

### Security

- **Upgrade `zod` to 4.6.7** ([#235](https://github.com/vig-os/revkit/issues/235))
  - Clears GHSA-mrhx-c7xc-m3w5 (high): zod < 4.6.6 accumulated one validation issue per bad element when parsing
    an oversized array/set/map, so an attacker could pack a large array into a request and push the process into
    memory pressure. The upstream fix (`a0ebf97`, zod#6652) adds a leading length check that short-circuits
    `.max()` / `.length()` / `.size()` before element-walking.
  - revkit's HTTP body cap (`MAX_BODY_BYTES = 1 MiB` in `readCappedJsonBody`) already bounds how much the schema
    can be pushed to walk, so the request-scoped memory outcome stays bounded. The upgrade's leading check does
    cover `publishRequestSchema`'s two `.max(PUBLISH_ARRAY_SHAPE_MAX)` arrays, but `askAnswerSchema`'s `ranking`,
    `coordinates` and multi-choice `value` arrays have no `.max()` yet, so on those endpoints the upgrade clears
    the advisory flag rather than closing the path itself; adding those caps is a separate follow-up.
  - A root `overrides: { zod: "4.6.7" }` in `package.json` pins every resolution, including transitives
    (`@modelcontextprotocol/sdk`, `astro`, `@astrojs/sitemap`), so no nested copy of the vulnerable `zod@4.6.5`
    ships. Bumping the direct pins alone left nested `zod@4.6.5` resolutions in `bun.lock` for those three
    packages (their ranges `^3.25 || ^4.0`, `^4.5.4`, `^4.3.6` all accept 4.6.7), and the MCP SDK validates
    tool args through its nested copy — the `overrides` block collapses every resolution to a single
    `zod@4.6.7`, verified by `grep -o 'zod@[0-9.]*' bun.lock`.
- **Upgrade `@modelcontextprotocol/sdk` to 1.32.2** ([#227](https://github.com/vig-os/revkit/issues/227))
  - Clears two high-severity advisories in 1.31.0: GHSA-22jm-h49p-29qw (experimental tasks not tied to the creating
    session) and GHSA-46jr-4wx8-v453 (request validation could exhaust server memory over HTTP); the latter's
    mitigation (`maxToolInputElements`) is opt-in on `McpServer`, so the upgrade clears the advisory flag rather
    than fixing the path itself.
  - revkit's MCP server uses the low-level `Server` over stdio only, with no `taskStore`, so neither advisory path is
    reachable from it; the upgrade clears Dependency Review and keeps the dependency current.
- Invite display names reject controls, malformed Unicode, bidi overrides and
  names without visible content before D1, returning the documented refusal
  without consuming the invite's browser slot. The cap counts Unicode code points,
  and duplicate redemption fields are refused ([#145](https://github.com/vig-os/revkit/issues/145)).
