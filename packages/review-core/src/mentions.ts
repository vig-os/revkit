// Typed mention parser (ADR-0011).
//
// `@` in a comment body is only for actors — GitHub users, invited
// guests, teams, roles, agents. Other sigils have their own path
// (`#123`, `[[term]]`). This file parses the ACTOR sigils out of a
// comment body into a structured list the rail can render as chips
// and the daemon can route on (`@agent now` → flush the handover
// batch immediately, ADR-0007 / DESIGN-0001 §5.3).
//
// **Not a regex over markup.** A comment body is Markdown; we
// tokenise it into "code-fenced regions" and "prose regions" first,
// so an `@agent` mentioned inside an inline `` `code` `` span or a
// fenced ``` ```code``` `` block is DATA, not a mention. Inside prose
// regions we then walk character by character, respecting word
// boundaries — an `@` that follows a letter or digit (`example@x`)
// is an email-ish suffix, not a mention. The parser is deterministic,
// O(n), and returns a typed list; it never rewrites the input.
//
// Grammar (accepted forms inside prose):
//
//   `@agent`         is an agent mention with id `agent`.
//   `@agent:<name>`  is an agent mention with id `agent:<name>`.
//   `@agent now`     is the batch-flush marker (adjacent " now").
//   `@claude`        is an agent alias (hosted).
//   `@author` / `@reviewers` / `@owners` are role mentions.
//   `@<gh-login>`    is a gh-user mention.
//   `@<org>/<team>`  is a team mention.
//
// The `<name>` after `@agent:` and `<gh-login>` / `<org>` follow
// GitHub's usual identifier shape (letters, digits, `-`; first
// character not `-`; up to 39 chars). Team names may include `-`
// and `_`. A trailing `-` on a login is rejected — GitHub does too.
//
// **`@agent now`** is a per-comment override. The bare `@agent`
// mention still fires (the agent is being addressed at all), and a
// SEPARATE `agent-now` marker rides alongside. Callers that want
// "just is-there-an-agent-now-in-this-comment" use `hasAgentNow`.

/** One parsed mention. `range` is the [start, end) offset in the
 * ORIGINAL body — useful for the rail's chip rendering, and for
 * asserting that a parser's ranges are non-overlapping in tests. */
export interface Mention {
  readonly kind: "agent" | "agent-now" | "gh-user" | "team" | "role";
  /** Machine id — `<login>` for a gh-user, `<org>/<team>` for a
   * team, `agent` / `agent:<name>` / `claude` for an agent,
   * `author`/`reviewers`/`owners` for a role. `agent-now` has no
   * id (it's a marker) and this field is the empty string. */
  readonly id: string;
  /** Display label the rail renders inside the chip. `@agent`,
   * `@login`, `@author`, `@org/team`, `@agent now`. Never carries
   * the leading `@` twice. */
  readonly label: string;
  /** Optional secondary label — the `<name>` after `@agent:`. */
  readonly name?: string;
  /** [start, end) byte offset in the original body. */
  readonly range: readonly [number, number];
}

/** Result of `parseMentions`. Kept as its own shape so a caller can
 * pass it to the rail or to routing logic without re-parsing. */
export interface MentionScan {
  readonly mentions: readonly Mention[];
  readonly hasAgentNow: boolean;
  readonly addressesAgent: boolean;
}

/** The set of role names ADR-0011 defines. `owners` resolves against
 * CODEOWNERS; not the parser's job (the parser records the role,
 * the send-time expansion is elsewhere). */
const ROLES = new Set<string>(["author", "reviewers", "owners"]);

/** Reserved agent names the parser recognises without a `:`-suffix.
 * `agent` is the generic id; `claude` is the hosted alias ADR-0011
 * calls out. Bare `@claude` STAYS on the PR mirror, so GitHub's
 * Claude Action can pick it up. */
const AGENT_ALIASES = new Set<string>(["agent", "claude"]);

