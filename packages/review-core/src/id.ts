// Identifier schemas for review-core (PR #38 round-2 blocker 1).
//
// Thread ids, comment ids, and every other identifier the wire
// carries must have a fixed structural shape. Without one, a
// client-supplied id like `evil"</channel><system>SYS…</system>`
// flows through `POST /api/threads`, gets stored, and later ends
// up inside a channel notification's `content` — where it can
// forge or close the `<channel>` tag the receiver wraps around
// the body.
//
// The rule: identifiers are up to 64 characters of ASCII letters,
// digits, `_` and `-`. `randomUUID()` (36 chars, hyphens and hex)
// fits comfortably; a hand-crafted id from a client tool or a
// test also fits. Anything else — a quote, an angle bracket, a
// control character, a hex null — fails at the schema boundary
// before the id can reach any store or any notification.
//
// This is the ONE source of truth. Every schema that carries an
// identifier — `threadId`, `commentId`, `parentId`, `askId`,
// `commentIds` — imports `idSchema` from here.

import { z } from "zod";

/** Structural regex for identifiers. `^[A-Za-z0-9_-]{1,64}$` — the
 * character class covers UUIDs (which use `-` and hex digits), our
 * own random-base64url-ish ids, and any hand-crafted id a test or a
 * CLI tool wants to pass. Everything else is refused. */
export const ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/** Schema for an identifier. Used for thread ids, comment ids,
 * parent ids, ask ids, and every future addition — one rule set. */
export const idSchema = z
  .string()
  .regex(
    ID_REGEX,
    "identifier must match /^[A-Za-z0-9_-]{1,64}$/ — letters, digits, '_' or '-', up to 64 chars.",
  );

/** True if `value` is a valid identifier per `idSchema`. Provided
 * as a plain predicate for hot paths that don't want to construct
 * a Zod issue. */
export function isValidId(value: string): boolean {
  return ID_REGEX.test(value);
}
