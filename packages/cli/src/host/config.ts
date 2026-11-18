// `revkit host` — typed, Zod-validated config for the Linux-host
// target (ADR-0026 §"Plain Linux host / VM"). Every field is checked
// at startup; a missing or malformed field is a startup refusal, not
// a lazy runtime refusal.
//
// Loaded from a JSON config file plus environment-variable overrides
// in `host-cli.ts`. Kept separate from the server so a test can parse
// a fixture file without binding a socket.

import { z } from "zod";

/** Listen mode: unix socket (ADR-0026 default) or loopback TCP
 * (opt-in, explicitly single-tenant). */
export const listenSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unix"),
    /** Absolute path to the socket the backend creates. */
    socketPath: z.string().min(1),
    /** OS group the socket is chgrp'd to. Owner-read/write + this
     * group's read/write; nothing for others (mode 0660). The group
     * is resolved at startup — unknown group is a startup refusal. */
    proxyGroup: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("tcp"),
    /** Loopback host the backend binds to. Non-loopback is refused
     * (a plain-host target must not bind to a public interface). */
    host: z.string().min(1),
    port: z.number().int().min(0).max(65535),
  }).strict(),
]);
export type ListenConfig = z.infer<typeof listenSchema>;

/** ADR-0026 §Authorization + the owner's "read-vs-comment allowlist"
 * clause: each rule names a path prefix, a mode (`view`-only or
 * `comment`) and the set of groups that may act under it. The gate
 * walks the rules in order, picks the longest-prefix match whose
 * groups the identity carries, and refuses with 403 when no rule
 * matches a configured rule set. No rules → any authenticated
 * identity may comment. Rule shape decided in this issue (see
 * commit log and the comment on #245): list-of-groups per
 * path-prefix; regex / glob / per-document matching is a follow-up. */
export const groupsRuleSchema = z.object({
  /** URL path prefix the rule matches against (after base-path is
   * stripped). An empty string matches every path; a leading `/`
   * is required so a config typo (`api`) does not match `/apikey`. */
  pathPrefix: z.string().regex(/^(|\/.*)$/, "pathPrefix must be empty or start with /"),
  /** Capability granted on match. `view` refuses writes with 403
   * `group-no-comment`; `comment` allows them. */
  mode: z.enum(["view", "comment"]),
  /** Groups whose presence in the identity's `groups` attribute
   * grants `mode`. A string match (case-sensitive); empty list is
   * refused at validation (a rule nobody matches is dead code and
   * would silently fail-closed every user). */
  groups: z.array(z.string().min(1)).min(1),
}).strict();
export type GroupsRule = z.infer<typeof groupsRuleSchema>;

/** Trusted-proxy identity source. Mirrors `TrustedProxyAuthProviderConfig`
 * in review-core but spelled as a config shape (no `capability`: the
 * allowed-groups gate decides view-vs-comment, not the provider). */
export const trustedProxySchema = z.object({
  /** Header name carrying the stable subject id (required). */
  subjectHeader: z.string().min(1),
  /** Header name carrying the display name (optional). */
  displayNameHeader: z.string().min(1).optional(),
  /** Header name carrying the comma-separated groups list (optional;
   * required when `authorization.rules` is non-empty). */
  groupsHeader: z.string().min(1).optional(),
}).strict();
export type TrustedProxyConfig = z.infer<typeof trustedProxySchema>;

