# ADR-0026: Deployment targets and pluggable auth

- Status: Accepted
- Date: 2026-11-09
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: D2, D3, D4, D5, B5
- Amends: [ADR-0008](0008-hosting-one-worker-per-org.md), [ADR-0013](0013-local-daemon-security.md)
- Supersedes (in part): [ADR-0009](0009-auth-github-app-invite-links.md) — the Authentik clause, and the framing of invite links as the one guest-auth mechanism; the GitHub App stays
- Supersedes (in part): [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md) §6 — GitHub App OAuth as the hosted site's access control, and the Authentik follow-up

## Context

revkit's hosted surface targets one platform, and its auth is welded to that platform's shape.
ADR-0008 hosts one Cloudflare Worker per org.
ADR-0009 authenticates guests with self-minted invite links, comments through a GitHub App, and defers OIDC to a follow-up (#4).
ADR-0013 binds the local daemon to `127.0.0.1` and refuses any other `Host`.
Three needs do not fit that shape.
A team that can only run software on a stock Linux host or VM has no supported way to run revkit there (#195).
A reviewer on another machine of the same private VPN has no supported way to open a review page served by an agent's daemon (#192).
Ad-hoc workarounds for the second (port forwards, reverse proxies, patched bind addresses) each weaken ADR-0013 in an undocumented way.
revkit must stay general: no target, identity provider or deployment is special-cased in core.
This ADR records the owner's decided target matrix and the auth model that spans it.
It does not implement any target.

## Decision

### Four targets

| Target | Trust boundary | Auth provider(s) | State backend | What the backend still enforces |
|---|---|---|---|---|
| **local** (default) | The loopback interface of the user's machine | `none` + ADR-0013 launch code and session cookie; agent bearer token | `bun:sqlite` under `.revkit/` | `Host` and `Origin` checks, `Sec-Fetch-Site`, CSRF on writes, CSP and hygiene headers (ADR-0013, unchanged) |
| **private VPN** (opt-in, #192) | The VPN: only peers on the private network can reach the bind address | `none`: no identity beyond a self-declared display name | `bun:sqlite` under `.revkit/` (same as local) | Exact `Host` allowlist, `Origin` allowlist on writes and upgrades, `Sec-Fetch-Site`, CSRF, CSP; agent endpoints stay on the loopback listener only |
| **plain Linux host / VM** (#195) | The reverse proxy and the auth proxy in front of it, reached over a permission-restricted unix socket | `trusted-proxy` headers | SQLite file via the same store contract | Socket permissions or peer-address allowlist, fail-closed identity headers, `Host` and `Origin` checks, CSRF, CSP |
| **Cloudflare** | The internet; Cloudflare is the only internet-facing surface | `cloudflare-access` or `site-token` (optional Turnstile on token redemption) | D1, R2, Durable Objects (ADR-0008) | Everything in ADR-0012 and the amended ADR-0009 |

revkit is one codebase behind these targets.
Only the auth provider and the state binding differ, and both sit behind interfaces.
No other platform is supported as an internet-facing surface.

### The auth-provider interface

An auth provider turns one request into an identity or a refusal.
The contract is deliberately small and runtime-neutral, so it runs unchanged in Bun and in a Worker.

```ts
interface AuthProvider {
  readonly id: string;
  authenticate(request: AuthRequest): Promise<AuthResult>;
}
type AuthResult =
  | { kind: "identity"; identity: Identity }
  | { kind: "refused"; reason: AuthRefusal };
interface Identity {
  readonly provider: string;
  readonly subject: string;       // stable id from the provider; never an email-derived merge key
  readonly displayName: string;   // display data only
  readonly capability: "view" | "comment";
}
```

`AuthRequest` carries the method, URL, headers and the transport peer address, and nothing else.
Rules that hold for every provider:

- A provider that cannot positively establish an identity refuses.
  There is no anonymous fallthrough to a more permissive provider.
- Exactly one provider is configured per deployment.
  Composition of several providers at once is out of scope until a story needs it.
- A subject is namespaced by provider.
  Identities from two providers are never merged, not by display name and not by email.
- The identity feeds the existing attribution rules: a non-GitHub identity is mirrored to GitHub as "Name (guest)" and cannot count as an approval (ADR-0009, unchanged).
- Authorization stays what it is today: a `view` identity cannot write, a `comment` identity can.
  This ADR adds no role system.

Providers in core:

- **`none`.** Used by the local and VPN targets, where the network is the boundary.
  It issues a session for a self-declared display name, shown as unverified.
- **`trusted-proxy`.** Reads identity from a configured set of request headers, only from configured peer addresses.
  Detailed below.
- **`site-token`.** The per-site token provider.
  It is ADR-0009's invite link, renamed and generalised.
  Detailed below.
- **`cloudflare-access`.** Verifies the Cloudflare Access JWT assertion against the team's published keys and the application audience.
  It never trusts a plain identity header on its own.

Extension points, not core:

- **Turnstile** is an optional challenge in front of `site-token` redemption, not an identity provider.
- **Passkeys** are a possible later provider behind the same interface.
- **Reviewer-email mapping.** A deployment may keep reviewer emails encrypted at rest and map each to a per-site token it hands out out-of-band.
  Core stores only the token's hash for this mapping and offers a hook for it.
  The optional, notification-only guest email of ADR-0015 is a separate column and is unchanged; it is never an identity or a merge key.
- **Email or magic-link sign-in is not built in core.**
  A deployment that wants it implements `AuthProvider` outside core.
  Mail delivery, bounce handling, link-scanner prefetch and account recovery are a product of their own, and revkit does not want to own them.

Security is deliberately kept proportionate.
The review content is documents, the threat model is ADR-0012 and ADR-0013, and this ADR adds no further mechanism than the providers above.

### Private VPN mode

Default behaviour is unchanged: loopback only.
VPN mode is an explicit, per-start opt-in on `revkit serve`.
Flag names below are indicative.
The implementation issue (#192) fixes them.

- **Opt-in.** `--remote-bind <address>` and one or more `--allow-host <host[:port]>`.
  Neither flag has an environment-variable or config-file default that could switch it on silently.
- **Bind address.** One concrete interface address.
  A wildcard address (`0.0.0.0`, `::`) is refused at startup.
  A warning for a non-private address is possible implementation scope for #192, not a decision of this ADR.
- **Dual listen.** The daemon keeps its loopback listener and adds the opt-in address, with one request handler.
  The CLI and the MCP server keep talking to the loopback address.
- **The listener decides, never `Host`.** Every loopback-only decision is made by which listener accepted the connection.
  That covers the agent routes, the launch-code exemption and the `localhost` canonicalisation redirect.
  A request on the remote listener that carries `Host: 127.0.0.1:<port>` is treated as a remote request, and it gets no loopback privilege.
- **Host allowlist.** On the remote listener the `Host` header must exactly match an `--allow-host` entry, and loopback aliases are not in that allowlist.
  Anything else is `421`, as today.
  On the loopback listener the ADR-0013 rule is unchanged, including the `localhost` canonicalisation redirect.
- **Origin and CSRF.** A write or a WebSocket upgrade must carry an `Origin` equal to an allowlisted origin.
  `Sec-Fetch-Site: cross-site` is refused.
  The session cookie stays `HttpOnly; SameSite=Strict`.
  It cannot carry the `__Host-` prefix over plain `http`.
  `Secure` is explicit configuration of the opt-in (for example `--remote-secure-cookie`), because the daemon cannot detect TLS termination in front of it.
- **CSP.** On the remote listener the `script-src`, `worker-src` and `connect-src` origins of the ADR-0013 CSP amendment name the allowlisted origin (and its `ws://` or `wss://` twin) in place of the loopback aliases.
  The loopback listener keeps its loopback origins.
- **Agent endpoints.** The per-start agent bearer token, `/api/*` agent routes and `/events?for=agent` are served on the loopback listener only.
  A VPN peer never reaches them, even with the token.
- **Launch code.** The launch code of ADR-0013 is not required for a peer on the remote listener, because the VPN is the boundary and the code could not be delivered to the remote reviewer without a side channel.
  The launch code remains mandatory on the loopback listener.
- **Discovery.** Ports stay random per repo, and `.revkit/serve.json` gains the advertised remote origin.
  `ensureDaemon` auto-start always starts loopback-only and never enables remote mode.
  When a remote-mode daemon already holds the lock, `findRunningDaemon` returns it and the MCP uses its loopback address.
  A fixed `--port` with fail-fast on collision, for an operator who needs a stable URL, is possible implementation scope for #192, not a decision of this ADR.
  A hostname or URL that stays stable across restarts is the VPN's job (for example a stable device name), not revkit's.
- **Tests.** Non-allowlisted `Host` is refused, non-allowlisted `Origin` is refused on writes and upgrades, allowlisted access works, the wildcard bind is refused, and the agent routes are `404` on the remote listener.
  A forged `Host: 127.0.0.1:<port>` on the remote listener also gets `404` on the agent routes and no launch-code exemption.

### Plain Linux host / VM

- **Shape.** A static build of the site plus one self-contained backend executable, produced by `bun build --compile`.
  The host needs no runtime toolchain and no root.
  The backend runs as an unprivileged user process under a user-level supervisor (for example a `systemd --user` unit).
- **Network.** The backend listens on a unix socket and is reached through an Apache or nginx reverse proxy, on a vhost or a sub-path.
  The socket is the default and its permissions are restrictive: owner read/write plus the proxy's group, and no access for anyone else.
  Loopback TCP is an explicitly documented single-tenant option only, because every local account can reach a loopback port.
  Base-path support for a sub-path deployment is #195 implementation scope.
- **Identity.** Verified identity comes only from the `trusted-proxy` provider:
  - The deployment configures the header names for subject (required), display name and optionally groups, and the trusted unix socket or, for the single-tenant option, a list of trusted peer addresses or CIDR ranges.
  - On TCP the check uses the transport peer address of the connection, never `X-Forwarded-For`.
  On the unix socket the filesystem permissions are the check.
  - A request from a peer outside the list is refused with `403` even if it carries the headers, so a forged header from an untrusted address never reaches the identity step.
  - A request from a trusted peer without the subject header is refused with `401`.
  - A missing or empty trusted-peer list refuses every request; there is no default.
  - The proxy must strip client-supplied copies of those headers before setting its own; the deployment guide says so with Apache and nginx examples.
- **Authorization.** An optional allowed-groups gate is possible #195 implementation scope.
  Without it, any authenticated identity may comment.
- **Request checks.** The `Host` allowlist, the `Origin` check on writes and the CSP of ADR-0012 apply as on the other targets, against the configured public origin.
- **State.** The SQLite store behind the review-core store contract, in a file the process owns.
- **Delivery.** The deployment guide (generic Apache and nginx examples, a user-unit example, upgrade and rollback by swapping the executable and the static directory) and an end-to-end test are acceptance criteria of #195, not of this ADR.

### Cloudflare

- ADR-0008 stands for this target: one Worker per org with R2, D1 and Durable Objects.
- The two supported access modes are Cloudflare Access (any identity provider the account has configured) via the `cloudflare-access` provider, and per-site tokens via `site-token`.
- Turnstile is optional and gates only token redemption.
- Cloudflare remains the only internet-facing surface.
  A Linux-host deployment that wants internet exposure puts its own access control in front, and revkit does not claim to harden that.

### What changes in ADR-0008, ADR-0009 and ADR-0013

**ADR-0008 (amended).**
"One Cloudflare Worker per org" becomes the Cloudflare target of the matrix, not the only hosting model.
`revkit deploy init|enable|status|destroy` remains the Cloudflare target's tool and gains no meaning for the other targets.
The GitHub Pages sentence is unchanged.

**ADR-0009 (superseded in part).**
- *GitHub App user-to-server tokens* stay.
  They are the `TokenSource` of the GitHub comment backend and of PR previews (as ADR-0025 already amended), and they are not an identity provider for the other targets.
  The per-user App OAuth flow is kept as a token-linking step for the GitHub comment backend: it is how a reviewer's user-to-server token is obtained so that comments post as that reviewer (B2, B3).
  It is not site access control.
- *Invite links* become the `site-token` provider.
  The share types (`personal`, `team`, `view`), hashing at rest, scoping, expiry, revocation, the per-browser binding cookie and the `max_browsers` bounds from the 2026-10-04 amendment are unchanged.
  What changes is the framing: a per-site token is one provider among several, not the one guest-auth mechanism.
- *Authentik OIDC (#4)* is superseded.
  revkit does not become an OIDC relying party in core.
  An organisation that runs OIDC puts it behind Cloudflare Access or behind a proxy on the Linux-host target.
  This ADR supersedes the Authentik direction, and the architect closes #4 after this ADR merges.
  The account-switching note of #4 survives as the rule that identities from two providers are never merged.
- *Guest attribution* ("Name (guest)", cannot approve) is unchanged and now applies to every identity that has not linked a GitHub token.

**DESIGN-0001 §6 (superseded in part).**
Site access is decided by the target's auth provider (none, trusted-proxy, site-token, Cloudflare Access), not by GitHub App OAuth.
The clause "GitHub App OAuth ... session is valid if the user has read access to the repo" no longer defines site access.
Repository read access remains a check when a reviewer links a GitHub token for the comment backend.
The Authentik follow-up is dropped.

**ADR-0013 (amended).**
The sentences "Bind **127.0.0.1 only**" and "Nothing listens on a public interface" are narrowed to the default.
VPN mode, as defined above, is the single supported exception.
The `Host` and `Origin` rules, the launch code, the agent token, the canonicalisation and the CSP are unchanged on the loopback listener.

## Consequences

- One review core and one set of store contracts serve four targets.
  A new target is a new binding plus, at most, a new provider.
- The feature matrix gains stories D3 (Linux host), D4 (VPN mode) and D5 (pluggable auth), all `planned`.
- `trusted-proxy` moves the whole authentication problem to the proxy.
  If the proxy does not strip client-supplied identity headers, or the trusted-peer list is too wide, the identity is forgeable.
  revkit cannot verify that from inside, so the deployment guide and an end-to-end test (bypass and forged-header cases) are the control.
- On a shared host, any local account can connect to a loopback port and forge the identity headers.
  That is why the unix socket with restrictive permissions is the default and loopback TCP is documented as single-tenant only.
  The end-to-end test includes a forged-header request from a second local user, and it must be refused.
- VPN mode has no identity.
  Every peer on the VPN is trusted equally, and the display name is self-declared.
  A VPN with many unrelated members is the wrong place for it; the Linux-host target with a proxy is the answer there.
- Dual listening and the agent-routes-on-loopback-only rule are new code paths in the daemon.
  Each needs a negative test, since a mistake exposes the agent token surface to the network.
- Dropping OIDC from core narrows what the Worker can do by itself.
  Organisations that relied on the Authentik plan in DESIGN-0001 §6 must use Cloudflare Access or a proxy instead.
- Because the state sits behind the review-core store contracts, the comment backend (local file or SQLite, GitHub PR) can change independently (#193).
  This ADR neither designs that interface nor constrains it.
- **Feasibility probe for the single executable** (evidence, not shipped code).
  Run on 2026-11-09 with Bun 1.3.13 on x86_64 Linux, from `packages/cli` of this branch:
  - `bun build --compile bin/revkit.js --outfile <scratch>/revkit-bin` exited `0` in about 2.8 s, bundling 2312 modules into a 121,448,768-byte (about 116 MiB) executable.
  - The build printed one warning from a bundled MDX dependency (`Unsupported JSX runtime`), which shows that the authoring toolchain is pulled into the executable.
  - `revkit-bin --help` exited `0`.
  - With a minimal workspace root (a `package.json` named `revkit`) and a one-page static directory, `revkit-bin serve --dir dist` started and listened on a random loopback port with no SQLite error logged.
    `GET /-/health` returned `200` and a request with a foreign `Host` returned `421`.
  - `GET /-/rail.js` returned `500` (`rail.build.failed`): the daemon builds the rail bundle on demand from the CLI's source tree, which a compiled executable does not carry.
  - Blockers for the Linux-host executable, therefore: (1) the rail and ask-page bundles must be prebuilt and embedded as assets, not built at request time; (2) `serve` requires a revkit workspace root, and the host has none; (3) the executable should be a dedicated server entrypoint rather than the whole CLI, so the MDX and Astro authoring toolchain is not shipped.
  - The static site itself is built in CI and shipped as a directory; `revkit build` needs the toolchain and does not run on the host.
- The compiled executable is platform-specific.
  Each supported host architecture needs its own build in CI.

## Alternatives considered

- **Cloudflare only.** Rejected by the owner.
  It excludes teams that can only run on a Linux host or a private network.
- **A self-hosted OIDC relying party in core** (the Authentik plan of ADR-0009).
  Rejected.
  It duplicates what Cloudflare Access and auth proxies already do, and it makes revkit own session, key-rotation and logout behaviour for every provider.
- **Self-rolled email or magic-link auth in core.** Rejected.
  Delivery, scanner prefetch, abuse and recovery are a product.
  It stays an extension point.
- **Trusting identity headers from any peer on a private network.** Rejected.
  One reachable host can forge any identity.
  The peer-address allowlist plus fail-closed is the minimum.
- **A wildcard bind plus an allowlist for VPN mode.** Rejected.
  It would also expose the daemon on every other interface of the machine.
- **Running VPN mode through `trusted-proxy` only.** Rejected for the VPN target.
  It forces a proxy on a setup whose point is that the VPN is the boundary.
  The Linux-host target remains available when a proxy is wanted.
- **Auto-enabling remote mode from `ensureDaemon`.** Rejected.
  An agent process must not be able to widen the network exposure of a human's daemon.
- **A second runtime (Rust) for the backend.** Rejected for now.
  TypeScript with SQLite (D1 on Cloudflare) behind the existing store contracts keeps one language and one test stack.

## Open questions

- **Dual-listener mechanism.** Whether `Bun.serve` can host the loopback and remote listeners in one server or needs two servers sharing a handler.
  The implementation issue for #192 decides and records it.
- **Rail and ask-page asset embedding.** `bun build --compile` supports embedding files.
  Whether the existing on-demand bundler can run at release time and produce embedded assets without a second build path is for the implementation of #195.
- **Executable size.** About 116 MiB is acceptable for a host deployment but large for a download; a dedicated server entrypoint should shrink it.
  The target is unmeasured.
- **Native SQLite in the executable.** The probe logged no SQLite error, but no write or restart test was run on the compiled binary.
  The #195 end-to-end test covers it.
- **Header names and groups.** The set of trusted headers is configured, not defaulted.
  Whether one documented preset per common proxy is worth shipping is left to the deployment guide.
- **Multi-provider composition.** A deployment that wants `site-token` for guests behind `trusted-proxy` for staff needs ordered composition.
  No story needs it yet.
- **Revocation of proxy-derived sessions.** Whether a `trusted-proxy` identity gets a revkit session at all, or is re-derived per request, is left to the implementation.
  Re-deriving per request is the safer default because it needs no revocation.
