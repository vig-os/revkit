# ADR-0009: Auth: GitHub App user-to-server, invite links, Authentik later

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: B2, B3, B5
- Amended by: [ADR-0025](0025-hybrid-review-one-core.md) — the GitHub App is the **hosted** surface's `TokenSource`;
  the local `revkit review` surface uses the reviewer's own `gh auth token` and needs no App.

## Context

Comments must post as the reviewer (B2, B3); non-GitHub reviewers need access (B5).

## Decision

A **GitHub App** with user-to-server tokens (`pull_requests: write`, `contents: read`). Guests use **self-minted
per-person invite links** (random token, stored hashed, scoped to repo/PR, expiring, revocable, exchanged for an
HttpOnly session). Guest comments are mirrored via the App as "Name (guest)" and cannot count as GitHub approvals.
Authentik OIDC is a follow-up (#4).

## Consequences

Invite minting requires write access.

## Acceptance (2026-09-29)

- **Share types** (`revkit invite --type`): `personal` is the default (14 days, bound to the first browser that opens
  it, can comment); `team` (30 days, several browsers, can comment) and `view` (30 days, several browsers, read-only)
  are opt-in. All are revocable and scoped to the repo, optionally one PR.
- Guest data per ADR-0015. App webhook events: `installation`, `installation_repositories`, `pull_request`,
  `pull_request_review`, `pull_request_review_comment`, `issue_comment`.

## Amendment (2026-10-04, issue #9) — what "exchanged for a session" means, and
## what "several browsers" is a number

The Acceptance above is implemented in `packages/worker/src/invites.ts`. Two of
its phrases admitted more than one reading, and a slice that picks a reading
without recording it is how an ADR stops describing the code.

**"Bound to the first browser that opens it" is a `__Host-` cookie, and it is
bound on the OPEN.** The binding cookie is 256 bits of `crypto.getRandomValues`,
stored only as a digest, and is minted by the response to `GET /invite/<token>` —
so the browser that opened the link is the browser that holds the binding before
anyone can redeem it. An IP address is not a browser (one office NAT or one
carrier CGNAT is many browsers, and it is trivially shared), and a user-agent
string is forgeable attacker-controlled text on every request. The cookie
identifies a browser *profile*, which is what the property is about.

What it stops: an invite forwarded to a second person (that browser finds the
slot spent) and a session cookie copied out of one profile and replayed from
another (refused on every call). What it does **not** stop: an attacker who
steals the profile itself, an XSS on any same-origin page, a guest handing over
their own unlocked device, or a guest who *is* the second browser the owner meant
to exclude. It bounds sharing; it does not authenticate anybody — which is
precisely why Authentik (#4) is the follow-up.

**"Exchanged for an HttpOnly session" means one exchange PER BROWSER, bounded by
`max_browsers`.** A single-exchange-per-token reading cannot express `team` and
`view` at all, and it is the negative-test list that settles it: "already-redeemed
(replay)", "a second browser on a `personal` invite" and "`max_browsers`
exceeded" are three *distinct* refusals, so a token cannot have a single
redemption moment. So:

| share type | lifetime | browsers | comment |
|---|---|---|---|
| `personal` (default) | 14 days | **1** | yes |
| `team` | 30 days | 10 | yes |
| `view` | 30 days | 10 | **no** |

`personal`'s one browser IS "bound to the first browser that opens it". The other
two numbers are bounded deliberately — a leaked `team` link admits at most ten
browsers rather than an unbounded set — and are one constant each. A token is
therefore never usable by an unbounded number of browsers, which is the property
"single use" protects.

**The residual risk, stated rather than implied.** A bearer token has no
identity in it: a leaked `personal` link admits whichever browser redeems it
*first*. ADR-0009's one-browser rule bounds that; it does not remove it, and no
mechanism in this ADR can, because the only thing the recipient has is the link.
**Revocation is what closes it**, and revocation here is immediate: a session
already in a cookie jar dies on its next request, because the invite is re-read
per request rather than trusted from issuance (ADR-0012's amendment dated
2026-10-04).

**What is NOT implemented, so the Acceptance is not read as met.** The mirror —
"Guest comments are mirrored via the App as `Name (guest)`" — needs the App and
a hosted write path, both owner-gated (#34) and slice 4's; and
`POST /api/threads` is a deliberate 501, so a guest cannot yet comment at all,
which is the difference between `view` and the other two being observable in the
product. `revkit invite --type` is not a CLI command: minting has no HTTP route,
so the minting caller is whoever holds write access to D1 (`revkit deploy init`,
slice 8).
