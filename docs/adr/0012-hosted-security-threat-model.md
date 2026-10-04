# ADR-0012: Hosted security: threat model, CSP and isolation

- Status: Accepted
- Date: 2026-09-29
- Stories: B1–B5
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Amended by: the 2026-10-04 (issue #9, slice 5) amendment at the end of this
  document — the guest half of "authorization per request" is implemented in
  full, and the GitHub-read clause is the half that remains.

## Context

Agent-authored and fork-contributed content is rendered on a shared, authenticated origin (`review.exoma.org`), with
previews path-based rather than per-subdomain (ADR-0008).

## Decision

- **Preview paths never serve executable content.** Under `/<repo>/pr-<n>/` the Worker serves only HTML, JSON, images
  (PNG/JPEG/WebP/AVIF) and fonts; `.js`, `.mjs`, `.css`, `.wasm` and anything else are refused. SVG is served with
  `Content-Security-Policy: sandbox` and `Content-Disposition: inline` so it can't run script.
- **All scripts and stylesheets come from a revkit-owned path**, `/_revkit/<version>/`, deployed by revkit's own
  release (never from a PR artifact).
- **Content Security Policy** on every HTML response: `default-src 'none'`; `script-src
  https://review.exoma.org/_revkit/<current-version>/ 'sha256-…'` (only revkit's bundle path plus the hashes of the
  inline bootstrap scripts Astro/Starlight emit: island loader, theme toggle); `style-src 'self' 'unsafe-inline'`
  (KaTeX, Vega SVG and Starlight need inline styles; styles can't execute script); `img-src 'self' data:
  https://avatars.githubusercontent.com`; `font-src 'self'`; `connect-src 'self'` (API and WebSocket);
  `frame-ancestors 'none'`; `base-uri 'none'`; `form-action 'self'`; `object-src 'none'`.
- **The inline-script hash allowlist ships with the revkit release**, produced by the build (Astro's CSP hashing if
  the pinned version supports it, otherwise a revkit post-build step that hashes every inline script), and the Worker
  applies the allowlist of the revkit version it runs, never hashes found in an artifact.
- **Response hygiene:** every response sets `X-Content-Type-Options: nosniff`; the Worker derives `Content-Type` from
  the file extension against its own allowlist, never from artifact or object metadata.
- **`/_revkit/` never redirects** (no trailing-slash or `latest` aliases): browsers drop the path part of a CSP source
  after a redirect, which would widen `script-src`. `script-src` names only the **current** revkit version, so a page
  can't load an older, possibly vulnerable bundle.
- **Fork HTML can still carry `<astro-island>` elements with props it controls** and trigger the allowed loader. So
  component props and preview JSON are **untrusted input**: components never render them through `innerHTML` or
  equivalent, and no component makes a state-changing call without an explicit user action.
- **Content can't carry code at build:** MDX is compiled with the registry-only guard (ADR-0005); raw HTML,
  `<script>`, `<style>`, inline handlers and `javascript:` URLs fail the build. For fork PRs this is defence in depth
  only, since a fork can alter its own build; the path and CSP rules above are what hold.
- **Sessions:** HttpOnly, Secure, SameSite=Lax cookies; every state-changing call needs a per-session CSRF token in a
  header; the API accepts only `application/json`.
- **Authorization per request:** a GitHub session must still have read access to the repo (cached ≤ 5 min); a guest
  invite is checked for scope, type and expiry on each call.
- **Abuse limits:** rate limits on invite redemption and comment posting per identity and IP (Durable Object
  counters); invite tokens are 256-bit random, stored as HMAC.
- **Fork previews** are published only after a maintainer approves (ADR-0014) and are labelled "untrusted fork".

## Consequences

Blocks M3. Isolation weaker than per-subdomain origins is accepted in exchange for zero certificate cost; revisit if
third-party (non-org) repos are ever onboarded.

## Amendment (2026-09-30)

Clarifications from the M2 build-out of the CSP on `revkit serve` (issue #22; see also the ADR-0013 amendment on the
same date for the local daemon's per-directive specifics).

- **Inline-script hash allowlist as a release artefact.** The M2 daemon reads its `sha256-…` allowlist from
  `packages/cli/src/dist-check-allowlist.json` — the committed, reviewed set the running revkit version ships. It
  NEVER reads a hashes file the served dir carries: whoever controls the build controls the `<script>` tags too, so
  a build-owned artefact widening `script-src` would be trivially forgeable. This is the ADR line "the Worker applies
  the allowlist of the revkit version it runs, never hashes found in an artifact" applied to the daemon. `revkit
  check-dist` already enforces that every inline script in a built site is a subset of the same allowlist; the
  daemon reads the same file.
- **`script-src` path scoping.** The M2 daemon lists the exact loopback URLs for its script sources
  (`http://127.0.0.1:<port>/-/rail.js` and `.../_astro/`). The hosted Worker will use `/_revkit/<version>/` on the
  revkit-owned origin as this ADR already prescribes; the daemon exception is documented in ADR-0013.
- **`'unsafe-eval'` scope; `'wasm-unsafe-eval'` only.** ADR-0012's `script-src` never contains `'unsafe-eval'`, and
  the M2 daemon does not either: the rail is JSX-compiled at build time with `babel-preset-solid`, so the bundle has
  no runtime template compilation. Starlight search (pagefind) needs `'wasm-unsafe-eval'` — the narrow keyword that
  allows `WebAssembly.instantiate` on a byte sequence but not `eval()` / `new Function()` on JavaScript. The mutation
  guards in `test/serve/headers.test.ts` and `test/rail/injector.test.ts` refuse a regression. See ADR-0013 amendment.
- **`connect-src` and WebSocket.** CSP L3 (Chromium ≥ 96, Firefox ≥ 99) treats `'self'` as covering `ws://` on the
  same origin; the hosted Worker keeps `'self'` alone. The local daemon adds an explicit `ws://127.0.0.1:<port>` for
  older WebKit builds.
- **Response hygiene beyond `nosniff`.** Every response also carries `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, and a `Permissions-Policy`
  denying camera / microphone / geolocation / payment / USB / WebAuthn / display-capture / … . API JSON, launch-code
  responses, and the `/-/auth` 302 carry `Cache-Control: no-store`. The M3/M4 Worker will ship the same set.

## Amendment (2026-10-04, issue #9) — what the per-request gate implements, and what it does not

**Why this is an amendment and not a new ADR.** The session and authorization
rules above were implemented in M4 slice 2 without contradicting them. But
"authorization per request" is one sentence that this slice satisfies only
**partly**, and a partly-satisfied requirement that reads as satisfied is the
failure mode this ADR exists to prevent — so the partial state is recorded here,
with the slice that closes each half.

**The gate.** One function, `authorizeRequest` (`packages/worker/src/authz.ts`),
sits in front of every route except `/healthz`, the `/_revkit/` bundle path and
the 404s, and it runs in this order:

1. **Session.** A `__Host-revkit_session` cookie — 256 bits from
   `crypto.getRandomValues`, base64url — resolved by `sha256(cookie)` against
   `sessions.id`. The column holds the **digest**, not the id, so a database
   read is not a credential.
2. **CSRF**, on state-changing verbs only: `x-revkit-csrf` must hash to that
   session's own `sessions.csrf_hash`.
3. **`application/json`**, on state-changing verbs only — **with exactly one
   documented exception, `POST /invite/redeem`**, which also accepts
   `application/x-www-form-urlencoded`. See the amendment at the end of this
   document for why that is not a second API media type.

**Satisfied by this amendment:**

- "every state-changing call needs a per-session CSRF token in a header" — real,
  and load-bearing on a reachable route (`POST /api/session/refresh`), with the
  token bound per session rather than being a constant.
- "the API accepts only `application/json`" — real, including a body-less POST,
  which must still declare it, and with the **one exception below**.
- Sessions are HttpOnly / Secure / SameSite=Lax, and additionally `__Host-`,
  which the browser only accepts without a `Domain` attribute — so a sibling
  subdomain cannot set a cookie this origin will send.
- Expiry is enforced **on every read**, not only at issue, and an `expires_at`
  that does not parse fails closed.

**Explicitly NOT satisfied, and where each half lands:**

- "a GitHub session must still have read access to the repo (cached ≤ 5 min)" —
  **not implemented.** There is no `TokenSource`; the App is owner-gated (#34).
  Slice 4.
- "a guest invite is checked for scope, type and expiry on each call" — **not
  implemented.** There is no invite to redeem (slice 3), and the store has no
  `repo` axis for a scope check to select on: `events(seq, ts, payload)`. Slice 3
  for the invite's own scope/type/expiry; the repo axis arrives with the preview
  surface (slice 5).

So the honest reading of "authorized" in M4 slice 2 is: **a session this build
issued is presenting, and has not expired.** It is a necessary condition. A valid
session currently receives the whole log, because there is nothing yet to scope it
by.

**Deny by default on the provider.** `sessions.identity_kind` is deliberately
unconstrained in the schema (adding a provider must not be a table rewrite), so
the gate closes the set instead: an identity kind it does not recognise is
**refused**, not defaulted to allowed. Slice 3 and slice 4 add their arm there,
where the scope rules get written.

**Where a session comes from until an invite exists.** Out of band, by whoever
holds write access to D1 — `revkit deploy init` (slice 8) — as the `operator`
identity kind. There is deliberately **no** `POST /api/session`: an
unauthenticated endpoint that hands a credential to whoever asks is a worse
defect than "the operator mints it", and a secret-gated one cannot be built or
tested offline (#34). Write access to D1 is therefore the credential in this
model, exactly as process memory is for the local daemon (ADR-0013); what is not
the credential is anything a client can construct.

**A stolen-but-unexpired cookie is bounded, not prevented.** 12 h initial TTL,
expiry re-checked per request, `POST /api/session/refresh` rotates both the id
and the CSRF token in one D1 batch so the legitimate browser can invalidate a
stolen copy, and a 7-day hard cap from the original `created_at` prevents a
refresh loop from keeping one credential alive.

**That cap is unconditional, and an earlier version of this sentence was not
true as written.** `created_at` is the only input to the cap, and the resolver
originally refused a *blank* one while accepting a *non-parsable* one — so a row
saying `not a date` produced a principal, the cap computed as `NaN`, and the
rotation took a no-cap branch: measured, 720 hourly refreshes over 30 simulated
days slid the expiry out by the full 30 days where a well-formed `created_at`
correctly died at the cap. A row whose `created_at` cannot be read is now
refused outright, and the rotation independently fails closed (`no cap` resolves
to `expire now`, never to `no limit`) so the guarantee does not depend on the
gate's callers. `expires_at` already failed closed on the same shape; the
asymmetry was the defect. Both are pinned in `test/session.test.ts`.

There is no logout-all-sessions, no revocation list and no device tracking;
ADR-0009's invite revocation (slice 3) is the first mechanism that closes any of
those.

## Amendment (2026-10-04, issue #9, slice 3) — invite tokens, rate limits, and
## the per-call guest check

Slice 3 implements ADR-0009's invite mechanics. Two of this ADR's lines are
**amended rather than implemented as written**, and both amendments are
recorded here with the measurements behind them, because a divergence from an
accepted ADR that lives only in a commit message is the failure mode this ADR
exists to prevent.

### 1. "stored as HMAC" → **kept** as HMAC, and the first proposal is withdrawn

The abuse-limits bullet above ends *"invite tokens are 256-bit random, stored as
HMAC"*. Slice 3 **implements it as written**:
`packages/worker/src/invite-token.ts` stores `HMAC-SHA-256(token)` under the
`INVITE_TOKEN_HMAC_KEY` Worker secret.

**The withdrawn proposal.** An earlier draft of this slice proposed amending the
bullet to plain `SHA-256`, on two grounds: that HMAC's advantage is for
low-entropy secrets and a 256-bit CSPRNG token has no dictionary, and that the
harness could not supply a key. **Both grounds were measured and both were
answered, and the amendment is withdrawn rather than left standing:**

- **The entropy argument does not decide this.** At 256 bits of
  `crypto.getRandomValues` there is no dictionary, so the *marginal* protection
  today is small — the ADR does not claim otherwise. What the keyed form buys
  is that the lookup key's safety stops depending on an unstated invariant
  about a function in another file: HMAC's safety rests on a key, a bare
  digest's rests entirely on "nobody ever derives a token instead of drawing
  it". `invites.token_hash` is the row's identity, so that invariant is load
  bearing and unversioned. The narrow claim is the property worth having.
- **"The harness cannot supply a key" was a misdiagnosis.** **Measured:**
  miniflare 4.20260518.0 ignores its `secrets` option, so
  `env.INVITE_TOKEN_HMAC_KEY` came back `undefined` when passed there — and the
  same value passed through `bindings` came back as the string. `wrangler
  secret put` also lands in `env`, and from inside the Worker the two are
  indistinguishable, so nothing about the *deployed* shape was untestable. The
  harness was wrong, not the design. `test/harness.ts` binds through
  `bindings` and says why.
- **The fallback-key worry was real and is answered by construction.**
  `inviteTokenHasher(key)` has no overload that returns a working hasher without
  a key, and `test/worker-config.test.ts` asserts the key is named but never
  declared in `wrangler.jsonc`'s `vars` or `secrets_store`. A missing secret
  throws rather than defaulting.

**Cost, stated rather than hidden.** One deployment secret to provision
(`wrangler secret put INVITE_TOKEN_HMAC_KEY`, ≥ 32 characters) and to rotate.
Rotation invalidates every outstanding invite, which is a deliberate, documented
cost rather than an accident.

**Migration:** none. Both forms are 64 hex characters and `invites.token_hash`
is `TEXT`, so `migrations/0001_init.sql` needs no `ALTER`. That is what made
the original amendment cheap, and it is also what made reversing it cheap.

**A missing key is a 500 on every route, `/healthz` included, and that is
deliberate.** A Workers *module* worker has no module-scope initialiser — `env`
does not exist until a handler runs — so there is no "start" at which to refuse.
The equivalent is a first-line check in `fetch`, and `/healthz` is included
because a deployment that cannot hash an invite token is not healthy and a probe
that says otherwise is a probe nobody should trust. The alternatives were worse:
a per-call throw alone reports `/healthz` 200 while every invite route 500s, and
refusing to start is not expressible. The check is **first**, before
`beginRequest`, because a deployment missing both bindings would otherwise
report the `REVKIT_VERSION` fault instead of the one an operator has to fix
(`test/worker-runtime.test.ts` measures exactly that, which is why it asserts on
the message and not merely on a 500).

### 2. "rate limits … (Durable Object counters)" → a D1-backed counter

The same bullet names the mechanism. Slice 3 ships
`packages/worker/src/rate-limit.ts` on D1 and records the Durable Object as the
end state (M4 slice 6, with the rest of the DO work).

- **A D1 counter is a real counter, not an approximation. Measured on workerd
  2026-05-18:** `INSERT … ON CONFLICT(bucket) DO UPDATE SET count = count + 1
  RETURNING count`, issued **20 times concurrently** against one bucket,
  produced 20 distinct counts (1…20) — no lost updates. The increment and the
  window rollover happen in one statement, so the whole check is a single round
  trip with no read-then-write window. (Slice 1 measured what that window costs:
  six concurrent read-then-write appends produced three distinct `seq` values.)
- **"We could not test a Durable Object here" would be false. Measured:** a
  Durable Object namespace bound in miniflare with an exported `DurableObject`
  subclass answers 200 offline, with no account. The argument for D1 is
  therefore **scope**, not tooling, and saying otherwise would be the
  plausible-mechanism story this repo keeps warning about.
- Shipping redemption with **no** limit while this ADR claims one was not an
  option, and shipping a limit that is honestly D1 is.

Cost, stated rather than hidden: **one row write per limited attempt** against
D1's daily row-write quota, so a sustained flood spends that deployment's quota.
The quota is **100,000 rows written per day per database** on D1's Free plan
(Cloudflare's published limit); the paid plan's ceiling is orders of magnitude
higher. Every metered attempt is one `INSERT … ON CONFLICT … DO UPDATE`, and the
increment and the window rollover are in that same statement, so one attempt is
one write and not two.

The quota is what makes the ordering rule below load bearing rather than
cosmetic: the address bucket is charged **first, on every path**, so an
unresolvable or malformed request still costs exactly one write.

The **per-token bucket key is attacker-chosen** — it is
`invite:<hmac(whatever the caller presented)>`, and an attacker chooses what to
present. So it is charged only *after* the token resolves to a real invite.
Charging it before the lookup would make **every guessed token a fresh row** —
one write per guess, and no invite's real budget touched, so a limit that cannot
defend against guessing is not defending against guessing
(`test/invites.test.ts`, "a token that does NOT resolve creates no counter row at
all"). Because the address bucket's key is the edge-set address, the number of
rows an attacker can mint is bounded by how many source addresses they hold
rather than by how much they can guess.

A Durable Object trades the row-write cost for per-isolate consistency at a
per-request cost. The limit's purpose here is to make a 256-bit token
unguessable *by volume*; a quota exhaustion is a louder failure than a leaked
invite. Residual risk, in the ADR rather than only in a PR.

Two further properties of the shipped limit, both measured by test rather than
asserted: `X-Forwarded-For` is **never** read (every hop appends to it, so it is
forgeable and a forgeable identity half would make the whole limit forgeable);
and the **per-token limit is enforced by a test against `max_browsers`**, because
a limit below `2 × max_browsers` makes a legitimate multi-browser invite
unusable — it was 10 against `team`'s `max_browsers = 10`, and each browser used
to cost two attempts against that budget (open, then redeem), so the tenth
browser was rate-limited rather than admitted. **It costs one now**: the open
route no longer spends the per-token bucket, because charging a budget to a GET
on a URL anyone holding the link can replay was a denial of service in its own
right. The `2 ×` in the relationship is therefore slack rather than a tight fit,
which is the safe direction. The relationship is **asserted, not derived**: `REDEEM_TOKEN_LIMIT`
is the constant `40` and the test
("the per-token limit is above 2 x the largest max_browsers") is what fails if
someone edits one without the other. No code computes the limit from
`max_browsers`, so there is no derivation to keep in step.

### 3. "a guest invite is checked for scope, type and expiry on each call" — now
### implemented, in two halves

ADR-0009's invitation revocation is implemented. A session whose
`identity_id` is a guest id is re-checked **on every authorized request**:

1. **revocation** — `invites.revoked_at`, from the row as it stands now;
2. **expiry** — `invites.expires_at`, with an unreadable value failing closed;
3. **scope** — the invite's `repo` and optional `pr` against the repo/PR the
   route names;
4. **type** — `invites.can_comment` against whether the route writes review
   content.

Plus one property this ADR did not name and ADR-0009 implies: the session must
present the **same browser** the invite was redeemed in
(`__Host-revkit_browser`, stored as a digest, checked on every call). The
mechanism and the attacks it does *not* stop are in `src/invites.ts`'s header;
the short version is that a cookie binds a browser *profile*, so it bounds
sharing and does not authenticate anybody.

**What "on each call" does not yet cover, and this is the honest half.** The
scope check selects on routes that NAME a repo and PR, which today means
ADR-0008's `<repo>/pr-<n>/` preview paths. `GET /api/threads` names none,
because `events(seq, ts, payload)` has no `repo` column for a scope check to
select on — so a guest with a valid invite currently reads the whole log, exactly
as an operator does. The preview surface (slice 5) adds the axis; until then a
revoked, expired or wrong-browser guest is refused everywhere, and an in-scope
guest is refused on out-of-scope paths.

The `view`-is-read-only half is enforced **by the gate, before the handler**,
which is how it is testable while `POST /api/threads` is still a 501: a
read-only guest's attempt at the append is refused `403 invite-read-only`, and
the 501 is only ever reached by a caller entitled to write.

### 4. "`application/json` only" — and the one route that also accepts a form

**The JSON-only clause above is about the API, and `POST /invite/redeem` is not
one.** Its caller is a person who followed a link in a mail client and is
standing in front of the display-name form this Worker itself rendered; a
browser submits that form as `application/x-www-form-urlencoded`, because the
page declares no `enctype`. Refusing it means the shipped page cannot be
submitted by the thing it was built for — which is what happened: the route
accepted only JSON, so every redemption through the shipped form answered `415`
while the test suite was green, because the tests posted JSON the way a *program*
would rather than the way a *browser* does. **This is the only route in the
Worker with the exception**, and it stays that way deliberately: every other
body-carrying route is consumed by revkit's own client code and has no browser
in the loop, so a second media type there would widen the surface for nothing.

What the exception does **not** do is relax the rules. `text/plain`,
`application/ld+json` and every other type are still refused with `415`, a
parameterised type of either (`application/json; charset=utf-8`) is accepted as
the type it names, and the two encodings are held to the **same** limits:
a repeated form field is refused outright rather than resolved, the display-name
bound is `redeemInvite`'s on both paths, and the token shape is one predicate
(`TOKEN_SHAPE`) for both. The encoding is named once, in `src/invite-page.ts`,
and imported by the route — so the page and the route cannot disagree about it
without a type error, and a test derives its request from the page's own markup
(`action`, `method`, the absent `enctype` and the field names) rather than from a
hand-written copy of what the page emits.


### 5. Sessions are issued to a guest by an unauthenticated route — and why that
### is not `POST /api/session`

Slice 3 adds the first route in this Worker that hands a session to a caller who
has none, and it is worth saying precisely what stands in for the gate there:

- the credential is the **invite token** (256 bits, hashed at rest, `UNIQUE`),
  not an absent session;
- ADR-0012's **CSRF rule is deliberately not applied** to it, because a CSRF
  token binds a state change to an *existing* session and there is none. The
  controls that fit this shape are single use and a rate limit; a CSRF check
  here would be a control that cannot fail.
- **single use** is per browser and bounded by `max_browsers`, enforced inside
  one D1 batch so a lost race leaves nothing behind. This is the precise reading
  of ADR-0009's three share types — see the ADR-0009 amendment dated
  2026-10-04.
- `HEAD` is refused on both invite routes, so a link checker cannot consume a
  guest's single redemption.
- **Minting** an invite has no HTTP route at all, for the same reason
  `POST /api/session` does not exist: an endpoint that hands out review access
  is worse than "whoever holds write access to D1 mints it".

### 6. Two ungated readers of `env.DB`, and the restated invariant

Slice 2's invariant was "the gate is the only path to `env.DB`". The invite
routes must be ungated — a guest arriving from a mail client has no session — so
the invariant is restated rather than dropped: the gate is still the only path to
the **thread store** and to `sessions` for authorized requests, and the invite
handlers touch only `invites`, `invite_redemptions`, `guests` and
`rate_limit_counters`. `D1ThreadStore` is not constructible from them.

## Amendment (2026-10-04, issue #9, slice 5) — the guest half is implemented, and
## the GitHub-read clause is what remains

Slice 5 makes ADR-0012's per-call scope check **select something**. Three passages
above now state the opposite of shipped behaviour, and this amendment supersedes
them. They are left standing rather than edited, because each is a dated record of
what a slice could and could not do, and a record that is quietly rewritten stops
being evidence of anything.

**Which passages this supersedes:**

1. The 2026-10-04 amendment's **"Explicitly NOT satisfied"** list — its second
   bullet, *"a guest invite is checked for scope, type and expiry on each call —
   **not implemented.**"* That is now **implemented**, and the bullet's own
   prediction ("the repo axis arrives with the preview surface (slice 5)") is what
   happened. The first bullet, the GitHub-read clause, is **still not implemented**.
2. The same amendment's *"So the honest reading of 'authorized' in M4 slice 2 is: …
   A valid session **currently receives the whole log**, because there is nothing
   yet to scope it by."* — **no longer true.**
3. The slice-3 amendment's §3 *"What 'on each call' does not yet cover"* — *"so a
   guest with a valid invite **currently reads the whole log, exactly as an operator
   does**"* — **no longer true.**

### What "authorized" means now

For a **guest** (`identity_kind = "invite"`), on every authorized request:

1. the session resolves by digest, is unexpired, and its kind is recognised;
2. on a state-changing verb, that session's own CSRF token and
   `application/json`;
3. the invite still exists, is unrevoked, unexpired, and was redeemed in **this**
   browser;
4. **the route NAMES a review, or the request is refused** — `403
   invite-scope-unbounded`. "No scope" is not "no restriction": the absence of a
   scope is now a refusal, never a permission. This is the clause that used to
   run and select nothing;
5. the invite's `repo` and optional `pr` **cover** that review — `403
   invite-scope-mismatch`;
6. the invite's `can_comment` permits what the route writes — `403
   invite-read-only`.

The mechanism: the scope is **in the path** — `<repo>/pr-<n>/api/threads` — so
there is no unscoped spelling to forget and no parameter to tamper with.
`GET /api/threads`, which named no review and could therefore only ever answer
org-wide, is **removed**, not narrowed: it is not a route. The hosted log is
partitioned by that same review (`review_logs(log_key, seq, …)`, required
`D1ThreadStoreOptions.logKey`), so a read cannot cross a review even if the gate
were removed.

**One exemption, named.** `POST /api/session/refresh` names no review because it is
not about one: it rotates the caller's own credential and touches nothing else. It
carries `Route.guestScopeExempt`, the only path that does.

### What is still missing, and where

**The GitHub-read clause.** There is no `TokenSource`; the App is owner-gated
(#34). Slice 4.

**The asymmetry, stated precisely rather than by naming a class that cannot
exist.** `RECOGNISED_IDENTITY_KINDS` is `["operator", "invite"]` — **`github` is
absent from it on purpose** (`src/session.ts`), and a session row re-pointed at
`github` is refused `401 unrecognised-identity-kind`, so the guest path cannot be
reached by asking for a GitHub identity. The scope check runs only under
`if (resolved.principal.kind === "invite")`. **The identity kind that is
org-wide today is therefore `operator`**, which the gate does not scope-check: it
reads whatever `(repo, PR)` the path names, and this build has nothing to check
repo access against. Slice 5 narrowed the **guest** side and deliberately did not
narrow or widen this one — a guest is confined to its invite's scope, and
`operator` remains unscoped until the provider can prove repo access.

**One consequence, stated rather than glossed.** Making the read path-scoped
**removed** the org-wide read rather than narrowing it: an `operator` session now
reads one review per request, by URL. That is the safe direction and it is what a
path-addressed surface means, but nothing in this build can *enumerate* a
deployment's reviews. The GitHub bridge (slice 4) is what will want to, and this
clause — the unimplemented one — is what would authorise it.

### Still deferred

`POST <repo>/pr-<n>/api/threads` is a 501 (the hosted write is slice 4), so no
CSRF-protected review **write** ships and guests still cannot comment. The R2
preview surface is still 501. Fork isolation remains. A repo-wide invite's holder
is redirected to `/`, which is unrecognised — pre-existing, security-neutral, and
recorded in the feature matrix.
