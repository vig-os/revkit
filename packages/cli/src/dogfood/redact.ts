// Log redaction. Removes credential-shaped substrings before any log line
// is written to disk. The shell version used sed; TypeScript regexes are
// equally happy — but they must be applied line-by-line so a line
// containing more than one secret still redacts every occurrence.
//
// Redacted classes:
//   Bearer TOKEN
//   revkit-<n>=… (session cookie)
//   ?code=… and &code=… on launch URLs
//   --code TOKEN and --code=TOKEN
//   JSON values for known credential keys (agentToken, launchCode,
//     launchUrl, cookie, token)

const REDACTORS: ReadonlyArray<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1<redacted>"],
  [/(revkit-\d+=)[A-Za-z0-9._~+/=-]+/g, "$1<redacted>"],
  [/([?&]code=)[A-Za-z0-9._~+/=-]+/g, "$1<redacted>"],
  [/(--code[= ])[A-Za-z0-9._~+/=-]+/g, "$1<redacted>"],
  [/("(?:agentToken|launchCode|launchUrl|cookie|token)"\s*:\s*")[^"]+/g, "$1<redacted>"],
];

/** Redact one line. Idempotent. */
export function redactLine(line: string): string {
  let out = line;
  for (const [pattern, replacement] of REDACTORS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Redact a multi-line string. */
export function redactAll(text: string): string {
  return text.split("\n").map(redactLine).join("\n");
}
