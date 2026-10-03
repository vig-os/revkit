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
| Logging | `src/logger.ts` | structured JSON with a request id, and a redactor bounded to what it can actually detect (ADR-0020, ADR-0015 — see "What the redactor does and does not do") |
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

## `/api/threads` is closed — every verb, 501

`GET` and `POST` both answer **501** with the same body shape, naming M4 slice 2.
ADR-0012 requires authorization on *every* request — a GitHub session must still
have read access to the repo, an invite must be checked for scope, type and expiry
— and slice 1 has neither a session nor a `TokenSource`. The read is the larger of
the two exposures: an open `GET` needs no CSRF bypass, no browser and no user
interaction, and it returns comment bodies, which is what ADR-0015 protects.

Read and append stay fully proven, just not over HTTP:

- `packages/review-core/test/store-conformance.ts` runs 19 cases against **all
  three** `ThreadStore` implementations (in-memory, the daemon's `bun:sqlite`,
  and this package's D1).
- `test/d1-store.test.ts` proves the `?since=` log catch-up and the
  `exportArchive`/`import` bridge between D1 and an in-memory store, both
  directions.

## Why `workers_dev: false` matters — and what it does NOT do

It is a **tripwire, not an authorization check.**

- **Does:** with no `routes` either, this Worker has no public URL, so a mistake
  in the handler is not immediately reachable at `*.workers.dev`.
- **Does not:** authorize anything. The authorization this Worker performs is
  none — `/api/threads` is closed by code, and that 501 is asserted by
  `test/worker-runtime.test.ts` against a **non-empty** log.
- **Does not survive** slice 3 or slice 5 adding a `routes` entry.
- **Never applied** to `wrangler dev --remote`.

Treat flipping either line as security-relevant. `test/worker-config.test.ts`
asserts both so neither is changed casually, and it says in its own header that it
must not be read as evidence a request was authorized.

## One cross-package import, on purpose

`src/index.ts` imports `../../cli/src/dist-check-allowlist.json` — a relative path
into the CLI package's **source** tree. That is deliberate: that file IS the
release artefact ADR-0012 names ("the allowlist of the revkit version it runs,
never hashes found in an artifact"), and a second copy would be a second
`script-src` policy, which is the failure ADR-0025 exists to prevent. A test in
`test/headers.test.ts` asserts it is the only allowlist import in the module.

The cost, so it is not a surprise: **moving that file inside the CLI breaks the
Worker build with an opaque unresolved-specifier error**, not a helpful one. If you
relocate it, fix `src/index.ts` in the same commit.

## What the redactor does and does not do

`src/logger.ts`'s header is the authority. Three mechanisms are enforced:

1. **The message is a closed vocabulary.** `msg` is one of five event names and a
   runtime guard refuses anything else, which is the only mechanism that can stop a
   **comment body** — no regex distinguishes prose from a log line.
2. **Key names.** A field whose name matches the sensitive set has its value
   replaced entirely, nested or arrayed.
3. **Value shapes.** Every remaining string, at any depth, is tested for a
   credential shape or an email address — which is what catches a leak under an
   *innocent* key.

**Not enforced:** free-form prose under a key the redactor does not recognise.
The control for that is the caller rule — review content is never passed as a log
field — plus mechanism 1. `test/logger.test.ts` pins the limitation with a test
named for it, so the caveat cannot be quietly deleted.

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
- **No CSRF and no authorization.** Both verbs on `/api/threads` are `501`, so
  **Q6 stays partial**. Neither read nor append is reachable over HTTP; both are
  proven through the store suites instead.
- **The shipped Worker bundle no longer contains `@revkit/review-core`.** Closing
  `GET /api/threads` left nothing reachable from `src/index.ts` touching
  `D1ThreadStore`, so the bundler tree-shook the core out: ~20 KB, where it was
  ~790 KB. ADR-0025's "the core runs in workerd" claim is therefore proven against
  the runtime probe bundle (which does contain the core, ~776 KB), not against the
  shipped entry. Both are scanned by `test/worker-runtime.test.ts`.
- **No rate limits, no Durable Objects.**
- **No invite semantics.** `invites` has the ADR-0009 shape and a UNIQUE
  `token_hash`; nothing mints, verifies, revokes or redeems one.
- **No retention.** Tables have the columns; nothing deletes anything.
- **No secrets, therefore no secret handling** (ADR-0014's substance is untested
  because there is nothing yet to leak).
- **No deploy.** `wrangler deploy`, `wrangler d1 create` and `revkit deploy` are
  out of bounds; `d1_databases[].database_id` is an obvious placeholder.
- **No scale evidence.** Three specific costs, all recorded in `d1-store.ts` rather
  than assumed away:
  - Throughput under a write burst is O(N) D1 round trips for N concurrent writers,
    because the seq allocator is a compare-and-swap and only one writer wins per
    round. The fix is a block allocator, not a transaction (D1 refuses interactive
    ones).
  - `since()` and `threads()` read the WHOLE `events` table with no `LIMIT` and no
    index beyond `seq` (the PK) and `ts`. Nothing breaks at slice-1 scale because
    nothing writes over HTTP yet, and it will break on the first log large enough
    for one round trip to stop being cheap.
  - The FIRST `append` on a fresh store instance replays the whole log (one
    unbounded read plus one `validateNext` per event). Harmless today; a per-isolate
    warm-up cost proportional to the log from the bridge onward.

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
