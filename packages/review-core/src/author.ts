// Typed actors (ADR-0011). `@` is only for actors — GitHub users, invited
// guests, teams, roles resolved at send-time (`@author`, `@reviewers`,
// `@owners`), and agent sessions. Storing the kind alongside the id lets a
// rename or a role-membership change never break an old comment, and lets
// each surface render the mention its own way (@login on GitHub, "Name
// (guest)" for guests, and so on).
import { z } from "zod";

/** The kinds of actor an event or a mention may reference (ADR-0011). Kept
 * as a const tuple so the Zod enum, TypeScript type and any downstream
 * consumer iterate the same list. */
export const authorKinds = ["gh-user", "guest", "team", "role", "agent"] as const;
export type AuthorKind = (typeof authorKinds)[number];

/** Author of an event — a typed mention with an id and an optional display
 * name. `id` is the surface-appropriate identifier: a GitHub login for
 * `gh-user`, an org/team slug for `team`, one of the fixed role names for
 * `role` ("author" | "reviewers" | "owners"), a guest invite id for
 * `guest`, or the agent's registered channel name for `agent`. */
export const authorSchema = z
  .object({
    kind: z.enum(authorKinds),
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
  })
  .strict();

export type Author = z.infer<typeof authorSchema>;
