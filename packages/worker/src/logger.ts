// Structured JSON logging with redaction (ADR-0020, ADR-0015).
//
// Two rules, both non-negotiable from the first log line because
// retrofitting them means auditing every line that ever shipped:
//
//   ADR-0020 — every line is JSON with a `requestId`, and that same id
//              reaches the UI so a reviewer can report it.
//   ADR-0015 — no comment body, email, token or cookie in a log line, and
//              identities appear as opaque ids only.
//
// ── What this module actually enforces, and what it does not ──────────────
//
// The #76 review measured real leaks through an earlier version of this
// file, and the fix is worth stating precisely because "we redact" is
// usually a stronger claim than the code supports.
//
// ENFORCED, three mechanisms:
//
//   1. **The message is a closed vocabulary.** `msg` must be one of the
//      names in `LOG_MESSAGES`, enforced in the TYPE (`LogMessage` is a
//      literal union) and at RUNTIME (`KNOWN_MESSAGES.has(msg)`). This is the
//      only mechanism that can stop a COMMENT BODY, because no regex
//      distinguishes prose from a log line: the earlier version put a whole
//      comment body in `msg` and every pattern passed it. Free text is now
//      unrepresentable, including the interpolated-name shape that a
//      form-only check accepted.
//   2. **Key names.** A field whose name matches `SENSITIVE_KEY` has its
//      value replaced entirely, so the shape does not matter — nested,
//      arrayed, or a bare string.
//   3. **Value shapes.** Every remaining string — in any field, at any
//      depth — is tested for a credential shape or an email address. This is
//      what catches the leak under an INNOCENT key, which is how leaks
//      actually happen. Slice 2 added revkit's own token shape to this set
//      after MEASURING that a minted session id logged under the key `seen`
//      came out verbatim: the shape pass knew six credential families and
//      none of them was the one this repo mints.
//
// NOT ENFORCED, and stated so nobody relies on it:
//
//   **Free-form prose under a key the redactor does not recognise is not
//   detected.** A field named `note` carrying a comment body would pass
//   mechanisms 2 and 3 (no email, no credential shape). The control for that
//   is the CALLER RULE — review content is never passed as a log field; the
//   redactor is a backstop, not the primary control — plus mechanism 1,
//   which removes the largest such surface. `SENSITIVE_KEY` names the
//   content-ish fields that must never be logged, and the review-content key
//   set is pinned by a test so a new one cannot be added without noticing.
//
// So the accurate claim is "a comment body cannot be logged as `msg`, cannot
// be logged under a content-shaped key, and cannot leak an address or a
// credential under any key" — NOT "nothing sensitive can reach a log".

import { TOKEN_CHARS } from "./session.ts";

/** Severity of one line. Explicit rather than inferred so a log query
 * can filter without parsing the message. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Every log line's message is one of these. A literal union, so a new
 * call site cannot invent a message without TypeScript objecting, AND a
 * runtime guard for callers that are not TypeScript.
 *
 * `auth.denied` / `auth.granted` / `csrf.rejected` are the slice-2 addition.
 * Their `reason` field is a closed vocabulary too, but it lives with the gate
 * that chooses it (`DENIAL_REASONS` in `src/authz.ts`), not here — an earlier
 * revision of this file put the list HERE, on the theory that half its members
 * ("expired-session", "malformed-session-cookie") are credential-shaped and
 * would be eaten by the key-name pattern. That theory was WRONG and the
 * mutation run is what proved it: `SENSITIVE_KEY` is tested against the KEY,
 * never the value, and no reason matches a credential VALUE shape, so deleting
 * the exemption changed no output at all (0 of 30 logger tests). A mechanism
 * with a plausible justification and no measured effect is worse than none,
 * so it is gone and the closed vocabulary is enforced by the TYPE where it is
 * produced. `test/authorization.test.ts` pins the list. */
export const LOG_MESSAGES = [
  "request.start",
  "request.end",
  "request.error",
  "auth.denied",
  "auth.granted",
  "csrf.rejected",
  "api.session.refresh.ok",
  "api.threads.append.disabled",
] as const;

export type LogMessage = (typeof LOG_MESSAGES)[number];

/** Free-form diagnostics attached to a line: numeric counters, HTTP
 * method, a pathname, an opaque identity id. Anything whose KEY matches
 * `SENSITIVE_KEY` is replaced before serialisation. */
