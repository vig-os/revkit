# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- **Shared request handler closes the four Linux-host gaps from the #281 review**
  ([#245](https://github.com/vig-os/revkit/issues/245))
  - **Base-path stripping before routing.** When the guard policy carries a non-empty `basePath` (derived from a
    public origin like `http://review.example.com/review`), the dispatcher now STRIPS the prefix after the gate
    check and routes against the un-prefixed path. The prior shape let a `/review/api/threads` request past the
    gate but no dispatch branch matched it, so it 404'd as static. API, `/events`, assets and the site root all
    serve under the prefix now. Prefix confusion (`/review` vs `/reviewer`, `/reviewapi/*`), a trailing slash and
    an encoded slash (`/review%2Fapi/threads`) stay 404 — the strip keys on exact-or-slash, not `startsWith`.
  - **Base path is a BUILD-TIME + RUNTIME property, NOT a response rewrite** (round-3 falsifier decision,
    replaces the earlier body-rewriter). The round-2 approach regex-rewrote absolute-path references inside
    served HTML and the rail bundle, and the round-3 falsifier showed that a regex cannot tell URLs from data:
    template-literal URLs (`` `/api/threads/${id}/replies` ``) were MISSED, the rail's own `"/"` path normaliser
    was corrupted, prose / JSON / HTML comments got rewritten, and an existing `href="/review"` became
    `/review/review`. The new shape:
    - `revkit build --base /review` sets Astro's `base`, so every page / asset href is emitted PREFIXED at
      build time. The CLI normalises the argument (strips trailing slashes; `/` collapses to empty).
    - The Starlight layout stamps `<meta name="revkit-base" content="/review/">` into the HTML once — the ONE
      well-defined place the base lives in a served page.
    - The rail (and the ask-page bundle) now opens EVERY URL through a single `revkitUrl(path)` helper
      (`packages/cli/src/rail/url.ts`) that resolves `path` against the meta at mount; a missing meta falls
      back to `/` (local daemon, byte-for-byte unchanged behaviour).
    - The daemon strips the prefix before routing (unchanged) and prefixes the two `<script>` / `<link>` tags
      `injectRail` appends (the ONE place the serve path knows a path-aware URL); it NEVER rewrites bodies.
      `prefixAbsolutePaths` is deleted.
    - CSP inline-script hashes stay valid because nothing is rewritten after the build, and the local
      daemon's observable behaviour is unchanged (empty basePath, no meta, identical URLs).
    - A static check (`packages/cli/test/rail/url.test.ts`) refuses any root-absolute `/api`, `/events`,
      `/-/` literal in the built rail bundle outside `revkitUrl`'s own call sites, so a future contributor
      who types `fetch("/api/…")` without going through the helper fails `bun test` rather than a
      reverse-proxied deployment.
  - **Transport peer address flows end-to-end, and fails closed when the transport cannot name a peer.**
    `IdentityResolver.resolve(request, peer?)` carries the peer. The daemon derives it from `Bun.serve`'s
    `requestIP` and passes it on every call. `createAuthProviderIdentityResolver` uses the passed-in peer first
    and falls back to its construction-time function; a call with neither configured refuses closed with
    `no-peer` (401). `StartDaemonOptions.peer` lets the host target override the derivation (unix socket, say).
    Round-3 blocker 3: `peerFor` previously invented `{transport: "tcp", address: "127.0.0.1"}` when
    `requestIP` was `null` — i.e. over a unix socket — which made the dispatcher's own `no-peer` branch
    unreachable and would have silently trusted every socket writer under a `127.0.0.0/8` allowlist. The
    daemon now returns `undefined`, the resolver refuses, and a dispatcher-level test pins the behaviour.
    Unix-socket peer semantics (SO_PEERCRED, listener-level trust) are the follow-up round's job.
  - **401 (missing credential) vs 403 (untrusted peer) propagate.** `identifyActor` now returns the full
    `IdentityResolution` and the five dispatcher call sites surface the resolver's own status onto the response.
    An untrusted peer no longer surfaces as `401 Unauthorized`, which hid a misconfigured allowlist as a
    missing-credential outage; a missing subject header no longer surfaces as `403`. The dispatcher's
    `respondIdentityRefused` is the one place that maps a resolution's `(status, reason)` onto the HTTP body.
  - **CSP derives from the guard policy's public origin, not a loopback port.** `HeaderContext` now takes
    `scriptOrigins` / `connectOrigins` directly (fed from `guardPolicy.cspOrigins`), and `applyResponseHeaders`
    accepts a `scriptPathPrefix` so the CSP's `script-src` paths carry the base path on a sub-path deployment.
    The local daemon's emitted CSP is byte-for-byte unchanged (the loopback policy exposes the two loopback
    aliases and the ws:// twins); the host target's CSP now names the configured origin + its ws(s)://
    twin, so a reverse-proxied reviewer does not have their own CSP refuse the rail bundle.

- **`AuthProvider` interface in `@revkit/review-core`, plus the `none` and `trusted-proxy` providers**
  ([#244](https://github.com/vig-os/revkit/issues/244))
  - Runtime-neutral contract (ADR-0026 §"The auth-provider interface"): `authenticate(AuthRequest) → AuthResult`
    where `AuthRequest` carries method, URL, headers and the transport peer address (`unix` or `tcp` plus the
    connection's IP) and nothing else, and `AuthResult` is either `{ kind: "identity", identity }` or
    `{ kind: "refused", reason: { reason, status } }`. Subjects are namespaced by provider id and compared via
    `identityKey(identity)`, so an identity minted by one provider never merges with another's — the
    `auth-trusted-proxy.test.ts` "identityKey — AC 4" case pins it.
  - `createNoneAuthProvider` mints a self-declared, unverified `comment` identity from a configurable
    display-name header (defaults to `x-revkit-display-name`), with an operator-configurable default name when the
    header is missing. The local and private-VPN targets (#192) use it; this issue adds the interface in
    review-core only and does not rewire the loopback daemon's existing local-actor path, so a later sub-issue of
    #195 is where the daemon's `{ kind: "local", id, displayName? }` author starts being derived from this
    provider's `Identity`.
  - `createTrustedProxyAuthProvider` reads the subject (required), display name (optional) and groups (optional
    and reserved for the later allowed-groups gate) from a configured header set, accepted only from a configured
    trusted peer. Trust is either a unix socket (filesystem permissions are the check) or an IPv4/IPv6 address +
    CIDR allowlist on TCP; the ADR's "not both at once" rule is a construction-time typed union. The peer check is
    the transport peer address of the connection, NEVER `X-Forwarded-For`, and a forged `x-forwarded-for: 127.0.0.1`
    from an untrusted peer is 403 (pinned by `auth-trusted-proxy.test.ts`). An empty peer list throws at
    construction (ADR-0026 §Identity, bullet 5: "no default"), an unparsable address throws at construction (so a
    typo is a startup error rather than a silent fail-closed), and a configured header name that is not an
    RFC 9110 §5.6.2 token throws at construction too — `authenticate()` keeps its "MUST NOT throw" contract.
  - Hardening (round 2): `1.2.3.4::` and other misplaced IPv4-dotted-quad IPv6 literals are refused (RFC 4291
    §2.2.3 — the dotted-quad is the trailing 32 bits, nothing else); zone ids (`%zone`) are refused on both IPv4
    and IPv6 for allowlist entries and peer addresses; IPv4-mapped IPv6 peers (`::ffff:127.0.0.1`) normalise to
    their IPv4 form on both the peer and the rule, so an IPv4 rule matches the mapped peer; a repeated subject or
    display-name header (which `Headers.get()` comma-joins) is refused with 401 `missing-subject`; display-name
    C0/C1 control characters are stripped and the value is capped at 256 code units.
  - Hardening (round 3): shared `auth-internal.ts` holds the one `HEADER_NAME_RE` + `validateHeaderName` the two
    in-core providers reuse, so `none`'s `displayNameHeader` is validated at construction too — a typo like
    `"bad header"` is a startup error rather than a per-request `Headers.get` throw (which would have violated
    `authenticate()`'s MUST-NOT-throw contract). `none` also reuses `sanitiseDisplayName` so C0 / DEL / C1
    control chars are stripped from its runtime header and the value is capped at 256 code units, falling back
    to the configured default if the sanitised result is empty. Zero-length CIDR prefixes (`0.0.0.0/0`, `::/0`,
    and `::ffff:0:0/96` which reinterprets to `/0` in IPv4 space) are refused at construction — a trust-everyone
    rule would defeat ADR-0026 §Identity's fail-closed gate even though the allowlist is nominally non-empty.
    Leading-zero CIDR prefix lengths (`/08`, `/032`) are refused for the same reason the IPv4 octet rule refuses
    `010`: octal ambiguity. The IPv6 parser is simplified to one validation path — the per-group hex regex plus
    the 8-group count subsume the earlier dotted-quad-position and double-`::` guards.
  - `trusted-proxy` holds no state across `authenticate()` calls: ADR-0026's open-question entry on revocation of
    proxy-derived sessions is decided in favour of "re-derive per request". A later change that introduces a
    session for a proxy-derived identity must land session-binding and revocation tests at the same time; today's
    test suite pins the moot-revocation shape so that commitment cannot be forgotten.
  - The daemon's existing loopback-only ADR-0013 guards are UNCHANGED on the loopback listener: this issue adds
    the interface in review-core, and the next sub-issue (#245) composes `trusted-proxy` with a unix-socket
    listener. No daemon call site is rewired here.

### Changed

- **`revkit serve`'s request handler is now composable across deployment targets**
  ([#279](https://github.com/vig-os/revkit/issues/279))
  - Three seams are injected on `startDaemon` and exported from `@revkit/cli/serve`:
    - `GuardPolicy` (`guard-policy.ts`) owns the ADR-0013 Host/Origin/`Sec-Fetch-Site` discipline for the local
      daemon and the ADR-0026 §"Plain Linux host / VM" discipline for the Linux-host target. `createLoopbackGuardPolicy`
      is the default (byte-for-byte unchanged behaviour on `revkit serve`); `createPublicOriginGuardPolicy` is the
      host target's binding (#245 composes it with the unix-socket listener).
    - `RouteGroups` (`route-groups.ts`) selects which paths the handler registers. `LOCAL_DAEMON_ROUTE_GROUPS` keeps
      every route; `HOST_TARGET_ROUTE_GROUPS` disables the agent-only surface (`/-/auth`, `/-/health`, `/-/launch-code`,
      `/-/ask.*`, `/ask/*`, `/api/asks*`, `/api/publish`, `/api/review*`, `/api/delivery-mode`, `/api/handover`,
      `/api/presence`, `/api/delivered`, `/api/pending`, `/events?for=agent`) per ADR-0026 §"Plain Linux host / VM" →
      Authorization. `assertRouteGroupsCompatibleWithPolicy` throws at construction when agent-only groups are enabled
      under a non-loopback policy — a misconfiguration that would have silently exposed the agent bearer flow is a
      startup refusal instead.
    - `IdentityResolver` (`identity-resolver.ts`) turns a request into an `Author` or a refusal.
      `createLocalIdentityResolver` wraps today's `AuthState` (launch-code / session-cookie / agent-bearer flow,
      ADR-0013) and reproduces `identifyActor`'s historical semantics; `createAuthProviderIdentityResolver` adapts the
      ADR-0026 `AuthProvider` for the host target. `createStaticIdentityResolver` is the test seam the AC2 cases use.
  - Local-provider wrap (not the `none` provider) for the local target, justified: today's local flow carries three
    distinct credentials with three distinct lifecycles (launch code → mint session cookie; session cookie →
    cookie-authenticated routes; agent bearer → agent routes + `POST /-/launch-code`). The ADR-0026 `AuthProvider`
    interface returns one identity from headers alone and cannot carry a launch-code exchange that mints a cookie —
    so `createLocalIdentityResolver` keeps the three-credential state behind `AuthState` and projects whichever actor
    each credential already minted in the pre-split daemon.
  - `createLoopbackGuardPolicy({port})` is applied on `revkit serve` unless the caller overrides it.
    `isLoopbackHost` / `isLoopbackOrigin` / `isSecFetchAcceptable` live in `guard-policy.ts` so the loopback
    policy factory and the test suite share a single implementation (#279 round 2, blocker 2). `auth.ts` keeps
    only the credential state (launch code, session cookie, agent token); the request-shape helpers moved.
- **Agent-only route groups return `404` on any non-loopback target**
  ([#279](https://github.com/vig-os/revkit/issues/279))
  - Enforced at the dispatcher's one-shot 404 guard, before the method-sensitive branches that would otherwise answer
    `405 Method Not Allowed`. `test/serve/composable-handler.test.ts` pins this across every agent-only path the host
    target must not expose, and the `/events?for=agent` branch is pinned separately (the query parameter can smuggle
    past a path-only check).
  - `assertRouteGroupsCompatibleWithPolicy` keys on a new `GuardPolicy.allowsAgentRoutes` flag (set only by
    `createLoopbackGuardPolicy`), not on `policy.id === "loopback"` — a bespoke policy that spells its id
    `"loopback"` cannot reach the agent surface. A regression test pins the spoofed-id refusal.
- **`/api/events-head` now flows through the injected `IdentityResolver`** ([#279](https://github.com/vig-os/revkit/issues/279))
  - Round 1 left `handleEventsHeadApi` on the direct `auth.hasSession` / agent-bearer path. The rail fetches
    the events tip BEFORE opening `/events`, so a proxied reviewer on the host target would have lost its
    resume point. The handler now calls `identifyActor` like every other shared route. The
    "shared routes remain reachable" test asserts exact `200` statuses (not `!= 404`) so the regression is
    caught the moment it reappears.
- **`hasValidBearer` is forced false on any non-loopback target** ([#279](https://github.com/vig-os/revkit/issues/279))
  - Even though no agent routes exist on the host target, a client that submits a bearer value under a shared
    route (threads, events-head, `/events`) must not reap the bearer branch's origin leniency. A single
    `hasValidAgentBearerFor` helper gates the inline check on `routeGroups.agentEvents`; a regression test
    sends a `Bearer any-value` on a cross-origin POST and asserts `403`.
- **Host guard policy carries the deployment's base path** ([#279](https://github.com/vig-os/revkit/issues/279))
  - `createPublicOriginGuardPolicy` derives `basePath` from the configured public origin's pathname. The
    dispatcher 404s any request whose pathname is neither the base path nor starts with `basePath + "/"`
    (ADR-0026 §"Plain Linux host / VM"; #195 implementation scope then adds sub-path routing inside the
    prefix). The loopback policy's `basePath` is `""` so `revkit serve` is unchanged.
- **Local `request.rejected.origin` log shape restored** ([#279](https://github.com/vig-os/revkit/issues/279))
  - Round 1 drifted into `{ requestId, origin: "", reason: "sfs=…" }` for cross-origin POSTs. Restored to
    the pre-refactor shape: `{ requestId, origin }` when `Origin` is present, `{ requestId, reason }` when
    it is absent — a byte-for-byte match against `dev` on the local path.

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

- Invite display names reject controls, malformed Unicode, bidi overrides and
  names without visible content before D1, returning the documented refusal
  without consuming the invite's browser slot. The cap counts Unicode code points,
  and duplicate redemption fields are refused ([#145](https://github.com/vig-os/revkit/issues/145)).