/** Full host-target config as loaded from JSON. */
export const hostConfigSchema = z.object({
  listen: listenSchema,
  /** Absolute origin (`scheme://host[:port]`) the reverse proxy
   * exposes to the browser. `Host` allowlist, `Origin` checks and
   * the CSP all name this origin. Trailing slash refused. */
  publicOrigin: z.string().regex(
    /^https?:\/\/[^/\s]+$/,
    "publicOrigin must be scheme://host[:port] with no trailing slash",
  ),
  /** Hosts to accept in the `Host` header (DNS-rebinding defence).
   * Each entry is a `host[:port]`, matched case-insensitively. At
   * least one entry; typically the host part of `publicOrigin`. */
  hostAllowlist: z.array(z.string().min(1)).min(1),
  /** Sub-path the deployment is reached under
   * (`https://host/review/...`). Empty string = root deployment
   * (vhost). Non-empty must start with `/` and not end with `/`. */
  basePath: z.string().regex(
    /^(|\/[^/].*[^/]|\/[^/]+)$/,
    "basePath must be empty or start with / and not end with /",
  ).default(""),
  /** Absolute path to the SQLite file the host target reads and
   * writes. The process must own and have write access to the
   * file. Survives restarts (ADR-0026 §State). */
  sqlitePath: z.string().min(1),
  /** Absolute path to the directory the backend serves static site
   * files from. Realpath-resolved at startup; a missing directory
   * is a startup refusal. */
  staticDir: z.string().min(1),
  /** Trust bound: either "the listener is a unix socket" (filesystem
   * permissions are the check) or an explicit allowlist of trusted
   * TCP peer addresses / CIDR ranges. Defaults to "trust the
   * listener" so a unix-socket deployment needs no extra config. */
  trust: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unix-socket") }).strict(),
    z.object({ kind: z.literal("peers"), peers: z.array(z.string().min(1)).min(1) }).strict(),
  ]),
  identity: trustedProxySchema,
  authorization: z.object({
    /** Ordered list; longest matching `pathPrefix` wins. Empty list
     * = no gate (any authenticated identity may comment). */
    rules: z.array(groupsRuleSchema).default([]),
  }).strict().default({ rules: [] }),
}).strict();
export type HostConfig = z.infer<typeof hostConfigSchema>;

/** Parse an unknown value into a `HostConfig` or throw a
 * `HostConfigError` that names every validation failure (every issue,
 * not just the first — so a one-shot startup message lists every fix
 * needed). */
export function parseHostConfig(raw: unknown): HostConfig {
  const result = hostConfigSchema.safeParse(raw);
  if (result.success) {
    return validateCrossFields(result.data);
  }
  const lines = result.error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `  - ${path}: ${issue.message}`;
  });
  throw new HostConfigError(`revkit host: config has ${result.error.issues.length} problem(s):\n${lines.join("\n")}`);
}

/** Startup refusal for a malformed config. Thrown by `parseHostConfig`
 * and by cross-field checks (peer list only with TCP listener,
 * groups header required when rules exist, …). */
export class HostConfigError extends Error {
  override readonly name = "HostConfigError";
}

/** Rules that span two fields (zod validates one field at a time). */
function validateCrossFields(config: HostConfig): HostConfig {
  if (config.listen.kind === "tcp") {
    // Loopback-only (ADR-0026 §Network: "Loopback TCP is an
    // explicitly documented single-tenant option only"). Wildcard
    // and non-loopback addresses are refused.
    const host = config.listen.host;
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
      throw new HostConfigError(
        `revkit host: listen.host must be a loopback address (127.0.0.1, ::1 or localhost); got ${JSON.stringify(host)}`,
      );
    }
    if (config.trust.kind === "unix-socket") {
      throw new HostConfigError(
        "revkit host: trust.kind=unix-socket is incompatible with listen.kind=tcp; use trust.peers for a TCP listener",
      );
    }
  }
  if (config.listen.kind === "unix" && config.trust.kind === "peers") {
    throw new HostConfigError(
      "revkit host: trust.peers is only valid with listen.kind=tcp; a unix socket's trust is its filesystem permissions",
    );
  }
  if (config.authorization.rules.length > 0 && config.identity.groupsHeader === undefined) {
    throw new HostConfigError(
      "revkit host: authorization.rules is non-empty but identity.groupsHeader is not configured; the gate cannot read groups to check against",
    );
  }
  // Base-path rules: cannot shadow the configured hosts (defence-in-
  // depth; a `basePath` of `/.well-known` would collide badly with
  // reserved URLs).
  if (config.basePath.length > 0 && !config.basePath.startsWith("/")) {
    // Belt-and-braces: already enforced by the regex.
    throw new HostConfigError(`revkit host: basePath must start with /; got ${JSON.stringify(config.basePath)}`);
  }
  return config;
}