export type LogFields = Record<string, unknown>;

/** A logger bound to one sink. The Worker binds `console.log`; a test
 * binds an array. Binding the sink keeps the logger free of globals, so
 * the redaction test can assert on exactly what was written. */
export interface Logger {
  /** Write one line. Never throws — a logging failure must not take down
   * a request. */
  log(level: LogLevel, msg: LogMessage, fields?: LogFields): void;
  /** A logger that stamps `requestId` on every line, so a call site
   * cannot forget it. This is how the Worker's per-request logger is
   * built, and it is what makes ADR-0020's "one request id per call"
   * structural instead of a convention. */
  withRequestId(requestId: string): Logger;
}

/**
 * Fields whose NAME marks the value as a credential or personal data.
 *
 * Case-INsensitive, and that is load-bearing rather than cosmetic: the
 * natural spellings are `displayName`, `arrayOfEmails` and
 * `Authorization`, and a case-sensitive pattern caught none of them — a test
 * with a guest's display name in it went green with the name still in the
 * line. The first alternative additionally requires a non-letter on both
 * sides so `authorship` is not caught by `auth`.
 *
 * The second alternative has no such guard because these are content and
 * credential words. They match anywhere in the key (`arrayOfEmails`,
 * `commentBody`), which is the intended bias — a false positive costs a
 * missing diagnostic, a false negative costs a reviewer's email in a log.
 *
 * `session`/`session_id`/`sid` are here because ADR-0012 makes the session
 * cookie the bearer credential for a hosted request, and `sessions.id` is
 * the schema's own identifier for it: a session id in a log line is a
 * credential in a log line. M4 slice 2 made that concrete rather than
 * theoretical — the cookie carries a 256-bit token and
 * `POST /api/session/refresh` mints one per request's caller, so from slice 2
 * there IS a real session id in every authorized request. `test/logger.test.ts`
 * drives a genuinely minted one through this redactor.
 *
 * `csrf` is here for the same reason one step along: the CSRF token is a
 * bearer credential that authorises state changes, `CSRF_HEADER` is literally
 * named `x-revkit-csrf`, and a field called `csrf` must not keep its value
 * whatever it contains.
 *
 * **`cookie[s]?` rather than `cookie`.** The first alternative's
 * non-letter guards are what stop `authorship` matching `auth`, and they also
 * made `cookies` and `cookieJar` MISS — measured: both passed a session value
 * through untouched, and ADR-0012 says no cookies in logs. The optional
 * trailing `[a-z]` is the fix; the guards stay.
 *
 * `guest_?name` / `full_?name` are here for ADR-0015's exact datum: a guest's
 * display name is personal data whether the field is called `name`,
 * `guestName` or `fullName`.
 */
const SENSITIVE_KEY =
  /(^|[^a-z])(auth|authorization|cookie|set-cookie|cookies|cookie_?jar|cookiejar|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|api[_-]?key|bearer|csrf|csrftoken|x-api-key|session[_-]?id|sid|session)([^a-z]|$)|email|e-mail|display_?name|guest_?name|full_?name|body|comment|text|content|message|prompt|quote|excerpt|summary|note|notes|detail|details|description|transcript|draft|patch|diff/i;

/** Credential shapes, matched ANYWHERE in a string so a value that
 * embeds one ("retry failed with ghp_…") is caught even when the rest of
 * it is prose. */
