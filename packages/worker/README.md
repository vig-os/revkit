# `@revkit/worker` — the hosted review Worker

The hosted surface (ADR-0008 surface (c), ADR-0025). One Cloudflare Worker, one
D1 database, and **the same review core** the local daemon and the browser use.

M4 slices 1 and 2 / issue #9. This README is the slice's honest scope statement;
read it before assuming a hosted feature exists because a file in this directory
mentions it.

## What is here

| Piece | File | Why it exists |
|---|---|---|
| Worker entry | `src/index.ts` | `GET /healthz`, `GET /api/threads`, `POST /api/session/refresh`, `POST /api/threads` (**disabled**) |
| Sessions | `src/session.ts` | mint, hash, store, resolve, rotate; the cookie and the CSRF token |
| The gate | `src/authz.ts` | ADR-0012's per-request authorization, and the route table that says which routes it applies to |
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

## Where a session comes from in this slice

**`issueSession` has no HTTP caller, and that is the design, not an omission.**
ADR-0012 authorizes on every request, so something has to issue a session. Slice 2
has neither the GitHub App (owner-gated, #34) nor an invite (slice 3), so the
only issuer available today is **out of band: whoever holds write access to the
D1 database** — in production `revkit deploy init` (slice 8), in tests the
harness. The identity kind it mints is `operator`.

Rejected alternative: a `POST /api/session` guarded by a deployment secret. It
needs a Worker secret, so it cannot be built or tested offline (#34); it would add
an unauthenticated endpoint to the shipped surface; and it would be the first
thing a later refactor widens. An unbuildable, unreachable control is worse than
an honest "the operator mints it".

**Write access to D1 is therefore the credential in this model**, exactly as
process memory is for the local daemon (ADR-0013). What is *not* the credential is
anything a client can construct: `sessions.id` holds the **SHA-256** of the
session id, so a database read is not a session, and the gate refuses every cookie
whose value does not resolve to a live row.

## The gate: ADR-0012's per-request authorization

One function, `authorizeRequest` in `src/authz.ts`, in front of every route except
`/healthz`, the `/_revkit/` bundle path and the 404s. It answers, in this order:

1. **Session.** The `__Host-revkit_session` cookie, base64url, 256 bits from
   `crypto.getRandomValues`. Resolved by `sha256(cookie)` against
   `sessions.id`. Refused when the row is missing, expired (checked on **every**
   read, and unparsable fails closed), blank in a load-bearing column, or carries
   an `identity_kind` outside `RECOGNISEN_IDENTITY_KINDS`.
2. **CSRF**, on a state-changing verb only. `x-revkit-csrf` must hash to *that
   session's* `csrf_hash`. Bound per session by construction — another session's
   token, the session id itself, and a rotated-away token all fail.
3. **`application/json`**, on a state-changing verb only. No parameter-suffixed
   type, no `text/json`, no `+json`, and no header at all.

What it does **not** yet decide is ADR-0012's *scope* clause — "a GitHub session
must still have read access to the repo" and "a guest invite is checked for scope,
type and expiry" — because there is no `TokenSource`, no invite, and no `repo`
axis in `events(seq, ts, payload)` for a scope check to select on. That is recorded
in the ADR-0012 amendment dated 2026-10-04. "Authorized" here means exactly: *a
session this build issued is presenting, unexpired*. A necessary condition, and
calling it sufficient would be the same overclaim slice 1 corrected twice.

`RECOGNISED_IDENTITY_KINDS` is closed in the gate and open in the schema. Adding
the GitHub App or an invite means adding an arm there, where the scope rules get
written — not relaxing a `default`.

## The surface

| Route | Verbs | Answer |
|---|---|---|
| `/healthz` | GET, HEAD | 200 `{ok, revkitVersion, requestId}`. The only open route: it reads no database and returns no review content. |
| `/healthz` | other | 405 |
| `/api/threads` | GET, HEAD | 200 `{head, threads}` behind the gate |
| `/api/threads` | GET `?since=<n>` | 200 `{head, events}` — exactly the events with `seq > n` |
| `/api/threads` | POST | **501.** Passes the gate and the CSRF check, then: the hosted write is slice 4. |
| `/api/session/refresh` | POST | 200. Rotates the session id *and* the CSRF token, in one D1 batch, so a stolen cookie dies at the next refresh. |
| `/api/*` | other verbs | 405, **behind the gate**, so route existence is not enumerable anonymously |
| `/<repo>/pr-<n>/…` | any | 501 naming slice 5 — **behind the gate**, so slice 5 inherits the gate from the route table instead of remembering it |
| `/_revkit/…` | any | 404, never a redirect (ADR-0012) |
| anything else | any | 404 |

`?since=` accepts one canonical form: `0` or a decimal integer with no sign, no
leading zero, no radix prefix, no exponent, no decimal point, no whitespace, and at
most 16 digits. Every other spelling — and every parameter that is not `since` —
is a 400 with a closed reason and the parameter **name** echoed, never its value.
Authorization runs first, so an anonymous caller gets 401 rather than a 400 that
would describe the request's shape to someone who has proved nothing.

`POST /api/session/refresh` exists because ADR-0012's CSRF and `application/json`
rules are only testable end to end if some state-changing call is reachable, and it
is the smallest such route: it writes nothing but the caller's own `sessions` row.

## Session storage, and why it is hashed

| | in the cookie / header | in `sessions` |
|---|---|---|
| session id | 256-bit base64url | `sha256(id)`, hex |
| CSRF token | 256-bit base64url | `sha256(token)`, hex |

Neither plaintext is recoverable from the database, and neither is ever logged.
Two tests say so at two levels: `test/logger.test.ts` drives genuinely minted
values through the redactor under innocent and credential-shaped keys, and its
end-to-end group captures the Worker's *own* log lines for an **authorized**
request and searches them for the session id, the CSRF token and both digests —
that capture needs miniflare's `console.log` forwarding, so it lives beside the
other log captures rather than in the gate's file.

A stolen-but-unexpired cookie is **bounded, not prevented**: `SESSION_TTL_MS`
(12 h) caps the initial life, `expires_at` is re-checked on every request, a
refresh rotates the credential away from a stolen copy, and a 7-day hard cap from
the original `created_at` stops a refresh loop. That cap is **unconditional**:
`created_at` is its only input, so a row whose `created_at` does not parse is
refused at the gate, and the rotation fails closed independently (`no cap`
becomes `expire now`, never `no limit`). Not present: logout-all-sessions, a
revocation list, device tracking, and any way to tell the thief from the owner.

## Why `workers_dev: false` matters — and what it does NOT do

It is a **tripwire, not an authorization check.**

- **Does:** with no `routes` either, this Worker has no public URL, so a mistake
  in the handler is not immediately reachable at `*.workers.dev`.
- **Does not:** authorize anything, and it never did. Slice 2 added the
  authorization — the gate above — and this line had no part in it.
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

1. **The message is a closed vocabulary.** `msg` is one of eight event names and a
   runtime guard refuses anything else, which is the only mechanism that can stop a
   **comment body** — no regex distinguishes prose from a log line.
2. **Key names.** A field whose name matches the sensitive set has its value
   replaced entirely, nested or arrayed. `session`, `sid` and `csrf` are in that
   set, which matters from slice 2 on because a session id and a CSRF token are
   now real values in real requests.
3. **Value shapes.** Every remaining string, at any depth, is tested for a
   credential shape, an email address, **or revkit's own token shape** — the
   last was added in slice 2 after MEASURING that a genuinely minted session id
   logged under the innocuous key `seen` came out verbatim, because the shape
   pass knew six credential families and none of them was the one this repo
   mints.

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
bun test               # ~10 s over 10 files
bun run typecheck
```

The harness (`test/harness.ts`) starts one `miniflare` per test file, applies the
**real** migration file, and dispatches through workerd — the same binary
`wrangler deploy` would run. `wrangler.jsonc`'s compatibility date, flags and vars
are read from that file rather than duplicated in the harness, so the test runtime
cannot drift from the shipped config.

## What slices 1 and 2 do NOT do

Stated here so nobody has to read the PR body to find out:

- **No GitHub App.** No registration, manifest, OAuth or webhook. `TokenSource`
  stays unimplemented, so hosted **B2** (comment as the reviewer) and **B3**
  (submit review) do not move — and the gate has no repo-access check to make,
  because there is nothing to check it against.
- **No preview serving.** No R2, no `<repo>/pr-<n>/` object, no
  extension→`Content-Type` allowlist. `parsePreviewPath` recognises a preview path
  and answers `501` naming the slice that serves it. ADR-0012's SVG-sandbox rule is
  implemented and tested as a header, against synthetic content only.
- **No scope authorization.** See "The gate" above. `GET /api/threads` returns the
  **whole** log to any valid session, because `events` has no `repo` column to
  scope by. **Q6 stays partial.**
- **`POST /api/threads` is still 501.** CSRF is load-bearing on a reachable route
  (`POST /api/session/refresh`), but no CSRF-protected *review write* ships, so
  "CSRF-protected writes" is not proven.
- **The 409 mapping for a lost refresh race is unexercised over HTTP.** The typed
  error and its "no second row" behaviour are proven in `test/session.test.ts`; the
  window between the gate's read and the rotation is one statement pair that a test
  cannot open from outside the request.
- **`POST /api/session/refresh` has no client.** The CSRF token is delivered by the
  issuance path and by this route's response header; no page reads it yet.
- **The shipped Worker bundle grew to ~807 KB.** Re-opening `GET /api/threads`
  brought `@revkit/review-core` back into the deployed entry, so ADR-0025's "the
  core runs in workerd" is now a claim about the artefact that ships — asserted
  positively (named core exports must be present) and negatively (no Node/Bun
  escape hatches) in `test/worker-runtime.test.ts`.
- **No rate limits, no Durable Objects.**
- **No invite semantics.** `invites` has the ADR-0009 shape and a UNIQUE
  `token_hash`; nothing mints, verifies, revokes or redeems one.
- **No retention.** Tables have the columns; nothing deletes anything — including
  `sessions` rows, which now exist and accumulate. Recorded in ADR-0015's
  2026-10-04 amendment.
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

- Slice 2 added **no migration**, on purpose: hashing the session id, storing the
  CSRF digest and rotating both fit `0001_init.sql`'s existing columns, and a
  migration that added a column nothing reads would be a migration that lies.
  When a real one is needed it goes in `migrations/0002_*.sql`, never by editing
  `0001`.
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