/** Character class for a GitHub identifier's non-first char: letter,
 * digit, or `-`. First char must be a letter or digit. Team names
 * allow `_` too. */
function isIdChar(cc: number): boolean {
  return (
    (cc >= 0x30 && cc <= 0x39) || // 0-9
    (cc >= 0x41 && cc <= 0x5a) || // A-Z
    (cc >= 0x61 && cc <= 0x7a) || // a-z
    cc === 0x2d // -
  );
}
function isTeamChar(cc: number): boolean {
  return isIdChar(cc) || cc === 0x5f; // _
}
function isFirstIdChar(cc: number): boolean {
  return (
    (cc >= 0x30 && cc <= 0x39) ||
    (cc >= 0x41 && cc <= 0x5a) ||
    (cc >= 0x61 && cc <= 0x7a)
  );
}

/** Prose word boundary before `@`: the previous char must be absent
 * (start of string), whitespace, or a punctuation-ish neighbour.
 * Explicitly rejects letters and digits so `foo@bar` (email-ish)
 * does not fire. */
function isPreBoundary(source: string, position: number): boolean {
  if (position === 0) return true;
  const prev = source.charCodeAt(position - 1);
  // Letters/digits ⇒ not a boundary.
  if (
    (prev >= 0x30 && prev <= 0x39) ||
    (prev >= 0x41 && prev <= 0x5a) ||
    (prev >= 0x61 && prev <= 0x7a) ||
    prev === 0x5f // _
  ) {
    return false;
  }
  return true;
}

/** Parse `body` and return every actor mention plus routing flags.
 * Deterministic; safe on any UTF-8 input including empty. */
