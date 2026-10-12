# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

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

### Deprecated

### Removed

### Fixed

- **`ask-page` Playwright suite no longer fails 5 of 11 tests at CI's `workers: 1`** ([#74](https://github.com/vig-os/revkit/issues/74))
  - The spec booted one daemon in `beforeAll` and replayed that daemon's
    single-use startup launch URL from 11 call sites, so every navigation
    after the first got a 403 from `/-/auth`. Each test now mints its own
    code through the existing `POST /-/launch-code` agent endpoint, which
    also removes the 60 s expiry path. `fullyParallel` hid this locally
    (one worker, and so one daemon, per test) and `retries: 2` hid it in
    CI (a retry re-runs `beforeAll` and gets a fresh code).

### Security

- **Cloudflare tooling hardening** ([#176](https://github.com/vig-os/revkit/issues/176))
  - Allowlist Wrangler's environment, pin an empty env file, refuse dev dotenv files and confine file paths.
  - Require explicit TTY confirmation for mutations and unknown commands; preserve user backup files.
