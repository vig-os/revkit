// Unified-diff patch parser for the GitHub adapter (ADR-0025, M3 part 1).
//
// GitHub's `pull_request_files` REST endpoint returns a `patch` field per
// changed file: a unified diff fragment without file headers, just a
// sequence of hunks:
//
//   @@ -oldStart,oldLines +newStart,newLines @@ optional-context
//    unchanged context line
//   -removed line
//   +added line
//   \ No newline at end of file
//
// A pending-review comment addresses `(path, line, side=RIGHT)`. `line`
// must be a line number that appears on the RIGHT of a hunk — either a
// context line or an added line. Building a correct mapping needs a
// structural parse: the hunk header tells us where the segment sits, and
// walking the body assigns each line its `newLine` (the RIGHT-side line
// number).
//
// A regex over the hunk header line is fine — that IS the grammar of a
// unified diff, one line long, well-anchored: `@@ -a,b +c,d @@`. Regex
// over the body would not be.
//
// Runtime-neutral: no `node:*` / `bun:*` imports.

/** The kind of line inside a hunk. `context` appears on BOTH sides;
 * `add` appears only on the new side; `del` appears only on the old
 * side. `noEol` is the `\ No newline at end of file` marker that
 * follows the line it applies to. */
export type HunkLineKind = "context" | "add" | "del" | "noEol";

/** One line inside a hunk. `text` is the payload without the leading
 * marker character. `oldLine`/`newLine` are the 1-indexed line numbers
 * on the respective sides (undefined when the line doesn't appear on
 * that side). */
export interface HunkLine {
  readonly kind: HunkLineKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

/** One hunk of a unified diff. Both `Lines` counts are as declared in
 * the header, so a malformed patch surfaces as a hunk whose `lines`
 * array's context/add/del totals don't match. Callers that only need
 * to map (path, line) do not walk `lines` directly — use
 * `findLineInHunk` / `newSideLines`. */
export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly HunkLine[];
}

/** Anchored regex for a unified-diff hunk header. The `,b` and `,d`
 * groups are optional — a hunk that inserts or deletes exactly one line
 * omits them, per the diff format. The trailing free-form section
 * (function context after the second `@@`) is not captured. */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified-diff patch fragment (no file headers) into a list of
 * hunks. Returns `null` when the input is a "binary file" marker or
 * empty (GitHub's `patch` field is empty/undefined for binary files;
 * this helper accepts an empty string as "no patch"). Throws on a
 * malformed header, so a broken fixture fails loudly rather than
 * silently mapping to the wrong line.
 *
 * CRLF handling: line endings inside a patch's `+` and ` ` lines are
 * part of the source file's content and are preserved in `text`.
 * The patch itself is split on LF; a leading `\r` on a hunk header
 * would be a malformed patch and is rejected by the header regex.
 */
export function parsePatch(patch: string): Hunk[] | null {
  if (patch.length === 0) return null;
  // A GitHub "binary" file has no patch; some tools produce a
  // literal "Binary files ... differ" body. Treat as no-patch.
  if (patch.startsWith("Binary files ") || patch.startsWith("GIT binary patch")) {
    return null;
  }

  const rawLines = patch.split("\n");
  // A trailing newline in `patch` produces one empty tail entry; drop
  // it so the walker doesn't stumble on it.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const hunks: Hunk[] = [];
  let cursor = 0;
  while (cursor < rawLines.length) {
    const headerLine = rawLines[cursor];
    if (headerLine === undefined) break;
    const header = HUNK_HEADER_RE.exec(headerLine);
    if (header === null) {
      throw new Error(
        `parsePatch: expected a hunk header (@@ -a,b +c,d @@) at line ${cursor + 1}, got: ${headerLine.slice(0, 80)}`,
      );
    }
    const oldStart = Number.parseInt(header[1] ?? "0", 10);
    const oldLines = header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
    const newStart = Number.parseInt(header[3] ?? "0", 10);
    const newLines = header[4] === undefined ? 1 : Number.parseInt(header[4], 10);
    cursor++;

    const lines: HunkLine[] = [];
    let oldPos = oldStart;
    let newPos = newStart;
    let oldCount = 0;
    let newCount = 0;

    while (cursor < rawLines.length) {
      const line = rawLines[cursor];
      if (line === undefined) break;
      // The next hunk header ends this one.
      if (HUNK_HEADER_RE.test(line)) break;
      // The `\` line is the no-newline marker; it doesn't consume a
      // line on either side and doesn't advance oldPos/newPos.
      if (line.startsWith("\\")) {
        lines.push({ kind: "noEol", text: line.slice(2) });
        cursor++;
        continue;
      }
      const marker = line.charAt(0);
      const text = line.slice(1);
      if (marker === " ") {
        lines.push({ kind: "context", text, oldLine: oldPos, newLine: newPos });
        oldPos++;
        newPos++;
        oldCount++;
        newCount++;
      } else if (marker === "+") {
        lines.push({ kind: "add", text, newLine: newPos });
        newPos++;
        newCount++;
      } else if (marker === "-") {
        lines.push({ kind: "del", text, oldLine: oldPos });
        oldPos++;
        oldCount++;
      } else if (line === "") {
        // A blank body line (with no marker at all) is a
        // context line whose payload is empty. Some tools emit it.
        lines.push({ kind: "context", text: "", oldLine: oldPos, newLine: newPos });
        oldPos++;
        newPos++;
        oldCount++;
        newCount++;
      } else {
        throw new Error(
          `parsePatch: unrecognised line prefix '${marker}' at line ${cursor + 1}: ${line.slice(0, 80)}`,
        );
      }
      cursor++;
    }

    // Sanity: the declared counts must match the walked body. A
    // mismatch is a malformed patch — surfacing it here is much
    // better than silently mapping to the wrong lines downstream.
    if (oldCount !== oldLines || newCount !== newLines) {
      throw new Error(
        `parsePatch: hunk header declared -${oldStart},${oldLines} +${newStart},${newLines} ` +
          `but body has ${oldCount}/${newCount} old/new lines`,
      );
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines });
  }

  return hunks;
}

/** The line-numbers on the RIGHT (new) side that a comment may address:
 * context lines and added lines. Used for the file-scoped set that
 * `anchorToPrComment` checks a target range against. */
export function newSideLines(hunks: readonly Hunk[]): Set<number> {
  const set = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if ((line.kind === "context" || line.kind === "add") && line.newLine !== undefined) {
        set.add(line.newLine);
      }
    }
  }
  return set;
}

/** The line-numbers on the LEFT (old) side that appear in the patch:
 * context lines and deleted lines. Used when mapping a GitHub comment
 * on `LEFT` back into an anchor position. */
export function oldSideLines(hunks: readonly Hunk[]): Set<number> {
  const set = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if ((line.kind === "context" || line.kind === "del") && line.oldLine !== undefined) {
        set.add(line.oldLine);
      }
    }
  }
  return set;
}

/** True when every 1-indexed line in `[start..end]` is on the RIGHT
 * side of some hunk. A range that starts inside a hunk and ends
 * outside it (or that crosses a gap between two hunks) is NOT
 * addressable as a line comment — the caller must fall back to a
 * file-level comment. This is the safe choice (see ADR-0025): we
 * never map to the wrong lines. */
export function rangeIsOnRightSide(hunks: readonly Hunk[], start: number, end: number): boolean {
  if (end < start) return false;
  const right = newSideLines(hunks);
  for (let n = start; n <= end; n++) {
    if (!right.has(n)) return false;
  }
  return true;
}
