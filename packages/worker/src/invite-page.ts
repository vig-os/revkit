// The two HTML pages the invite surface serves: the display-name form a guest
// sees after opening a link, and the pages that say the link is dead or the
// caller is over the limit.
//
// ── This is the first HTML the Worker serves, and it is why it is so plain ──
//
// ADR-0012's policy applies to every HTML response, and it is brutal:
// `default-src 'none'`, `script-src` naming only `/_revkit/<version>/` plus a
// committed hash allowlist, `form-action 'self'`. This page satisfies all of
// that by allowing exactly ONE thing: one external, versioned,
// content-hashed script from `/_revkit/<version>/` (`src/client-asset.ts`), and
// nothing else. No inline `<script>`, no `<style>`, no inline handler, no
// `javascript:` URL, no `<link>`, no `<iframe>`.
//
// **That "one" is the strongest posture available, and it is why `script-src`
// is still a pinned PATH.** A page with an inline script needs
// `'unsafe-inline'`, or a nonce, or `'strict-dynamic'` to keep
// `default-src 'none'` from blocking it. A page with one external script on an
// allowlisted path needs none of those, so ADR-0012's policy module is
// UNCHANGED by this slice and the baseline directive survives rather than being
// relaxed to accommodate a script. The looseners are not merely absent from this
// page: `test/headers.test.ts` asserts each of them is absent from the served
// `script-src`, so adding one is a failing test rather than a quiet edit.
//
// ── Which pages load it, and why that is not "all of them" by accident ─────
//
// **Every page the Worker serves AT a token URL**: the form, the closed page and
// the 429. The last two are easy to overlook and would otherwise leave the
// token in the address bar of exactly the visits where it is already spent or
// unusable — a revoked invite and a rate-limited one are the two cases a guest is
// most likely to screenshot, forward, or press Back on. `src/index.ts` serves
// all three from `openInvite`, at `pathname` that still contains the token.
//
// The redemption's own 410 (`POST /invite/redeem`) is at a token-FREE path, so
// its page loads the script too. **This comment used to claim the script finds
// nothing to strip there, and that was false** — the script does not care what
// is after the token, it rewrites any `/invite/`-prefixed path to `/invite/`, so
// on `/invite/redeem` it strips `redeem`. The review caught it. It is harmless
// either way: `/invite/` classifies as an invite-open with an EMPTY token, which
// is the reload case below, and one of the idempotence cases in
// `test/invites.test.ts`. It is recorded rather than quietly deleted because the
// rewrite became prefix-based in this slice, and that is what makes the claim
// true BY CONSTRUCTION rather than by accident.
//
// ── No user input is ever reflected into these pages ──────────────────────
//
// That is a structural property, not a discipline, and it is the reason the
// display name is NOT on the `GET`:
//
//   - the form page interpolates the invite TOKEN, and a token is
//     `isTokenShaped`-checked before it reaches here — 43 characters from
//     `A-Za-z0-9_-`, so not one of `<`, `"`, `&` or `'` is even expressible
//   - it interpolates `repo`, which `isRepoName`-checked, from the same set
//     plus `.`
//   - it interpolates `pr` (a number, validated by `isPullNumber`) and `kind`
//     (a member of `SHARE_TYPES`)
//   - the guest's own display name is typed into an `<input>`, never
//     rendered — it exists only in the POST body and in the `guests` row.
//
// Two independent controls, and which one is load bearing matters.
//
// **Validation is the control.** Every interpolated value is checked by SHAPE
// before it reaches this module — the token by `isTokenShaped`, `repo` by
// `isRepoName`, `pr` by `isPullNumber`, `kind` by membership of `SHARE_TYPES` —
// and the character sets those admit contain none of `<`, `"`, `&` or `'`. So
// nothing here CAN be escaped, which is why a whole-page escaping helper would
// be a false comfort: it would be untestable, because no input reaches these
// interpolations that it could have changed.
//
// **Escaping is the backstop, and it is applied to every interpolated value
// anyway** — `text()` below, on all four: `scope`, `kind`, `rights` and the
// hidden `token`. Two of those four are caller-supplied, so "only fixed strings
// need it" would be the wrong rule. It is the backstop rather than the control
// precisely because no input today can exercise it; if a future edit widens a
// validator's character set, the failure mode is a visibly wrong page rather
// than markup execution.
//
// `test/invites.test.ts` proves the validation half — the half that carries the
// argument: it mints with a hostile `repo` and asserts the MINT is refused, and
// it opens a link whose token carries markup and asserts the response does not
// contain it.
//
// The alternative that was rejected is `?name=` on the `GET`, which would have
// saved this module entirely: a query string is the most durable part of a URL
// (history, `Referer`, server logs, browser sync) and a guest's display name is
// personal data under ADR-0015 and ADR-0020. The token is in the URL because a
// mail link has to be; the name does not have to be, so it is not.
//
// ── The CSRF question, which this slice answers by NOT needing one ─────────
//
// ADR-0012: "every state-changing call needs a per-session CSRF token in a
// header", and the Worker delivers it as the `x-revkit-csrf` RESPONSE header on
// the redemption's `303`. **How a browser PAGE reads one was left open, and this
// slice's answer is that no page in this build needs to.** The reasoning is
// about reachability, and it is the same argument this codebase has already used
// to reject four things:
//
//   - The one state-changing call this page can make is `POST /invite/redeem`,
//     and it deliberately has NO CSRF check (`src/index.ts`): a CSRF token binds
//     a state change to an EXISTING session, and a guest arriving from a mail
//     client has none. A check there would be a control that cannot fail.
//   - **The page that WOULD need one does not exist at all.** Not "it is behind
//     a 501": what is 501 is `POST <repo>/pr-<n>/api/threads`, a WRITE API, and
//     a 501 is not a page. The guest rail that would post a comment from the
//     browser is slice 4's surface, and there is no markup for it yet — not a
//     stub, not a disabled button. So the person who eventually needs the
//     mechanism will be looking for a page, and there is not one to find.
//
// So the page does not read the token, and this module carries no `<meta>` for
// it and no cookie the script could read. Shipping either would widen exposure to
// any injected script for a token nothing consumes, which is precisely the
// "real control with nothing behind it" shape the mutation runs have been finding.
// Header-only stays available for the page that needs it: the token is already on
// the redemption's response, so a same-origin `fetch` is all that would read it.
// `test/invites.test.ts` pins all three carriers absent and the header present,
// and the ADR-0012 amendment proposed with this slice records the mechanism.

