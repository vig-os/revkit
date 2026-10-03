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
  - One store conformance suite runs against both `InMemoryThreadStore` and
    `D1ThreadStore`, with no skip mechanism to reach for.
  - `migrations/0001_init.sql` is the hosted schema: the event log plus
    `snapshots`, and `guests` / `invites` / `sessions` with ADR-0015's and
    ADR-0009's constraints enforced by the database. No purge yet.
  - A structured JSON logger with a request id per request and structural
    redaction (ADR-0020, ADR-0015).
  - `POST /api/threads` deliberately answers **501**: ADR-0012 requires a
    per-session CSRF token and this slice has no session, so append is proven
    through the store suite instead of opening an unauthorised endpoint.

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
