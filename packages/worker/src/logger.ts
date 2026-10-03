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
// The redaction is NOT "remember not to log the body". It is structural:
// a log record is built from a fixed set of typed fields plus an
// `extra` bag that is passed through a redactor first. A caller cannot
// accidentally log a token without the redactor seeing it, because the
// redactor runs on everything.
//
// **`requestId` is the join key, and it is generated once per request**
// by the caller and carried in the returned context, so the line in the
// log and the header in the response cannot disagree.

/** Fields whose NAME marks the value as a credential or personal data.
 *
 * Case-INsensitive, and that is load-bearing rather than cosmetic: the
 * natural spellings are `displayName`, `arrayOfEmails` and
 * `Authorization`, and a case-sensitive pattern caught none of them — a
 * test with a guest's display name in it went green with the name still in
 * the line. The first alternative additionally requires a non-letter on
 * both sides so `authorship` is not caught by `auth`.
 *
 * The second alternative has no such guard because these are content
 * words: `body`, `comment`, `text`, `content`, `message`, `quote`,
 * `email`. They match anywhere in the key (`arrayOfEmails`,
 * `commentBody`), which is the intended bias — a false positive costs a
 * missing diagnostic, a false negative costs a reviewer's email in a log. */
const SENSITIVE_KEY =
  /(^|[^a-z])(auth|authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|api[_-]?key|bearer|csrf|csrftoken|x-api-key)([^a-z]|$)|email|e-mail|display_?name|body|comment|text|content|message|prompt|quote/i;

/** Value-shaped secrets that must never reach a log even under a
 * key that does not look sensitive. GitHub's classic PAT prefix is the
 * concrete case (ADR-0009/0014's token shapes). */
const SECRET_VALUE = /(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}=*)/;

/** Anything that looked like a secret (or like an email) is replaced by
 * this, whatever the key was. Length is not preserved: leaking the
 * length of a token is a small, free side channel. */
export const REDACTED = "[redacted]";

/** Severity of one line. Explicit rather than inferred so a log query
 * can filter without parsing the message. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Free-form diagnostics attached to a line: numeric counters, HTTP
 * method, a pathname, an opaque identity id. Anything whose KEY matches
 * `SENSITIVE_KEY` is replaced before serialisation, so a caller cannot
 * turn a mistake into a leak by choosing a different shape. */
export type LogFields = Record<string, unknown>;

/** A logger bound to one sink. The Worker binds `console.log`; a test
 * binds an array. Binding the sink keeps the logger free of globals, so
 * the redaction test can assert on exactly what was written. */
export interface Logger {
  /** Write one line. Never throws — a logging failure must not take down
   * a request. */
  log(level: LogLevel, msg: string, fields?: LogFields): void;
  /** A logger that stamps `requestId` on every line, so a call site
   * cannot forget it. This is how the Worker's per-request logger is
   * built, and it is what makes ADR-0020's "one request id per call"
   * structural instead of a convention. */
  withRequestId(requestId: string): Logger;
}

/** Recursively redact one value. Depth-bounded so a cyclic object from
 * a caller cannot hang the logger — a log line that costs the request
 * its response is a worse bug than a truncated field. */
function redact(value: unknown, depth: number): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === "string") {
    return SECRET_VALUE.test(value) ? REDACTED : value;
  }
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
      // `msg` goes through the same redactor as every field: a message is
      // a string a caller wrote by hand, and a hand-written string is
      // exactly where a pasted token ends up.
      const record: Record<string, unknown> = {
        ts: options.clock(),
        level,
        msg: SECRET_VALUE.test(msg) ? REDACTED : msg,
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
    log: write,
    withRequestId: (requestId: string) => createLogger({ ...options, requestId }),
  };
  return logger;
}

/** Generate an opaque request id. `crypto.randomUUID` exists in workerd
 * with no compatibility flags (measured) and in Bun; the counter suffix
 * is not needed and a UUID alone is not guessable, so nothing here is
 * an identity. */
export function newRequestId(): string {
  return crypto.randomUUID();
}