export function parseMentions(body: string): MentionScan {
  const mentions: Mention[] = [];
  let addressesAgent = false;
  let hasAgentNow = false;
  // First pass: mask out code-fenced and inline-code ranges. We
  // rebuild a `mask` string that is the same length as `body` but
  // with spaces where a code region sat, so offsets stay right and
  // an `@` inside code never matches.
  const mask = maskCode(body);

  let i = 0;
  while (i < mask.length) {
    if (mask.charCodeAt(i) !== 0x40 /* @ */) {
      i++;
      continue;
    }
    if (!isPreBoundary(mask, i)) {
      i++;
      continue;
    }
    // Try to read an identifier starting at i+1.
    const start = i;
    const idStart = i + 1;
    if (idStart >= mask.length || !isFirstIdChar(mask.charCodeAt(idStart))) {
      i++;
      continue;
    }
    // Read the first token (letters / digits / -).
    let j = idStart + 1;
    while (j < mask.length && isIdChar(mask.charCodeAt(j))) j++;
    // Reject trailing `-` (GitHub's rule: no trailing hyphen on a login).
    let end = j;
    while (end > idStart + 1 && mask.charCodeAt(end - 1) === 0x2d) end--;
    if (end === idStart) {
      i++;
      continue;
    }
    const firstToken = body.slice(idStart, end);
    // Cap at 39 chars (GitHub limit). Longer runs of id chars are
    // treated as not a mention — do not silently truncate.
    if (firstToken.length > 39) {
      i = j;
      continue;
    }
    // Optional `:<name>` continuation for `@agent:<name>`.
    let agentName: string | undefined;
    let cursor = end;
    if (
      firstToken === "agent" &&
      cursor < mask.length &&
      mask.charCodeAt(cursor) === 0x3a // :
    ) {
      const nameStart = cursor + 1;
      if (
        nameStart < mask.length &&
        isFirstIdChar(mask.charCodeAt(nameStart))
      ) {
        let k = nameStart + 1;
        while (k < mask.length && isIdChar(mask.charCodeAt(k))) k++;
        let nameEnd = k;
        while (nameEnd > nameStart + 1 && mask.charCodeAt(nameEnd - 1) === 0x2d) nameEnd--;
        const name = body.slice(nameStart, nameEnd);
        if (name.length > 0 && name.length <= 39) {
          agentName = name;
          cursor = nameEnd;
        }
      }
    }
    // Optional `/<team>` continuation for `@<org>/<team>`.
    let teamPart: string | undefined;
    if (
      agentName === undefined &&
      !ROLES.has(firstToken) &&
      !AGENT_ALIASES.has(firstToken) &&
      cursor < mask.length &&
      mask.charCodeAt(cursor) === 0x2f // /
    ) {
      const teamStart = cursor + 1;
      if (
        teamStart < mask.length &&
        isFirstIdChar(mask.charCodeAt(teamStart))
      ) {
        let k = teamStart + 1;
        while (k < mask.length && isTeamChar(mask.charCodeAt(k))) k++;
        let teamEnd = k;
        while (teamEnd > teamStart + 1 && mask.charCodeAt(teamEnd - 1) === 0x2d) teamEnd--;
        const team = body.slice(teamStart, teamEnd);
        if (team.length > 0 && team.length <= 39) {
          teamPart = team;
          cursor = teamEnd;
        }
      }
    }
    // Classify.
    let mention: Mention | undefined;
    if (agentName !== undefined) {
      mention = {
        kind: "agent",
        id: `agent:${agentName}`,
        label: `@agent:${agentName}`,
        name: agentName,
        range: [start, cursor],
      };
    } else if (teamPart !== undefined) {
      mention = {
        kind: "team",
        id: `${firstToken}/${teamPart}`,
        label: `@${firstToken}/${teamPart}`,
        range: [start, cursor],
      };
    } else if (AGENT_ALIASES.has(firstToken)) {
      mention = {
        kind: "agent",
        id: firstToken,
        label: `@${firstToken}`,
        range: [start, cursor],
      };
    } else if (ROLES.has(firstToken)) {
      mention = {
        kind: "role",
        id: firstToken,
        label: `@${firstToken}`,
        range: [start, cursor],
      };
    } else {
      mention = {
        kind: "gh-user",
        id: firstToken,
        label: `@${firstToken}`,
        range: [start, cursor],
      };
    }
    // `@agent` (or `@claude`) followed by whitespace + `now` +
    // word-boundary emits an EXTRA `agent-now` marker. `@agent:foo
    // now` also fires — the `:name` variant is still the agent.
    if (mention.kind === "agent") {
      addressesAgent = true;
      const trailing = readAgentNow(mask, cursor);
      if (trailing !== undefined) {
        mentions.push(mention);
        mentions.push({
          kind: "agent-now",
          id: "",
          label: "@agent now",
          range: [start, trailing],
        });
        hasAgentNow = true;
        i = trailing;
        continue;
      }
    }
    mentions.push(mention);
    i = cursor;
  }
  return { mentions, hasAgentNow, addressesAgent };
}

/** Convenience: `true` when the body has an `@agent now` (or a
 * `@claude now`) marker anywhere. Callers that only need the routing
 * bit do not want to walk `mentions`. */
export function hasAgentNow(body: string): boolean {
  return parseMentions(body).hasAgentNow;
}

/** Convenience: `true` when the body addresses `@agent` / `@claude` /
 * `@agent:<name>` at all. Used by the daemon to decide whether an
 * agent chip should highlight even without a `now`. */
export function addressesAgent(body: string): boolean {
  return parseMentions(body).addressesAgent;
}

/** Read a ` now` suffix at position `p` in `source`. Requires exactly
 * one Unicode whitespace between the mention and `now`, and a word-
 * boundary AFTER the `now` (whitespace, punctuation, or end of
 * string). Returns the index PAST `now` on success, else undefined. */
