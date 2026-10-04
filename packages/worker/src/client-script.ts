// The ONE script the hosted Worker serves, as source text.
//
// M4 slice 5b. Until this module existed the Worker served no script at all:
// `default-src 'none'` with nothing to allow, and `script-src` naming a path —
// `/_revkit/<version>/` — that resolved to a 404. This is what replaces that.
//
// ── Why the source is a STRING here and not a `.js` file next door ─────────
//
// The obvious shape is a committed `client/invite.js` imported for its text. It
// is the shape this codebase would reach for, and it does not survive contact
// with the deploy bundler. Measured on this box, both bundlers the Worker is
// built by, no Cloudflare endpoint contacted:
//
//   - `Bun.build` (what `test/harness.ts` uses to build the artefact the tests
//     run) — esbuild 0.28.2 — DOES support `with { type: "text" }` and inlines
//     the file.
//   - `rolldown` 1.0.0-beta.44, which is what wrangler 4.93.0 bundles a Worker
//     with — does NOT. It resolves the `.js` as a JavaScript module and fails
//     with `MISSING_EXPORT: "default" is not exported by "client/invite.js"`.
//
// So the text import is a mechanism that is green under `bun test` and broken
// under `wrangler deploy`, which is the exact shape of the shipped 415 defect
// this file's neighbours document: the page rendered, every test passed, and the
// flow was unusable in a browser. `with { type: "json" }` — the mechanism the
// inline-script allowlist already uses at `src/index.ts` — works in BOTH, and
// a `.json` carrier would mean a committed, JSON-escaped blob of hand-maintained
// JavaScript, which is unreviewable.
//
// So the source lives here, in a template literal, and that is the whole reason.
// There is no build step, no generated artefact and no second copy of the bytes:
// the string below IS what the Worker serves, IS what the content hash is taken
// over, and IS what the tests execute. Drift is not possible because there is
// nothing to drift between.
//
// ── Why `String.raw`, and what that buys ───────────────────────────────────
//
// `String.raw` keeps the text exactly as written, so the served bytes are
// reviewable as JavaScript rather than as an escape sequence — which is the
// property a hand-escaped blob would have lost. The one substitution is the
// invite prefix, imported from `src/authz.ts` rather than spelled out: the
// script's guard and the route's grammar must be the same string, and a literal
// in a browser script is exactly the kind of copy that drifts from the route it
// is supposed to agree with.
//
// **The two characters this module must never contain in its OUTPUT** are the
// backtick and `${`, because either one would end the template literal early or
// survive into the served bytes. Neither can: the only `${` is the
// substitution above, and no backtick appears. `test/invites.test.ts` asserts
// both against the SERVED bytes, so the invariant is a test rather than a
// claim — which is what lets the next person edit this file without having to
// re-derive the hazard.
//
// ── What the script does, and why it is only that ──────────────────────────
//
// It takes the invite token out of the address bar, by replacing the current
// history entry with the token-free prefix of the path it is already on. That
// is the whole job, and the smallness is the security property: the page has no
// other script, so there is no other thing running in the reviewer's origin.
//
// **It runs on load, before the exchange, and that is a decision with a cost.**
// The token is also in the form's hidden field, so once the document has loaded
// the URL is not needed for anything — stripping immediately costs the
// redemption nothing, whereas stripping after the exchange would leave the token
// in history for as long as the guest sat on the page, and for ever if they
// never submitted. The cost of on-load is that a guest who RELOADS before
// submitting has lost the URL and must re-open the mail link; that is
// recoverable, because slice 3 made a second open REUSE the browser binding
// rather than rotate it, so a live session is not invalidated by the trip. Both
// halves are pinned in `test/invites.test.ts`.
//
// **What it deliberately does not do.** It does not read `document.cookie`, so
// it cannot see the session or the browser binding (both `HttpOnly`); it does
// not touch `localStorage` or `sessionStorage`, so it leaves nothing behind for
// the next script on the origin to read; it makes no request at all, so it has
// no channel to exfiltrate the display name the guest typed; and it does not
// read or store a CSRF token, because this page has no state-changing call that
// needs one — see `src/invite-page.ts`'s note on the CSRF question and the
// ADR-0012 amendment proposed with this slice. `test/invites.test.ts` pins
// every one of those absences by name, so adding a channel is a deliberate edit
// to a list rather than a silent widening.
//
// **It touches exactly one global**, `window`, and reads two of its properties.
// That is what makes it executable against a stub with no `document`, no
// `location` and no `fetch` — which is how the tests run the real bytes.

import { INVITE_OPEN_PREFIX } from "./authz.ts";

/**
 * The script the Worker serves from `/_revkit/<version>/invite-<digest>.js`.
 *
 * **`replaceState`, and the assertion that matters.** `pushState` of the clean
 * URL would leave `/invite/<token>` as the PREVIOUS entry: one Back press, and
 * the token is back in the address bar and in this tab's session history.
 * `replaceState` overwrites the current entry, so after this runs no history
 * entry anywhere names the token — not the one a reload returns to, and not the
 * one a Back press returns to.
 *
 * **The query string and the fragment are dropped, not carried across.** A query
 * string is the most durable part of a URL — history, `Referer`, server logs,
 * browser sync — which is the same argument `src/invite-page.ts` uses to keep
 * `?name=` off the `GET`. Preserving one would preserve a token in it the moment
 * any mail client or analytics wrapper put one there.
 *
 * **The guard is load-bearing, not politeness.** "Cut the last path segment" is
 * only correct under `/invite/`. Loaded on a preview path it would rewrite
 * `/acme/pr-7/` to `/acme/`, which is a different page; the prefix check is what
 * makes the script safe to reference from a second page later. `indexOf(prefix)
 * !== 0` rather than `startsWith` is deliberate only in that it is ES1 and
 * cannot itself be the thing that is missing.
 */
export const INVITE_CLIENT_SCRIPT = String.raw`(function () {
  "use strict";
  var prefix = "${INVITE_OPEN_PREFIX}";
  var path = window.location.pathname;
  if (path.indexOf(prefix) !== 0) return;
  var cut = path.lastIndexOf("/");
  if (cut < prefix.length - 1) return;
  window.history.replaceState(null, "", path.slice(0, cut + 1));
})();
`;
