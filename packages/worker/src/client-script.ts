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
// with every bundler the Worker might be built by. Measured on this box, no
// Cloudflare endpoint contacted and `wrangler` not invoked:
//
//   - `Bun.build` (what `test/harness.ts` uses to build the artefact the tests
//     run) — esbuild 0.28.2 — DOES support `with { type: "text" }` and inlines
//     the file.
//   - rolldown 1.2.11 does NOT. It resolves the `.js` as a JavaScript module and
//     never reads the attribute: a payload that is valid text but invalid JS
//     fails with `[PARSE_ERROR]`, and one that is valid JS without a default
//     export fails with `MISSING_EXPORT: "default" is not exported`. Same root
//     cause, different payload.
//
// That is the same shape as the shipped 415 defect this file's neighbours
// document — green under `bun test`, unusable in a browser — except that one
// reached production and this one is being headed off. The general form is the
// hazard: a mechanism the test bundler honours and a deploy bundler does not is
// invisible here, because #84 — nothing bundles this Worker with a second
// bundler — is not fixed.
//
// **Correction to what this comment used to say, found while filing #84.** It
// claimed rolldown 1.0.0-beta.44 "is what wrangler 4.93.0 bundles a Worker
// with". That is wrong: wrangler 4.93.0's own `package.json` declares
// `esbuild` and no rolldown, its shipped code contains no reference to rolldown
// at all, and its `node_modules` carries esbuild only. So today's deploy bundler
// would honour the attribute, and the divergence above is a hazard against a
// bundler Cloudflare may move to rather than the one in use. **A load-bearing
// claim sat in this file unverified for a whole slice precisely because nothing
// in this repo bundles the Worker with a second bundler** — that is issue #84,
// and it is the reason to distrust this paragraph rather than the reason to
// trust it.
//
// So the source lives here, in a template literal. There is no build step, no
// generated artefact and no second copy of the bytes: the string below IS what
// the Worker serves, IS what the content hash is taken over, and IS what the
// tests execute. Drift is not possible because there is nothing to drift
// between.
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
 * **The rewrite target is the PREFIX, not a slice of the path, and that is the
 * one line the review changed.** This used to cut at `path.lastIndexOf("/")`
 * and rewrite to `path.slice(0, cut + 1)`, which is "cut the LAST path
 * segment". On `/invite/<token>/` the last slash is the one AFTER the token, so
 * the slice reproduced the whole path and the rewrite was a NO-OP — measured,
 * before the fix:
 *
 *     /invite/<token>       ->  /invite/            stripped
 *     /invite/<token>/      ->  /invite/<token>/     NO-OP, token kept
 *     /invite/<token>/x     ->  /invite/<token>/     stripped
 *     /invite/<token>/utm   ->  /invite/<token>/     looks stripped, is not
 *
 * and a trailing slash is not exotic — mail security products append one, and a
 * guest typing it is not a stretch. Both spellings land on the closed page,
 * whose 410 still loads this script, so the token survived in the address bar of
 * exactly the visit a guest is most likely to back out of and screenshot.
 *
 * `replaceState(null, "", prefix)` cannot have that failure mode: the target is
 * a CONSTANT, so no input produces a URL naming the token, whatever follows it.
 * The `cut` guard that went with the slice was dead — with the prefix check
 * below passed, the path already begins with `/invite/`, so a `/` exists at
 * `prefix.length - 1` and `cut < prefix.length - 1` is never true — so it is
 * gone rather than left in as a no-op that reads like a control.
 *
 * **The query string and the fragment are dropped, not carried across.** A query
 * string is the most durable part of a URL — history, `Referer`, server logs,
 * browser sync — which is the same argument `src/invite-page.ts` uses to keep
 * `?name=` off the `GET`. Preserving one would preserve a token in it the moment
 * any mail client or analytics wrapper put one there. Dropping them is now a
 * property of the rewrite target rather than of a slice: `prefix` contains no
 * `?` and no `#` by construction.
 *
 * **The prefix check is load-bearing, not politeness.** Rewriting to the prefix
 * is only correct ON an invite-open URL. Loaded on a preview path it would send
 * `/acme/pr-7/` to `/invite/`, which is a different page; the prefix check is
 * what makes the script safe to reference from a second page later.
 * `indexOf(prefix) !== 0` rather than `startsWith` is deliberate only in that it
 * is ES1 and cannot itself be the thing that is missing.
 */
export const INVITE_CLIENT_SCRIPT = String.raw`(function () {
  "use strict";
  var prefix = "${INVITE_OPEN_PREFIX}";
  var path = window.location.pathname;
  if (path.indexOf(prefix) !== 0) return;
  window.history.replaceState(null, "", prefix);
})();
`;