import type { ShareType } from "./invites.ts";

/** The encoding this page's form submits with, by not declaring an `enctype`.
 * Named here because the page is what fixes it; see the note on `redeemFormPage`. */
export const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

/** HTML-escape a value on its way into the markup.
 *
 * Applied to EVERY interpolated value in this module — `scope`, `kind`,
 * `rights`, the hidden `token` and `scriptSrc` — and not only to fixed
 * strings, because two of those five are caller-supplied and a third
 * (`scriptSrc`) is built from configuration. It is the **backstop**, not the
 * control: the first four are also shape-validated upstream into a character
 * set containing none of `<`, `"`, `&` or `'`, which is what makes the page
 * safe.
 *
 * **`scriptSrc` is what made this load-bearing rather than decorative, and the
 * review is what found it.** It was interpolated RAW, and it is built from
 * `env.REVKIT_VERSION` (`src/client-asset.ts`), so a quote in that value
 * produced a `script` tag whose `src` attribute was broken out of and carried
 * an `onload` handler. Not exploitable today — the served `script-src` has no
 * `'unsafe-inline'`, and `REVKIT_VERSION` is a committed var whose only
 * assertion is equality with `packages/cli/package.json` — but the mutation run
 * showed deleting `text()` from `scope`, from `kind` and from `rights` changed
 * **zero** tests, so three of the four call sites were decorative and the fourth
 * was the only one that could inject. It escapes now, and
 * `test/invites.test.ts` pins that by driving the builders with a value their
 * own doc comments say is already pre-validated: the only way to observe a
 * backstop is to hand it the input the validator was supposed to prevent.
 *
 * It exists so that a future edit widening a validator's character set degrades
 * to a visibly wrong page instead of markup execution, and so that a value
 * cannot skip escaping merely by being interpolated in the wrong spot.
 */
