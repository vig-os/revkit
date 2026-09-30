// Browser- and server-safe predicate for repo-relative anchor paths.
// The ONE source of truth (PR #38 round-2 review): every surface
// that stores or parses an anchor path — the daemon (via
// `anchorPathSchema`), the rail (via `parseDataSrc`), the GitHub
// adapter, `check-dist` — calls THIS function. Add a rule here and
// every surface inherits it.
//
// Rules enforced:
//
// 1..512 chars. No leading forward slash and no backslash (repo-
// relative POSIX only). No control characters (< 0x20). No colon
// (would ambiguate data-src's last-colon split), and no
// asterisk, question mark, angle brackets, pipe, or double quote
// (Windows-hostile). No dot or double-dot path segment
// (containment). No empty segment (catches a//b).

const DISALLOWED_PATH_CHARS: ReadonlySet<number> = new Set<number>([
  0x22, // "
  0x2a, // *
  0x3a, // :
  0x3c, // <
  0x3e, // >
  0x3f, // ?
  0x7c, // |
]);

/** Is `path` a valid repo-relative anchor path? */
export function isValidRepoRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  for (let i = 0; i < path.length; i++) {
    const cc = path.charCodeAt(i);
    if (cc < 0x20) return false;
    if (DISALLOWED_PATH_CHARS.has(cc)) return false;
  }
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "." || part === "..") return false;
    if (part.length === 0) return false;
  }
  return true;
}
