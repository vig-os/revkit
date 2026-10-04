// The two HTML pages the invite surface serves: the display-name form a guest
// sees after opening a link, and the pages that say the link is dead or the
// caller is over the limit.
//
// ── This is the first HTML the Worker serves, and it is why it is so plain ──
//
// ADR-0012's policy applies to every HTML response, and it is brutal:
// `default-src 'none'`, `script-src` naming only `/_revkit/<version>/` plus a
// committed hash allowlist, `form-action 'self'`. This page satisfies all of
// that by having **nothing to allow**: no `<script>`, no `<style>`, no external
// subresource, no inline handler, no `javascript:` URL. Under
// `default-src 'none'` that is the only kind of page that can render, and it is
// the right answer for a page whose whole job is to POST one string.
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
// So there is no HTML-escaping helper here, and adding one would be a false
// comfort: there is nothing to escape. the validation half in `test/invites.test.ts` proves it by
// minting with a hostile `repo` and asserting the MINT is refused, and by
// opening a link whose token carries markup and asserting the response does not
// contain it.
//
// The alternative that was rejected is `?name=` on the `GET`, which would have
// saved this module entirely: a query string is the most durable part of a URL
// (history, `Referer`, server logs, browser sync) and a guest's display name is
// personal data under ADR-0015 and ADR-0020. The token is in the URL because a
// mail link has to be; the name does not have to be, so it is not.

import { MAX_DISPLAY_NAME_CHARS, type ShareType } from "./invites.ts";

/** The encoding this page's form submits with, by not declaring an `enctype`.
 * Named here because the page is what fixes it; see the note on `redeemFormPage`. */
export const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

/** Escape hatch for text that is NOT validated by shape. Used for the fixed
 * strings below only — and there are none, which is why this exists at all:
 * `revokeInvite` and the rate-limit kinds are interpolated through it so that
 * a future editable string cannot skip a check by landing in the wrong spot. */
function text(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
 * `maxlength` is `MAX_DISPLAY_NAME_CHARS`, imported from the module that
 * enforces it — **not a literal**, because the two drifting apart would be a
 * finding and a literal is how they drift. That was measurable: the mutation run
 * changed `maxlength="64"` to `maxlength="4096"` and left every test green, since
 * nothing asserted the attribute. The server is still the control, because a
 * `maxlength` attribute is a hint a `curl` does not have to honour; this is the
 * browser's half of the same bound.
 *
 * `autocomplete="nickname"` rather than `name`: this is the name the guest
 * chooses to be called in someone else's review, not their account name, and
 * telling the browser to autofill an identity here would be the wrong default.
 */
export function redeemFormPage(input: RedeemFormInput): string {
  const scope = input.pr === null ? `all pull requests in ${input.repo}` : `${input.repo} pull request #${input.pr}`;
  const rights =
    input.canComment
      ? "You can comment on this review."
      : "This link is read-only: you can read the review but not comment on it.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>revkit — accept your invite</title>
</head>
<body>
<main>
<h1>You have been invited to review</h1>
<p>Scope: <strong>${text(scope)}</strong>.</p>
<p>Share type: <strong>${text(input.kind)}</strong>. ${text(rights)}</p>
<form method="post" action="${REDEEM_PATH}">
<input type="hidden" name="token" value="${text(input.token)}">
<p>
<label for="displayName">Your display name</label><br>
<input id="displayName" name="displayName" type="text" maxlength="${MAX_DISPLAY_NAME_CHARS}" autocomplete="nickname" required>
</p>
<p>
<button type="submit">Accept and open the review</button>
</p>
</form>
<p>Your name is shown beside your comments and is deleted 30 days after this link is revoked or expires.</p>
</main>
</body>
</html>
`;
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
 */
export function inviteClosedPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>revkit — this invite link cannot be used</title>
</head>
<body>
<main>
<h1>This invite link cannot be used</h1>
<p>It may have expired, been revoked, or already have been used. Ask whoever sent it for a new link.</p>
</main>
</body>
</html>
`;
}

/**
 * The 429 page. It says when to come back and nothing else, and the number it
 * prints is the `Retry-After` the response also carries — one value, computed
 * once by `spendAttempts`, so the prose and the header cannot disagree.
 */
export function rateLimitedPage(retryAfterSeconds: number): string {
  const seconds = Math.max(1, Math.floor(retryAfterSeconds));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>revkit — too many attempts</title>
</head>
<body>
<main>
<h1>Too many attempts</h1>
<p>Try again in ${seconds} seconds.</p>
</main>
</body>
</html>
`;
}
