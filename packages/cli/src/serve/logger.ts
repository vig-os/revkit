// Structured JSON-line logger for the daemon (ADR-0020).
//
// One line per event on stderr, one object per line. Fields are stable
// so a tool (`jq`, a downstream log shipper) can filter without
// re-parsing message strings.
//
// **What must never appear** (ADR-0020, ADR-0015): comment bodies
// (thread replies, resolutions, ask answers), the `agentToken` from
// `.revkit/serve.json`, the current session cookie value, or a live
// launch code.
//
// The logger has no way to expose those: callers pass a fixed set of
// named fields (`method`, `path`, `status`, `kind`, ids, error kinds
// and durations), and there is no free-form "body" field. If a caller
// needs a new field, it goes here, gets typed, and gets covered by the
// no-secrets test in `test/serve/logger.test.ts`.

/** The stable field set every log line may carry. Strings, numbers or
 * booleans only — no nested objects that could smuggle a body. */
export interface LogFields {
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly reason?: string;
  readonly durationMs?: number;
  readonly threadId?: string;
  readonly commentId?: string;
  readonly askId?: string;
  readonly seq?: number;
  readonly host?: string;
  readonly origin?: string;
  readonly for?: string;
  readonly protocol?: string;
  readonly port?: number;
  readonly dir?: string;
  readonly version?: string;
  readonly pid?: number;
  readonly errorKind?: string;
  readonly bytes?: number;
}

/** A tiny writer interface so tests can inject a buffer. Node's
 * `process.stderr` satisfies it. */
export interface LineSink {
  write(line: string): void;
}

/** `console.error`-shaped sink over `process.stderr`. Kept behind
 * `defaultSink()` so a test can hand in an in-memory buffer without
 * monkey-patching global state. */
export function defaultSink(): LineSink {
  return {
    write(line: string): void {
      // `process.stderr.write` is synchronous on stderr in Bun and Node
      // on POSIX; a crash still gets the last line out.
      process.stderr.write(line + "\n");
    },
  };
}

/** Log levels. Only three — a daemon this small does not need more,
 * and a smaller enum keeps the no-secrets contract easier to eyeball. */
export type Level = "info" | "warn" | "error";

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Same as the level methods but takes the level as a value. Used by
   * generic wrappers (a middleware that logs at a computed level). */
  log(level: Level, event: string, fields?: LogFields): void;
}

/** ISO-8601 with offset, from a wall clock; taken as a parameter so a
 * test can pin the timestamp. */
export type Clock = () => string;

const wallClock: Clock = () => new Date().toISOString();

/** Build a logger over the given sink. The event string is short,
 * dot-separated (`serve.start`, `request.rejected.host`), and the
 * fields object is optional. Unknown fields on the input object are
 * silently ignored — the `LogFields` type keeps callers honest at
 * compile time, and the runtime whitelist below keeps the wire clean
 * even if a caller reaches around TypeScript. */
export function makeLogger(options: { readonly sink?: LineSink; readonly clock?: Clock } = {}): Logger {
  const sink = options.sink ?? defaultSink();
  const clock = options.clock ?? wallClock;
  const write = (level: Level, event: string, fields: LogFields | undefined): void => {
    const record: Record<string, unknown> = {
      ts: clock(),
      level,
      event,
    };
    if (fields !== undefined) {
      for (const key of ALLOWED_KEYS) {
        const value = fields[key];
        if (value === undefined) continue;
        record[key] = value;
      }
    }
    sink.write(JSON.stringify(record));
  };
  return {
    info(event, fields) {
      write("info", event, fields);
    },
    warn(event, fields) {
      write("warn", event, fields);
    },
    error(event, fields) {
      write("error", event, fields);
    },
    log(level, event, fields) {
      write(level, event, fields);
    },
  };
}

/** Runtime allowlist for log-record keys. Belt-and-braces with the
 * TypeScript `LogFields` type: even a caller who casts to `any` cannot
 * introduce a new field without editing this list. Kept in one place
 * so the no-secrets test can enumerate it. */
const ALLOWED_KEYS = [
  "requestId",
  "method",
  "path",
  "status",
  "reason",
  "durationMs",
  "threadId",
  "commentId",
  "askId",
  "seq",
  "host",
  "origin",
  "for",
  "protocol",
  "port",
  "dir",
  "version",
  "pid",
  "errorKind",
] as const satisfies readonly (keyof LogFields)[];

/** Exported so `test/serve/logger.test.ts` can iterate the allowlist —
 * the field set the logger will ever emit. */
export const LOG_FIELD_KEYS: readonly string[] = ALLOWED_KEYS;