function text(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The one HTML document, for all three pages.
 *
 * **Extracted in this slice, and the reason is the script tag.** Two of these
 * three pages are served at a URL that still contains the invite token — the
 * closed page and the 429 — and a page that does not load the stripping script
 * leaves the token in the address bar of exactly the visits where it is spent or
 * unusable. That made "which pages carry the script" a question with three
 * answers that had to be kept in step, which is the shape a missed update takes.
 * One shell makes it one answer.
 *
 * The `<head>` is otherwise identical to what the three pages already spelled
 * out, minus the duplication: same charset, same viewport, same `noindex`,
 * same title parameter.
 *
 * **`src` is the only attribute on the script tag**, and it is the path the
 * asset route answers (`src/client-asset.ts`) — passed in rather than computed
 * here, because the digest is async and the two callers that need the URL are
 * the route and the page, and a page cannot learn the name the route will not
 * serve without asking the same function the route asks.
 */
function document_(options: {
  readonly title: string;
  readonly scriptSrc: string;
  readonly body: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>revkit — ${options.title}</title>
<script src="${text(options.scriptSrc)}"></script>
</head>
<body>
<main>
${options.body}
</main>
</body>
</html>
`;
}

/** The form's `action`. A CONSTANT, because `form-action 'self'` already
 * constrains it to this origin and a constant makes the second constraint
 * redundant rather than load-bearing. The token is in the BODY, so this URL is
 * token-free — which is what keeps it out of history when the browser records
 * the POST. */
export const REDEEM_PATH = "/invite/redeem";

export interface RedeemFormInput {
  /** Already `isTokenShaped`-validated: 43 characters of `A-Za-z0-9_-`. */
  readonly token: string;
  /** Already `isRepoName`-validated. */
  readonly repo: string;
  readonly pr: number | null;
  readonly kind: ShareType;
  /** False for `view`, and the page says so, because a guest who cannot
   * comment should learn that before redeeming rather than after. */
  readonly canComment: boolean;
  /** The content-addressed URL of the client script (`src/client-asset.ts`),
   * which this page is what loads. Passed in because the digest is async and
   * this module is synchronous — see `document_`. */
  readonly scriptSrc: string;
}

/**
 * The display-name form. A guest who followed a link lands here, sees what
 * they have been invited to, types a name, and POSTs.
 * *
 * The form declares **no `enctype`**, which is what makes a browser submit
 * `application/x-www-form-urlencoded`. That string is therefore a property of
 * THIS PAGE, not of the route that receives it, so it is named and exported here
 * and the route imports it. It was a real defect once: the page shipped the
 * default encoding while the route accepted only `application/json`, so the
 * form the Worker itself rendered answered `415 Unsupported Media Type` — the
 * whole flow was unusable by a browser and every test passed, because the tests
 * posted JSON the way a program would rather than the way a browser does. One
 * test now derives its request from this page's own markup.
 *
 * The server validates the name in Unicode code points. HTML `maxlength`
 * counts UTF-16 units, so it would prevent valid astral-character names from
 * reaching that validation. The input deliberately has no `maxlength`.
 *
 * `autocomplete="nickname"` rather than `name`: this is the name the guest
 * chooses to be called in someone else's review, not their account name, and
 * telling the browser to autofill an identity here would be the wrong default.
 *
 * **No `onsubmit`, and the form still posts natively.** The script strips the
 * address bar and does nothing else, so a guest with JavaScript disabled
 * submits exactly as they would have before this slice. The script is an
 * enhancement here, never the mechanism — which is also why a browser dropping
 * it costs the guest nothing but the address bar.
 *
 * **The closing sentence promises nothing, because nothing here runs (#96).** It
 * used to say the name "is deleted 30 days after this link is revoked or
 * expires", which was ADR-0015's rule quoted as if this deployment were
 * applying it. It is not: `wrangler.jsonc` declares no `triggers.crons` — that
 * deferral is ADR-0015's own and `test/worker-config.test.ts` pins it — so
 * `purgeStaleGuests` never fires and guests are retained indefinitely. It was
 * also wrong about the WHAT: the sweep ANONYMISES (`display_name` → `deleted
 * user`, `email` → NULL, row kept), it does not delete. A guest reading a promise
 * the deployment cannot keep is worse than a guest reading no promise, so the
 * sentence states only what is true now: nothing removes it automatically, and a
 * person can be asked to. It deliberately does not name
 * `revkit data delete --identity <id>` — ADR-0015 **plans** that command and it
 * does not exist, so pointing a guest at it would be the same false claim in a
 * different key. `test/invites.test.ts` asserts the page and `wrangler.jsonc`
 * agree, so the sentence cannot quietly become a claim again.
 */
export function redeemFormPage(input: RedeemFormInput): string {
  const scope = input.pr === null ? `all pull requests in ${input.repo}` : `${input.repo} pull request #${input.pr}`;
  const rights =
    input.canComment
      ? "You can comment on this review."
      : "This link is read-only: you can read the review but not comment on it.";
  return document_({
    title: "accept your invite",
    scriptSrc: input.scriptSrc,
    body: `<h1>You have been invited to review</h1>
<p>Scope: <strong>${text(scope)}</strong>.</p>
<p>Share type: <strong>${text(input.kind)}</strong>. ${text(rights)}</p>
<form method="post" action="${REDEEM_PATH}">
<input type="hidden" name="token" value="${text(input.token)}">
<p>
<label for="displayName">Your display name</label><br>
<input id="displayName" name="displayName" type="text" autocomplete="nickname" required>
</p>
<p>
<button type="submit">Accept and open the review</button>
</p>
</form>
<p>Your name is shown beside your comments. Nothing here removes it automatically — ask whoever sent this link if you want it taken down.</p>`,
  });
}

/**
 * The page a guest sees when the link cannot be used.
 *
 * ONE page for every dead-link reason — unknown token, revoked, expired,
 * already redeemed by this browser, `max_browsers` exhausted, no browser
 * binding. Two reasons for that, and the second is the one that matters:
 *
 *   1. A caller who holds a token already learns from the redemption whether
 *      it works; the closed set of reasons tells them nothing they do not know,
//    and it removes a way for a future reason to become an oracle that
//      distinguishes "never existed" from "you are late".
 *   2. The page never says WHICH. There is nothing here to configure and
 *      nothing to get wrong, so it cannot leak the reason by omission.
 *
 * It carries no token, no repo and no name, so a screenshot of it is safe to
 * send to whoever sent the link — which is the situation a guest is actually
 * in when they get here.
 *
 * **It is served AT a token URL, which is why it loads the script.** The token
 * that failed is still in the address bar at exactly the moment a guest is most
 * likely to press Back, or to forward the page to whoever sent it. See the note
 * at the top of this module.
 */
export function inviteClosedPage(scriptSrc: string): string {
  return document_({
    title: "this invite link cannot be used",
    scriptSrc,
    body: `<h1>This invite link cannot be used</h1>
<p>It may have expired, been revoked, or already have been used. Ask whoever sent it for a new link.</p>`,
  });
}

/**
 * The 429 page. It says when to come back and nothing else, and the number it
 * prints is the `Retry-After` the response also carries — one value, computed
 * once by `spendAttempts`, so the prose and the header cannot disagree.
 *
 * Like the closed page it is served at a token URL: the limiter refuses the OPEN
 * before it has read anything, so the address bar still holds the token on the
 * one visit where coming straight back is exactly what the guest will do.
 */
export function rateLimitedPage(retryAfterSeconds: number, scriptSrc: string): string {
  const seconds = Math.max(1, Math.floor(retryAfterSeconds));
  return document_({
    title: "too many attempts",
    scriptSrc,
    body: `<h1>Too many attempts</h1>
<p>Try again in ${seconds} seconds.</p>`,
  });
}
