# `@revkit/worker` — the hosted review Worker

The hosted surface (ADR-0008 surface (c), ADR-0025). One Cloudflare Worker, one
D1 database, and **the same review core** the local daemon and the browser use.

M4 slice 1 / issue #9. This README is the slice's honest scope statement; read it
before assuming a hosted feature exists because a file in this directory mentions
it.

## What is here

| Piece | File | Why it exists |
|---|---|---|
| Worker entry | `src/index.ts` | `GET /healthz`, `GET /api/threads`, `POST /api/threads` (**disabled**) |
| Hosted store | `src/d1-store.ts` | `D1ThreadStore implements ThreadStore` — ADR-0006's log on D1 |
| D1 schema | `migrations/0001_init.sql` | the ONLY DDL for the hosted store, applied out of band |
| Response headers | `src/headers.ts` | adapter over the **shared** policy in `@revkit/review-core/http-headers` |
| Logging | `src/logger.ts` | structured JSON with a request id and structural redaction (ADR-0020, ADR-0015) |
| Path grammar | `src/router.ts` | ADR-0008's `<repo>/pr-<n>/`, as a pure function |
| Config | `wrangler.jsonc` | binding, compatibility date, and two load-bearing flags |

## Why `compatibility_flags: []` is load-bearing

ADR-0025 requires the shared core to run in a Cloudflare Worker. `nodejs_compat` is
**deliberately off**, so the platform itself refuses a `node:*` import and provides
no `Buffer`, `process` or `require`. A lint can be bypassed, commented out or
forgotten; a missing global is a runtime error on the first request that touches
the path.

Measured on workerd 2026-05-18 (miniflare 4.20260518.0, empty flag list):

```
typeof Buffer  === "undefined"
typeof process === "undefined"
typeof require === "undefined"
```

That measurement is why `@revkit/review-core/http-headers` encodes CSP hashes with
a hand-written base64 encoder instead of `Buffer.from(hex, "hex")`. The encoder is
differentially tested against `Buffer` over every digest length 1–64 bytes and over
the real committed allowlist, so it cannot quietly drift.

`test/worker-runtime.test.ts` re-asserts both halves, so a future compatibility
bump that re-enables the flag goes red.

## Why `workers_dev: false` is load-bearing

ADR-0012 requires authorization on every request. Slice 1 has no `TokenSource` and
no session, so `GET /api/threads` is unauthenticated. That is only acceptable
because this Worker has **no public URL**: `workers_dev: false` plus no `routes`
means nothing routes to it until `revkit deploy init` provisions a domain — which is
owner-gated (#34) and sequenced *after* slice 2's sessions. See the residual-risk
note in the PR body; this is a config flag, not an authentication check, and it is
asserted by a test so nobody flips it casually.

## Running the tests

Everything runs offline. No account, no token, no `wrangler login`, no `wrangler
dev`, no Cloudflare API call, no DNS.

```sh
nix develop            # or: direnv allow
bun install
cd packages/worker
bun test               # ~5 s
bun run typecheck
```

The harness (`test/harness.ts`) starts one `miniflare` per test file, applies the
**real** migration file, and dispatches through workerd — the same binary
`wrangler deploy` would run. `wrangler.jsonc`'s compatibility date, flags and vars
are read from that file rather than duplicated in the harness, so the test runtime
cannot drift from the shipped config.

## What slice 1 does NOT do

Stated here so nobody has to read the PR body to find out:

- **No GitHub App.** No registration, manifest, OAuth or webhook. `TokenSource`
  stays unimplemented, so hosted **B2** (comment as the reviewer) and **B3**
  (submit review) do not move.
- **No preview serving.** No R2, no `<repo>/pr-<n>/` object, no
  extension→`Content-Type` allowlist. `parsePreviewPath` recognises a preview path
  and answers `501` naming the slice that serves it. ADR-0012's SVG-sandbox rule is
  implemented and tested as a header, against synthetic content only.
- **No CSRF.** `POST /api/threads` is `501` with a pointer, because ADR-0012
  requires a per-session CSRF token and slice 1 has no session. Append is proven
  against the same `D1ThreadStore` in `test/store-conformance.test.ts` instead.
- **No rate limits, no Durable Objects.**
- **No invite semantics.** `invites` has the ADR-0009 shape and a UNIQUE
  `token_hash`; nothing mints, verifies, revokes or redeems one.
- **No retention.** Tables have the columns; nothing deletes anything.
- **No secrets, therefore no secret handling** (ADR-0014's substance is untested
  because there is nothing yet to leak).
- **No deploy.** `wrangler deploy`, `wrangler d1 create` and `revkit deploy` are
  out of bounds; `d1_databases[].database_id` is an obvious placeholder.
- **No scale evidence.** Throughput under a write burst is O(N) D1 round trips for N
  concurrent writers, because the seq allocator is a compare-and-swap and only one
  writer wins per round. Recorded in `d1-store.ts`; the fix if it matters is a block
  allocator, not a transaction (D1 refuses interactive ones).

## Adding a slice

- New hosted state goes in `migrations/0002_*.sql`, never by editing `0001`.
  Every statement stays `IF NOT EXISTS`-idempotent or the idempotence test
  (`test/schema.test.ts`, A15) is the thing you broke.
- New response headers go through `@revkit/review-core/http-headers`, not through a
  local copy. The `duplication` guardrails gate fires on a copy, and ADR-0025's
  2026-10-03 amendment is the recorded reason the policy is shared.
- New event-log behaviour goes into review-core, once, so the daemon and this
  Worker both get it. `test/store-conformance.test.ts` runs the same suite against
  `InMemoryThreadStore` and this store; a case that has to be skipped for one of
  them is a finding, not a convenience.
- The seq allocator's contract is in `d1-store.ts`'s header comment. Read it before
  touching `append`; A10 is the test that keeps it honest and it is not to be
  relaxed.
