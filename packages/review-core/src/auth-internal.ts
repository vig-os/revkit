// Internal auth helpers shared by `createNoneAuthProvider`
// (`auth-none.ts`) and `createTrustedProxyAuthProvider`
// (`auth-trusted-proxy.ts`). Not re-exported from `index.ts` — these
// are implementation details of the in-core providers. Centralising
// them keeps a single validation path so a future provider can't
// forget one of the rules: the header-name token check (RFC 9110
// §5.6.2), the display-name control-character + 256-code-unit cap,
// and the control-character predicate the subject refusal uses.

/** RFC 9110 §5.6.2 token characters. A valid HTTP header name is one
 * or more of these; anything else (space, `:`, newline, high byte) is
 * rejected at construction so a typo is a startup error. */
export const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Documented bound on display-name header values. Longer values are
 * truncated to this many UTF-16 code units; the subject itself is
 * refused if it exceeds the bound because a stable proxy-asserted
 * subject is a short id. */
export const DISPLAY_NAME_MAX_CHARS = 256;

/** Throws if `name` is not an RFC 9110 §5.6.2 token. `field` names the
 * offending config field in the error message. Shared by every in-core
 * provider so an invalid header name is a construction-time error with
 * one consistent shape — `authenticate()` keeps its "MUST NOT throw"
 * contract from `auth.ts`. */
export function validateHeaderName(field: string, name: string): void {
  if (!HEADER_NAME_RE.test(name)) {
    throw new Error(
      `${field}: invalid HTTP header name (RFC 9110 §5.6.2 token): ${JSON.stringify(name)}`,
    );
  }
}

/** True iff `s` contains any C0 (U+0000..U+001F), DEL (U+007F) or C1
 * (U+0080..U+009F) control character. Used by the subject-refusal
 * path; the display-name path strips these characters instead
 * (see `sanitiseDisplayName`). */
export function containsControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** Return a copy of `s` with every C0, DEL and C1 control character
 * removed. */
function stripControlChars(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) continue;
    out += s[i];
  }
  return out;
}

/** Sanitise a raw display-name header value:
 *
 * - Control characters (C0 / DEL / C1) are stripped.
 * - Surrounding Unicode whitespace is trimmed (the Fetch `Headers`
 *   normaliser only strips HTTP whitespace — space and tab — so U+00A0
 *   and U+3000 would otherwise travel through unchanged).
 * - The result is capped at `DISPLAY_NAME_MAX_CHARS` code units.
 * - Returns `undefined` if the stripped + trimmed value is empty, so
 *   the caller can fall back to the subject (`trusted-proxy`) or to
 *   the configured default (`none`).
 */
export function sanitiseDisplayName(raw: string): string | undefined {
  const stripped = stripControlChars(raw).trim();
  if (stripped.length === 0) return undefined;
  if (stripped.length <= DISPLAY_NAME_MAX_CHARS) return stripped;
  return stripped.slice(0, DISPLAY_NAME_MAX_CHARS);
}
