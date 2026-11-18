// `revkit host` allowed-groups gate (ADR-0026 §Authorization,
// implementation scope of #195; the "read-vs-comment allowlist"
// clause from the Trusted reverse-proxy identity feature request).
//
// Rule shape decided in this issue (see the PR body and the comment
// filed against #245): the smallest shape that passes the test
// matrix — a list of `{ pathPrefix, mode: view|comment, groups[] }`
// rules. Resolution:
//
//   1. If the rule list is empty, every authenticated identity gets
//      `comment` (ADR-0026 §Authorization explicit default).
//   2. Otherwise, walk the rules and pick the LONGEST matching
//      `pathPrefix` whose `groups` intersect the identity's groups.
//      That rule's `mode` is the identity's capability on this
//      request.
//   3. No matching rule → refused with `group-no-match`. That is
//      the fail-closed answer the ADR requires.
//
// Richer shapes (entitlement regex, per-document glob, ordered
// composition with other providers) are explicitly out of scope and
// recorded as a follow-up on the gate's rule-language question.

import type { Capability, Identity } from "@revkit/review-core";
import type { GroupsRule } from "./config.ts";

/** Outcome of the gate: a capability (`view` or `comment`) the
 * request may act under, or a refusal reason the caller turns into
 * 403. */
export type AuthorizeResult =
  | { readonly kind: "allow"; readonly capability: Capability }
  | { readonly kind: "deny"; readonly reason: AuthorizeDenyReason };

export type AuthorizeDenyReason =
  /** Rules are configured but the identity's groups match none of
   * them for this path. Fail-closed answer (ADR-0026 §Identity). */
  | "group-no-match"
  /** The matched rule grants `view` but the request is a write
   * (POST/PUT/PATCH/DELETE). A group gate that explicitly excludes a
   * reader from writes keeps `view` meaningful. */
  | "group-no-comment";

export interface AuthorizeInput {
  /** Identity returned by the auth provider. */
  readonly identity: Identity;
  /** Comma-separated groups header value as received from the proxy
   * (`"staff,reviewers"`), or `null` when no groups header exists.
   * Parsed here, not in the provider, so the provider stays a
   * one-identity shape while the gate owns the attribute shape. */
  readonly groupsHeader: string | null;
  /** Path the request addresses, AFTER the base-path prefix has been
   * stripped. `/api/threads` on a root deployment; also `/api/threads`
   * on a `/review`-based deployment (the strip happens before the
   * gate runs). */
  readonly path: string;
  /** Whether this request mutates state (POST/PUT/PATCH/DELETE).
   * Decides whether a `view` rule is enough. */
  readonly isWrite: boolean;
}

/** Decide view / comment / refuse for a single request.
 *
 * `rules` is the config-loaded list. Caller passes it directly so a
 * test can exercise the gate without a server. */
export function authorize(rules: readonly GroupsRule[], input: AuthorizeInput): AuthorizeResult {
  if (rules.length === 0) {
    // No gate configured → ADR-0026 default (any authenticated
    // identity may comment).
    return { kind: "allow", capability: "comment" };
  }

  const identityGroups = parseGroups(input.groupsHeader);

  // Longest `pathPrefix` match whose `groups` intersect the
  // identity's groups.
  let best: GroupsRule | undefined;
  for (const rule of rules) {
    if (!matchesPrefix(input.path, rule.pathPrefix)) continue;
    const intersects = rule.groups.some((group) => identityGroups.has(group));
    if (!intersects) continue;
    if (best === undefined || rule.pathPrefix.length > best.pathPrefix.length) {
      best = rule;
    }
  }
  if (best === undefined) return { kind: "deny", reason: "group-no-match" };

  if (input.isWrite && best.mode === "view") {
    return { kind: "deny", reason: "group-no-comment" };
  }
  return { kind: "allow", capability: best.mode };
}

/** Split a comma-separated groups header into a Set.
 *
 * - `null` / empty → empty set (treated as "no groups").
 * - Values trimmed; empty values dropped.
 * - Case-SENSITIVE: the ADR leaves group identifiers opaque, and
 *   folding would be a silent widening of a rule configured in one
 *   case against groups asserted in another. */
function parseGroups(header: string | null): Set<string> {
  const groups = new Set<string>();
  if (header === null) return groups;
  for (const raw of header.split(",")) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) groups.add(trimmed);
  }
  return groups;
}

/** Prefix match: `""` matches every path; `"/api"` matches `/api`
 * and `/api/threads` but NOT `/apikey` — the match requires either
 * an exact hit or a `/` immediately after the prefix. */
function matchesPrefix(path: string, prefix: string): boolean {
  if (prefix.length === 0) return true;
  if (!path.startsWith(prefix)) return false;
  if (path.length === prefix.length) return true;
  return path.charAt(prefix.length) === "/";
}
