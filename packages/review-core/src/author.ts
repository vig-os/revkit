// Typed actors (ADR-0011). `@` is only for actors — GitHub users, invited
// guests, teams, roles resolved at send-time (`@author`, `@reviewers`,
// `@owners`), and agent sessions. Storing the kind alongside the id lets a
// rename or a role-membership change never break an old comment, and lets
// each surface render the mention its own way (@login on GitHub, "Name
// (guest)" for guests, and so on).
import { z } from "zod";

/** The kinds of actor an event or a mention may reference (ADR-0011). Kept
 * as a const tuple so the Zod enum, TypeScript type and any downstream
 * consumer iterate the same list.
 *
 * `local` is the M2 daemon's own human session (`revkit serve` on
 * loopback, ADR-0013): a human comes in through the launch-code cookie
 * with no hosted identity, no invite and no gh token yet (that lives on
 * the M3 local PR review surface, ADR-0025). Its `id` is opaque to the
 * daemon — an install-scoped user tag written by the CLI — so a
 * rename or a machine move never invalidates old comments. */
export const authorKinds = ["gh-user", "local", "guest", "team", "role", "agent", "system"] as const;
export type AuthorKind = (typeof authorKinds)[number];

/** Author of an event — a typed mention with an id and an optional display
 * name. `id` is the surface-appropriate identifier: a GitHub login for
 * `gh-user`, an org/team slug for `team`, one of the fixed role names for
 * `role` ("author" | "reviewers" | "owners"), a guest invite id for
 * `guest`, the agent's registered channel name for `agent`, or an
 * install-scoped user tag for `local` (the M2 daemon's loopback
 * session), or a well-known component name for `system` (a
 * daemon-emitted event that has no human or agent origin — e.g.
 * `revkit-daemon` on `ask.expired` from the lazy expiry sweep, or
 * `revkit-reanchor` from the re-anchoring pipeline). PR #52 review:
 * a `system` kind is preferred over reusing `agent` for events the
 * agent never actually authored. */
export const authorSchema = z
  .object({
    kind: z.enum(authorKinds),
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
  })
  .strict();

export type Author = z.infer<typeof authorSchema>;
