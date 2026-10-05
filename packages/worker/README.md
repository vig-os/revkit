# `@revkit/worker` — the hosted review Worker

The hosted surface (ADR-0008 surface (c), ADR-0025). One Cloudflare Worker, one
D1 database, and **the same review core** the local daemon and the browser use.

M4 slices 1 and 2 / issue #9. This README is the slice's honest scope statement;
read it before assuming a hosted feature exists because a file in this directory
mentions it.

## What is here

| Piece | File | Why it exists |
|---|---|---|
| Worker entry | `src/index.ts` | `GET /healthz`, `GET /api/threads`, `POST /api/session/refresh`, `GET /invite/<token>`, `POST /invite/redeem`, `POST /api/threads` (**disabled**) |
| Invites | `src/invites.ts` | ADR-0009's mint / redeem / revoke, the browser binding, and the per-call grant the gate checks |
| Invite pages | `src/invite-page.ts` | the display-name form and the closed/rate-limited pages — one external script, no inline script, no reflected input |
| Client script | `src/client-script.ts` | the ONE script the Worker serves: it rewrites the address bar to `/invite/` with `history.replaceState` so the invite token does not survive in history |
| Client asset | `src/client-asset.ts` | `/_revkit/<version>/invite-<sha256>.js` — the content-addressed name, the digest it is derived from, and the exact-match rule everything else 404s against |
| Abuse limits | `src/rate-limit.ts` | ADR-0012's per-invite and per-address counters (D1-backed; see the ADR amendment) |
| Invite tokens | `src/invite-token.ts` | the HMAC-SHA-256 hasher and its no-fallback key rule (ADR-0012's "stored as HMAC") |
| Retention | `src/retention.ts` | ADR-0015's 30-day guest anonymisation |
| Sessions | `src/session.ts` | mint, hash, store, resolve, rotate; the cookie and the CSRF token |
| The gate | `src/authz.ts` | ADR-0012's per-request authorization, and the route table that says which routes it applies to |
| Preview serving | `src/preview-assets.ts` | ADR-0012's extension→`Content-Type` allowlist as DATA, the R2 key layout, and the refusals — all decided from the REQUEST PATH |
| Hosted store | `src/d1-store.ts` | `D1ThreadStore implements ThreadStore` — ADR-0006's log on D1 |
| D1 schema | `migrations/0001_init.sql`, `migrations/0002_invites.sql` | the ONLY DDL for the hosted store, applied out of band, in filename order |
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

## Where a session comes from — and where an invite comes from

**There are exactly two issuers, and one of them is a route.**

1. **Out of band, by whoever holds write access to the D1 database** — in
   production `revkit deploy init` (slice 8), in tests the harness. The identity
   kind is `operator`. **`issueSession` has no HTTP caller, and that is the
   design, not an omission.**
2. **`redeemInvite`** (`src/invites.ts`), exchanging an ADR-0009 invite link. It
   is the legitimate caller ADR-0009 asks for and it is reachable **by design** —
   a guest arriving from a mail client has no session. Its credential is the
   invite token, its abuse limit is `src/rate-limit.ts`, and its single-use
   property is the redemption ledger. It goes through the SAME `mintSession` +
   `sessionInsertStatement` internals, so there is **one** issuance path rather
   than two; only the `INSERT` differs, because the redemption's write has to be
   atomic with the redemption that authorises it.

**The invite token is stored as `HMAC-SHA-256(token)`, not a bare digest**, under
the `INVITE_TOKEN_HMAC_KEY` Worker secret (`wrangler secret put
INVITE_TOKEN_HMAC_KEY`, at least 32 characters). There is **no fallback key**:
`inviteTokenHasher` has no overload that returns a hasher without one, so a
deployment missing the secret throws on every route — `/healthz` included,
because a deployment that cannot hash an invite token is not healthy. The key is
deliberately absent from `wrangler.jsonc`, and `test/worker-config.test.ts`
asserts it stays absent. Rotating it invalidates every outstanding invite. The
full argument, including the withdrawn plain-SHA-256 proposal, is in the ADR-0012
amendment.

**The limiter runs BEFORE the body is read, and it charges the address bucket
first.** Every path through the redeem handler is metered: malformed JSON, a
wrong media type, an over-long body, and both malformed spellings of the open
route all cost exactly one row write. The limiter bounds how MANY requests there
are and not how big each one is, so the body has its own ceiling:
`MAX_REDEEM_BODY_BYTES` (64 KiB, in `src/invites.ts` beside
`MAX_DISPLAY_NAME_CHARS`). A body over it is `413 body-too-large`, refused by a
**streaming** cap that cancels the reader past the ceiling rather than by
`request.text()` and a check afterwards — `content-length` is consulted first
because it is free, but it is attacker-controlled and never the guarantee. That ordering is load bearing rather than
tidy — the parse used to run first, so a 5 MB body was an unmetered
`request.text()` on an unauthenticated route. The **per-token** bucket, whose key
is `invite:<hmac(whatever the caller presented)>` and is therefore
attacker-chosen, is charged only *after* the token resolves to a real invite;
charging it earlier would make every guessed token a fresh row and no invite's
real budget ever touched.

**MINTING an invite has no HTTP route at all.** ADR-0009's only stated
consequence is "Invite minting requires write access", so `mintInvite` is out of
band too. An endpoint that mints invites is an endpoint that hands out review
access, and gating it on anything weaker than write access is a worse defect than
"the operator mints it" — the same reasoning that keeps `POST /api/session` from
existing.

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
`/healthz`, the `/_revkit/` client-asset path and the 404s. It answers, in this order:

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

For a **GUEST** session the gate adds four more (below), and slice 5 added the
fifth: the route must NAME a review, or the guest is refused
`invite-scope-unbounded`. "No scope" is not "no restriction" — before slice 5
the thread read named no repository, `inviteCovers` answered "in scope" for an
absent target, and the check ran on every request of a stranger's session while
selecting nothing.

What the gate still does **not** decide is ADR-0012's *other* scope clause —
"a GitHub session must still have read access to the repo (cached ≤ 5 min)" —
because there is no `TokenSource` (the App is owner-gated, #34). **That is the
named missing axis**, and it is worth naming **precisely, because the obvious name
is wrong**: `github` is ABSENT from `RECOGNISED_IDENTITY_KINDS`, so there is no
`github` session — one re-pointed at that kind is refused
`401 unrecognised-identity-kind`. **The unscoped kind is `operator`**: the gate's
scope block is under `if (resolved.principal.kind === "invite")`, so an
`operator` session reads whatever review the path names, across the whole
deployment. A guest is confined to its invite's scope; `operator` stays unscoped
until the provider can prove repo access. Neither was quietly changed. "Authorized" here means exactly: *a session this build
issued is presenting, unexpired; and if it is a guest, its invite is unrevoked,
unexpired, in scope, permitted to do what the route writes, and bound to this
browser*.

`RECOGNISED_IDENTITY_KINDS` is closed in the gate and open in the schema. Adding
the GitHub App or an invite means adding an arm there, where the scope rules get
written — not relaxing a `default`.

## The surface

| Route | Verbs | Answer |
|---|---|---|
| `/healthz` | GET, HEAD | 200 `{ok, revkitVersion, requestId}`. The only open route: it reads no database and returns no review content. |
| `/healthz` | other | 405 |
| `/api/threads` | any | **404 — removed in slice 5.** It named no review, so it could only ever answer org-wide and ADR-0012's per-call scope check had nothing to select on. Not a 403 and not a gated 501: a path that is not a route cannot leak a review, so gating it would be theatre. |
| `/<repo>/pr-<n>/api/threads` | GET, HEAD | 200 `{head, threads}` — **that review's** projection, behind the gate |
| `/<repo>/pr-<n>/api/threads` | GET `?since=<n>` | 200 `{head, events}` — that review's events with `seq > n`; `head` and the cursor are per review |
| `/<repo>/pr-<n>/api/threads` | POST | **501.** Passes the gate and the CSRF check, then: the hosted write is slice 4. |
| `/api/session/refresh` | POST | 200. Rotates the session id *and* the CSRF token, in one D1 batch, so a stolen cookie dies at the next refresh. |
| `/api/session/refresh` | other verbs | 405, **behind the gate**, so route existence is not enumerable anonymously |
| `/<repo>/pr-<n>/api/threads` | other verbs | 405, in the review's scope, **behind the gate** |
| `/invite/<token>` | **GET only** | 200 the display-name form (`no-store`, full CSP, no inline script, no reflected input, plus one external `<script src>` on the allowlisted path) plus the browser-binding cookie — **minted only when the browser has none**, so re-opening the mail link does not rotate the binding a live session depends on; 410 one closed page for every dead-link reason; 429 with `Retry-After`. `HEAD` is **refused**, because a read that consumes a redemption must not be answerable by a link checker. |
| `/invite/redeem` | **POST only** | 303 to a **token-free** path, with two `Set-Cookie`s (session + browser binding) and the CSRF token; 410 the same closed page; 429; 415 unless `application/json` **or `application/x-www-form-urlencoded`**; 400 for an unreadable body. The form encoding exists because the Worker SHIPS a form: `src/invite-page.ts` emits no `enctype`, so a browser submits `x-www-form-urlencoded` and a JSON-only route answers the shipped page with `415`. A repeated form field is refused outright (JSON's repeated-key "last wins" is left as-is and asserted separately). |
| `/<repo>/pr-<n>/…` (not the API) | GET, HEAD | 200 the one object named by the path, out of the R2 `PREVIEWS` binding — **behind the gate**, carrying the same **scope** as the API inside it. `Content-Type` comes from the path's extension against `src/preview-assets.ts`'s allowlist and **never** from the object's metadata; `.js`, `.mjs`, `.css`, `.wasm`, a double extension, a case variant, a trailing dot and a name with no extension are **404 with no body and no R2 read at all**; a missing object is the same 404. `html` gets the full CSP, `svg` gets `sandbox` + `Content-Disposition: inline`, `json`/images/fonts get theirs. 405 for every other verb, behind the gate. See "The preview surface" below. |
| `/_revkit/<version>/invite-<sha256>.js` | any | **200, the one client script** (slice 5b). `text/javascript; charset=utf-8`, `nosniff`, `Cache-Control: public, max-age=31536000, immutable`, and **no CSP of its own** — the embedding document's `default-src 'none'` is the control, and a CSP here would deny the document's own load of it. Ungated: the bytes are a compile-time constant (`src/client-script.ts`), so there is nothing to authorize and no `env.DB` on this path. |
| `/_revkit/…` (anything else) | any | 404, **never a redirect** (ADR-0012 — a browser drops the path part of a CSP source after a redirect, which would widen `script-src`). Every other version, an unhashed name, a mis-hashed name, a `.mjs`/`.html` spelling and the bare `/_revkit/` all miss, by exact string equality against the one name that resolves. |
| anything else | any | 404 |

**Why the scope is in the PATH and not a query parameter.** The obvious design is
`GET /api/threads?repo=…&pr=…`. It is worse on every axis: a parameter is
something a caller can forget to send, and something that can be tampered with in
transit; there is no unscoped spelling to fall back to, which is exactly how
`/api/threads` shipped. `<repo>/pr-<n>/api/threads` reuses ADR-0008's own address
rather than inventing a second convention, and the log key it selects is derived
by `previewScopePath` from the same `(repo, pr)` the scope check compares — so
there is no function in this package that turns caller input into a log key. The
base must be exactly two segments: `<repo>/pr-<n>/docs/api/threads` is a path
INSIDE a built site that happens to end in the suffix, and it is a preview.

**Repository names are CASE-SENSITIVE, deliberately.** `/REVKIT/pr-7/api/threads`
is a *different* review from `/revkit/pr-7/…` — a distinct `log_key`, and an empty
one. That is fail-closed (a guest scoped to `revkit` is refused `403` there, and
an `operator` reads an empty log), and it is a **deliberate choice rather than an
oversight**: GitHub repository names are case-insensitive, so normalising here
would mean guessing which spelling the operator minted an invite with, and a
guess that is sometimes wrong is a scope decision made by the wrong party.

**The mint side is canonicalised, and the read side deliberately is not.** `mintInvite`
stores `canonicalRepoName(input.repo)`, so an operator who mints `repo = "Revkit"`
and serves `/revkit/` now resolves that guest's own review instead of refusing it.
The **route** still compares exactly, so `/REVKIT/pr-7` continues to name a
*different* review and continues to fail closed. The remaining cost is real and
worth stating: **an invite minted `Revkit` now matches `/revkit/` and no longer
matches `/Revkit/`.** Folding at read time instead would make `/REVKIT/` and
`/revkit/` one review and would move the log key, which **is** the R2 partition.
`test/authorization.test.ts` asserts the fail-closed direction for both principals;
`test/router.test.ts` pins the fold's boundary (a Unicode fold is not an ASCII one —
`U+212A KELVIN SIGN` folds to `k`, which `isRepoName` accepts, so callers must
validate before folding).

`?since=` accepts one canonical form: `0` or a decimal integer with no sign, no
leading zero, no radix prefix, no exponent, no decimal point, no whitespace, and at
most 16 digits. Every other spelling — and every parameter that is not `since`,
which includes `?repo=`, `?scope=` and `?log_key=` — is a 400 with a closed reason
and the parameter **name** echoed, never its value. Authorization runs first, so
an anonymous caller gets 401 rather than a 400 that would describe the request's
shape to someone who has proved nothing.

`POST /api/session/refresh` exists because ADR-0012's CSRF and `application/json`
rules are only testable end to end if some state-changing call is reachable, and it
is the smallest such route: it writes nothing but the caller's own `sessions` row.

### The preview surface: `<repo>/pr-<n>/…` serves ONE object

`GET|HEAD <repo>/pr-<n>/<path>` reads one key out of the R2 `PREVIEWS` binding,
behind the gate, in the review's scope. Everything security-shaped about it is in
`src/preview-assets.ts`, and this section says what that is rather than how it is
coded.

**1. The media type comes from the REQUEST PATH and from nothing else.** The
allowlist is a table — `html`, `json`, `svg`, `png`, `jpg`, `jpeg`, `webp`,
`avif`, `woff`, `woff2` — and the lookup is exact and lowercase, so `.PNG` is a
miss rather than a fold. `R2Object.httpMetadata` and `customMetadata` are never
read: `writeHttpMetadata`, the only API that would put an object's metadata on a
response, is not called. `test/preview.test.ts` stores an object whose stored
`contentType` is `text/javascript` under `index.html` and asserts the response is
`text/html; charset=utf-8`, and the reverse (a `.png` whose metadata says
`text/html`). `X-Content-Type-Options: nosniff` is what makes the derived type
load-bearing rather than advisory.

**2. A refused path never becomes an R2 operation.** The decision is made from
the path BEFORE a key exists, so there is nothing to read. Refused: `.js`,
`.mjs`, `.css`, `.wasm`, anything not in the table, a double extension
(`page.html.js` — its extension *is* `js`), a case variant, a trailing dot, a
name with no extension, a name that is nothing but an extension, a bare
directory name. All of them are **404 with no body**, and the refusal reason is
one of a closed seven-word vocabulary that reaches neither the response nor the
log line.

**That is asserted with a counting binding, not by reading the order of two
statements.** R2 has no request log, so a refused path and a read of a missing
object are indistinguishable from outside workerd. `test/preview.test.ts` runs
the real Worker through `test/fixtures/preview-spy.ts` — the same module, the
same `fetch`, one binding replaced by a counter — and asserts `reads` is **zero**
for every refusal and **one** for an allowlisted path, with the key it asked for.
A contrast case exists so the counter cannot be vacuously zero.

**3. The 404 has no body, and that is the requirement.** A refused path, a
missing object and a review with nothing built in it are ONE answer. A body
would be the only place on this surface where a caller-supplied name could
travel, and none of the three has anything to say that the status does not. The
hygiene quartet and `Permissions-Policy` are still on it, and `no-store` is set
explicitly because the shared policy sets `Cache-Control` only for `json` and
`auth`.

**4. Each kind goes through the SHARED policy**, and the pair (kind, media type)
comes from one table row so they cannot disagree: `html` → `applyHtmlHeaders`
(the full ADR-0012 CSP, asserted directive by directive **on the response**),
`svg` → `applySvgHeaders` (minimal CSP + `sandbox` + `Content-Disposition:
inline`), `json` → `applyJsonHeaders`, images and fonts → `applyAssetHeaders` and
therefore **no CSP of their own** — a `default-src 'none'` on a font response
would deny the document's own load of it.

**5. The key layout is `<repo>/pr-<n>/<path>`**, which is DESIGN-0001 §6.1's
("R2, holding one built site per `<repo>/pr-<n>/`") and not a new convention: it
is `previewScopePath(repo, pr)` with the built site's path appended, so the R2
prefix and the log partition come from ONE string and one review's objects cannot
share a prefix with another's. A path ending in a slash is that review's
`index.html` — without that, the redemption's own `303` target would be refused for
having no extension. The lookup is a `Map` rather than a property read, because
`MEDIA_TYPES["constructor"]` on a plain object is `Object`'s own constructor: a
hit for an extension nobody allowlisted.

**6. Two aliases normalise ONTO a real path, and both are inert.** A WHATWG path
removes single-dot segments and treats `\` as a separator, so `./index.html`,
`docs/./index.html` and `docs\index.html` all read ONE key and serve
byte-identical content. `%2e%2e` is the interesting one: a URL spec decodes `%2e`
far enough to recognise a dot segment, so `/revkit/pr-7/%2e%2e/pr-8/index.html`
**is a request for pr-8** by the time anything here sees it. That is safe because
the scope travels with the normalised path — `Route.scope` and the key come from
the same string — and it is asserted in both directions: an operator reads pr-8's
object, and a guest scoped to pr-7 is refused `403 invite-scope-mismatch` on that
spelling. A lone `%2e`, `%2f` or `%5c` cannot survive as itself;
`parsePreviewPath` refuses those and `src/preview-assets.ts` refuses them again at
the place the key is built.

**7. Nothing here writes.** No `put`, no `delete`, no R2 credential in this repo.
The upload side — CI publishing a PR-head build, provisioning the bucket,
ADR-0014's fork approval — is tracked separately, so whoever controls the bucket's
contents is whoever runs the build pipeline, and ADR-0012's guarantee does not
depend on that being careful: the bytes are typed by the path.

**A missing `PREVIEWS` binding is a 500 on preview paths and nothing else.** No
route outside this one reads the binding, so a deployment without it cannot be
mistaken for a healthy surface that simply has no previews in it.
`test/worker-config.test.ts` asserts `wrangler.jsonc` declares the binding.

### A GUEST session is a session plus four more checks

Slice 3 added `identity_kind = "invite"` to the gate's closed set, which is the
arm ADR-0012's slice-2 amendment predicted would arrive "where the scope rules
get written". A guest session is not authorized by being a session: its authority
belongs to its invite, and the invite moves AFTER the session exists. So
`authorizeRequest` re-reads the invite on every request and decides, in this
order:

| # | Check | Refusal | Status |
|---|---|---|---|
| 1 | the request presents the browser the invite was redeemed in | `invite-browser-mismatch` | 403 |
| 2 | the invite is not revoked | `invite-revoked` | 401 |
| 2 | the invite has not expired (an unreadable expiry fails closed) | `invite-expired` | 401 |
| 3 | the route **names a review at all** — a guest is not admitted to a gated route with no scope | `invite-scope-unbounded` | 403 |
| 3 | the invite's `repo` + optional `pr` covers the review the route names | `invite-scope-mismatch` | 403 |
| 4 | `can_comment` permits what the route writes | `invite-read-only` | 403 |

**Why revocation here is immediate rather than eventual:** it is a property of
*where* the check lives, not of how fast it runs. A session already sitting in a
browser's cookie jar is refused on its next request — no expiry to wait for, no
revocation list, no cache. `test/invites.test.ts` drives exactly that, and
asserts the session row is still present and still unexpired while it is refused.

**A `view` guest's attempt to comment is refused by the GATE, not by the 501.**
That is deliberate: `POST <repo>/pr-<n>/api/threads` answers 501 because the
hosted write is slice 4's, but the *authorization* rule is ADR-0009's and it is
testable now, so the read-only refusal happens in front of the handler and the 501
is only ever reached by a caller entitled to write.

**The one route a guest may reach without a named scope** is
`POST /api/session/refresh` (`Route.guestScopeExempt`), because it rotates the
caller's OWN credential and touches nothing else. It is a field on `Route` rather
than a set of kinds here so that `classifyPath` has to be handed an answer for
every path and verb in the table — a new route cannot inherit "unscoped is fine"
without someone typing the word. `test/authorization.test.ts` pins that exactly
one path carries it, and `test/invites.test.ts` drives `authorizeRequest` with a
hand-built `Route` whose scope is absent, so the refusal is proven live against a
route the table does not contain.

**What the browser binding is, and is not.** A `__Host-` cookie, 256 bits, stored
only as a digest, minted by the response to `GET /invite/<token>` — so "bound to
the first browser that opens it" is literal. It stops a forwarded link and a
session cookie replayed from another profile. It does **not** stop an attacker who
steals the profile, an XSS on any same-origin page, or a guest handing over their
own unlocked device: it bounds *sharing*, it does not authenticate anybody.

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

1. **The message is a closed vocabulary.** `msg` is one of a fixed list of event names and a
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
bun test               # 12 files
bun run typecheck
```

The harness (`test/harness.ts`) starts one `miniflare` per test file, applies the
**real** migration file, binds an in-memory D1 **and an in-memory R2 bucket**
(`PREVIEWS`), and dispatches through workerd — the same binary
`wrangler deploy` would run. `wrangler.jsonc`'s compatibility date, flags and vars
are read from that file rather than duplicated in the harness, so the test runtime
cannot drift from the shipped config.

**Two things about the runtime budget, both measured and recorded in the harness's
header comment**, because they are easy to trip over:

- **Keep the number of `miniflare` instances low.** On this host a `bun test`
  process tolerates a handful; past that, whichever file runs next hangs in
  `getD1Database` and every later case in it fails with "Unable to connect".
  `test/preview.test.ts` therefore has exactly ONE instance and reuses it for the
  pure allowlist cases too.
- **The full-suite run flakes on a loaded host, and it flakes on `origin/dev`
  too.** Measured twice on an untouched `origin/dev` worktree during issue #101:
  422 pass / 14 fail and 322 pass / 114 fail, with the same "Unable to connect"
  cascade. The canonical comparison is per-file — `bun test --timeout 10000
  test/<file>.test.ts` — which is what CI's timeout value is for.

## What slices 1–3 do NOT do

Stated here so nobody has to read the PR body to find out:

- **No GitHub App.** No registration, manifest, OAuth or webhook. `TokenSource`
  stays unimplemented, so hosted **B2** (comment as the reviewer) and **B3**
  (submit review) do not move — and the gate has no repo-access check to make,
  because there is nothing to check it against.
- **The preview surface SERVES; nothing PUBLISHES to it.** See "The preview
  surface" below for exactly what ships. What does not ship is the other half:
  **no CI step writes a PR-head build into the bucket**, the bucket itself is not
  created (`wrangler.jsonc` declares the binding name and nothing has run
  `wrangler r2 bucket create`), there is no R2 credential anywhere in this repo,
  and no fork preview is approved (ADR-0014). So a deployment answers 404 on every
  preview path until an operator puts something there, and `B1` — "CI builds a
  preview and posts the link" — has not moved.
- **The allowlist is ADR-0012's list, which leaves two real gaps a build emits.**
  `.xml` and `.txt` are refused: the bullet names HTML, JSON, images, fonts and
  SVG, and an XML document is something a browser renders *as a document*, which
  is what the shared policy's unused `xml` kind exists for. Adding either is one
  table row plus (for XML) `buildMinimalCspHeader("xml")` behind it, and it should
  be an ADR amendment rather than a drive-by.
- **The GUEST half of scope authorization is done; the GitHub half is not.** A
  guest's scope is checked on every call against the review the route NAMES, the
  read is served from that review's own log, and a guest on a gated route that
  names no scope is refused rather than admitted (`invite-scope-unbounded`).
  What is still missing is ADR-0012's *other* clause — "a GitHub session must
  still have read access to the repo". `github` is absent from
  `RECOGNISED_IDENTITY_KINDS`, so the class that is org-wide **today is
  `operator`**, which the gate does not scope-check: it reads whatever review the
  path names. That is the **named missing axis**, and the class to audit; slice 5
  neither widened nor narrowed it.
- **The org-wide read is GONE, not narrowed.** An operator session reads one review
  per request, by URL. That is what a path-addressed surface means and it is the
  safe direction, but it means nothing in this build can *enumerate* a
  deployment's reviews. The GitHub bridge (slice 4) is what will want to, and
  ADR-0012's unimplemented read clause is what would authorise it. **Q6 stays
  partial** for that reason, not for the guest axis.
- **`POST <repo>/pr-<n>/api/threads` is still 501.** CSRF is load-bearing on a reachable route
  (`POST /api/session/refresh`), but no CSRF-protected *review write* ships, so
  "CSRF-protected writes" is not proven.
- **The 409 mapping for a lost refresh race is unexercised over HTTP.** The typed
  error and its "no second row" behaviour are proven in `test/session.test.ts`; the
  window between the gate's read and the rotation is one statement pair that a test
  cannot open from outside the request.
- **`POST /api/session/refresh` has no client.** The CSRF token is delivered by the
  issuance path and by this route's response header; no page reads it yet.
- **The shipped Worker bundle grew to ~807 KB.** Re-opening the thread read
  brought `@revkit/review-core` back into the deployed entry, so ADR-0025's "the
  core runs in workerd" is now a claim about the artefact that ships — asserted
  positively (named core exports must be present) and negatively (no Node/Bun
  escape hatches) in `test/worker-runtime.test.ts`.
- **Rate limits exist but are D1 counters, not Durable Objects.** ADR-0012 names
  the DO; slice 3 amends it (with the concurrency measurement) and leaves the DO
  for slice 6. Cost: one row write per limited attempt against D1's daily quota,
  so a sustained flood spends a deployment's quota.
- **Invite mechanics are real; the PRODUCT around them is not.** What is missing:
  the `"Name (guest)"` GitHub mirror (needs the App, #34 / slice 4); the
  `revkit invite --type` CLI, because minting is out of band by design; and
  **any way for a guest to comment**, because the append is still 501 — so `view`'s
  read-only rule is enforced by the gate rather than observed in the product.
  The **rest of slice 5** is also deliberately not here: the client page (the
  `replaceState` for URL stripping, and how a browser page reads its CSRF token)
  and the `revkit invite` CLI. Both depend on the scoped route existing, which is
  why they follow it.
- **The redeem `303` does not solve how a browser PAGE gets its CSRF token.** The
  token is minted and returned as a response header, exactly as
  `POST /api/session/refresh` does, but a navigation cannot read a response
  header. A meta tag in the preview document (whose hash then joins the committed
  allowlist) or a second non-HttpOnly cookie is the client page's choice, and it
  waits on the preview surface. Shipping neither is honest: no guest page exists to
  need one.
- **A repo-wide invite's holder is redirected to `/`, which 404s.** The redemption's
  token-free target is the review the invite names, and a `pr IS NULL` invite names
  none, so `previewPath` sends them to `/` — `unknown`, ungated, no index page in
  this build. Security-neutral (a 404 leaks nothing) and pre-existing, but it does
  mean a repo-wide guest can only reach a review by knowing its PR number.
- **No guest-purge SCHEDULE.** `purgeStaleGuests` is the whole deletion and is
  tested; nothing CALLS it on a cron, because a Cron Trigger cannot be exercised
  offline. Until `revkit deploy init` wires one, **guests are retained
  indefinitely** — the wrong direction for a privacy clock, and recorded as such
  in ADR-0015's 2026-10-04 amendment.
- **`sessions` rows are still never deleted**, and now name a guest, so deleting
  one is a personal-data decision ADR-0015 has not made. Expiry is a decision the
  gate makes per request, not a deletion.
- **No secrets, therefore no secret handling** (ADR-0014's substance is untested
  because there is nothing yet to leak).
- **No deploy.** `wrangler deploy`, `wrangler d1 create` and `revkit deploy` are
  out of bounds; `d1_databases[].database_id` is an obvious placeholder.
- **No scale evidence.** Three specific costs, all recorded in `d1-store.ts` rather
  than assumed away:
  - Throughput under a write burst is O(N) D1 round trips for N concurrent writers
    **to the same review**, because the seq allocator is a compare-and-swap and only
    one writer wins per round. Writers to *different* reviews no longer contend at
    all (each takes `seq = 1` of its own log), which is one of the few costs the
    partition removed. The fix for the remaining case is a block allocator, not a
    transaction (D1 refuses interactive ones).
  - `since()` and `threads()` read the WHOLE of **one review's** log with no `LIMIT`
    and no index beyond `(log_key, seq)` (the PK) and `(log_key, ts)`. The partition
    bounds it by review rather than by nothing, which is a real improvement and not
    a bound: one very large review still breaks on the first round trip that stops
    being cheap.
  - The FIRST `append` on a fresh store instance replays that review's whole log
    (one unbounded read plus one `validateNext` per event). Harmless today; a
    per-isolate warm-up cost proportional to the log from the bridge onward.

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