const SECRET_VALUE =
  /(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/;

/**
 * Revkit's OWN credential shape: a `TOKEN_CHARS`-long base64url string.
 *
 * **Measured, not hypothesised.** M4 slice 2 added a session id and a CSRF
 * token, both `mintToken()` output, and the test below logs a minted one under
 * the key `seen` — an innocent name, exactly the shape of leak the value pass
 * exists to catch. Before this pattern that test FAILED: the line came out
 * with 256 bits of CSPRNG output verbatim, because `ghp_`-prefix matching does
 * not cover a credential this repo mints itself. So the gap was real, the
 * fix is to state the shape, and it is stated rather than generalised because
 * a broader "looks like a token" rule would start eating git object ids.
 *
 * The false-positive cost here is zero and is a property of what gets logged,
 * not luck: this module's own values are timestamps, HTTP verbs, pathnames,
 * status codes, closed-vocabulary reasons and UUID request ids (36 chars,
 * dashed — not 43 undashed), so nothing legitimate in a line is this shape.
 * If a future field starts logging base64url of some other length, this rule
 * will not cover it and the caller rule is what it will rely on — which is
 * the boundary this module's header already draws.
 *
 * The length comes from `session.ts` rather than being written here, so the
 * rule cannot drift away from the mints it is describing.
 */
const REVKIT_TOKEN_VALUE = new RegExp(`^(?:[A-Za-z0-9_-]{${TOKEN_CHARS}})$`);

/** An email address. ADR-0015 and ADR-0020 both name emails explicitly,
 * and an address is the single most likely personal datum to appear in a
 * field whose NAME says nothing about it — `{ actor: "reviewer@example.com" }`
 * was a measured leak through the earlier version of this file, under a key
 * (`actor`) that is legitimate and must survive. */
const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Anything that looked like a secret, or like an address, is replaced by
 * this, whatever the key was. Length is not preserved: leaking the length
 * of a token is a small, free side channel. */
export const REDACTED = "[redacted]";

/** Substituted for a `msg` that is not a known event name. The original
 * is NOT logged anywhere — logging it would defeat the check — so the line
 * says only that the message was refused. */
export const INVALID_MESSAGE = "invalid.log.message";

/** MEMBERSHIP, not shape. An earlier revision checked only that `msg`
 * looked like `a.b.c`, and that is not a control: measured through the real
 * logger, `not.a.real.event.name`, `because.the.reviewer.said.so` and an
 * interpolated `` `api.threads.${kind}.disabled` `` all passed verbatim. The
 * interpolated case is the realistic future bug, because it type-checks as a
 * `string` at the call site and the shipped bundle is JavaScript, so
 * TypeScript's help stops at the boundary.
 *
 * A shape check is therefore kept only as a cheap pre-filter, and the verdict
 * is `LOG_MESSAGES.includes(msg)`. One known name is all five, so the cost of
 * being exact is a five-element scan. */
const EVENT_NAME = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const KNOWN_MESSAGES: ReadonlySet<string> = new Set<string>(LOG_MESSAGES);

/** Redact one string: a credential shape or an email address anywhere in
 * it replaces the WHOLE value, so a partially-redacted address
 * (`re***@example.com`) never appears. */
function redactString(value: string): string {
  return SECRET_VALUE.test(value) || EMAIL_ADDRESS.test(value) || REVKIT_TOKEN_VALUE.test(value)
    ? REDACTED
    : value;
}

/** Recursively redact one value. Depth-bounded so a cyclic object from a
 * caller cannot hang the logger — a log line that costs the request its
 * response is a worse bug than a truncated field. */
function redact(value: unknown, depth: number): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(nested, depth + 1);
  }
  return out;
}

/** Build a logger over `sink`. Every line is one JSON object with
 * `ts` (the injected clock), so a Workers Logs query can group by
 * request without a parser. */
export function createLogger(options: {
  readonly sink: (line: string) => void;
  readonly clock: () => string;
  readonly requestId?: string;
}): Logger {
  const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
    try {
      const record: Record<string, unknown> = {
        ts: options.clock(),
        level,
        // Mechanism 1: the message is a KNOWN event name or nothing.
        // `msg` also goes through the value pass, so a credential pasted
        // into an event name is still caught even if the membership check is
        // bypassed.
        msg: EVENT_NAME.test(msg) && KNOWN_MESSAGES.has(msg) ? redactString(msg) : INVALID_MESSAGE,
      };
      if (options.requestId !== undefined) record["requestId"] = options.requestId;
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (key === "level" || key === "msg" || key === "requestId") continue;
        record[key] = value;
      }
      options.sink(JSON.stringify(redact(record, 0)));
    } catch {
      // A logger that throws turns a diagnostic into a 500. Swallow it:
      // the line is lost, the request is not.
    }
  };
  const logger: Logger = {
    log: (level, msg, fields) => write(level, msg, fields),
    withRequestId: (requestId: string) => createLogger({ ...options, requestId }),
  };
  return logger;
}

/** Generate an opaque request id. `crypto.randomUUID` exists in workerd
 * with no compatibility flags (measured) and in Bun; a UUID is not
 * guessable, so nothing here is an identity. */
export function newRequestId(): string {
  return crypto.randomUUID();
}