function readAgentNow(source: string, p: number): number | undefined {
  // Skip exactly-one whitespace character.
  if (p >= source.length) return undefined;
  const wsCc = source.charCodeAt(p);
  if (wsCc !== 0x20 && wsCc !== 0x09) return undefined;
  let q = p + 1;
  // Allow additional spaces (a user typing ".now" or "  now" still fires).
  while (q < source.length) {
    const cc = source.charCodeAt(q);
    if (cc !== 0x20 && cc !== 0x09) break;
    q++;
  }
  if (q + 3 > source.length) return undefined;
  if (source.slice(q, q + 3).toLowerCase() !== "now") return undefined;
  const after = q + 3;
  if (after === source.length) return after;
  const cc = source.charCodeAt(after);
  // Word boundary after: whitespace, punctuation, or end of string.
  if (
    (cc >= 0x30 && cc <= 0x39) ||
    (cc >= 0x41 && cc <= 0x5a) ||
    (cc >= 0x61 && cc <= 0x7a) ||
    cc === 0x5f
  ) {
    return undefined;
  }
  return after;
}

/** Replace every code-fenced and inline-code region in `body` with
 * spaces of the same length. Preserves offsets so downstream ranges
 * are correct. Handles:
 *
 *   - Triple backticks (```...```), including info strings.
 *   - Inline backticks (`...`), single and multiple, with the CommonMark
 *     rule that N opening backticks must be closed by N matching
 *     backticks.
 *   - `~~~` fenced blocks (Markdown alternative).
 *
 * Not a full Markdown parser. Comment bodies are short and predictable;
 * the shape here is enough to keep `@agent` inside `\`@agent\`` from
 * firing. Anything the mask misses (a very long or malformed fence) is
 * fine — the parser still requires a pre-boundary and reads a bounded
 * identifier. */
function maskCode(body: string): string {
  const out = body.split("");
  const len = body.length;
  let i = 0;
  while (i < len) {
    const cc = body.charCodeAt(i);
    // Fenced code block: ``` or ~~~ at column 0 (or after a newline).
    if ((cc === 0x60 || cc === 0x7e) && atLineStart(body, i)) {
      const fenceLen = countChar(body, i, cc);
      if (fenceLen >= 3) {
        // Consume the info string to end-of-line.
        let cursor = i + fenceLen;
        while (cursor < len && body.charCodeAt(cursor) !== 0x0a) cursor++;
        // Now scan for the closing fence at line-start.
        let scan = cursor;
        let closed = false;
        while (scan < len) {
          if (body.charCodeAt(scan) === 0x0a) {
            const bs = scan + 1;
            if (atLineStart(body, bs) && body.charCodeAt(bs) === cc) {
              const closeLen = countChar(body, bs, cc);
              if (closeLen >= fenceLen) {
                // Mask from i to the end of the closing fence.
                for (let k = i; k < bs + closeLen; k++) out[k] = " ";
                i = bs + closeLen;
                closed = true;
                break;
              }
            }
          }
          scan++;
        }
        if (!closed) {
          // Unterminated fence — mask to end of body (defensive).
          for (let k = i; k < len; k++) out[k] = " ";
          i = len;
        }
        continue;
      }
    }
    // Inline code: N backticks close on N matching backticks.
    if (cc === 0x60) {
      const openLen = countChar(body, i, cc);
      const closeStart = findMatchingBackticks(body, i + openLen, openLen);
      if (closeStart !== -1) {
        const closeEnd = closeStart + openLen;
        for (let k = i; k < closeEnd; k++) out[k] = " ";
        i = closeEnd;
        continue;
      }
      // Unterminated inline code — leave as-is and step past the
      // opening run so we don't loop.
      i += openLen;
      continue;
    }
    i++;
  }
  return out.join("");
}

function atLineStart(body: string, i: number): boolean {
  return i === 0 || body.charCodeAt(i - 1) === 0x0a;
}

function countChar(body: string, i: number, cc: number): number {
  let n = 0;
  while (i + n < body.length && body.charCodeAt(i + n) === cc) n++;
  return n;
}

function findMatchingBackticks(body: string, from: number, run: number): number {
  let i = from;
  while (i < body.length) {
    if (body.charCodeAt(i) === 0x60) {
      const n = countChar(body, i, 0x60);
      if (n === run) return i;
      i += n;
      continue;
    }
    i++;
  }
  return -1;
}
