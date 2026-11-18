// Barrel — the daemon's public surface for the CLI dispatcher and
// tests. Keeping the barrel narrow means a consumer that needs a piece
// of internal state (a schema, a subscriber implementation) has to
// import the file directly, which shows up in code review.

export { startDaemon, type DaemonHandle, type StartDaemonOptions } from "./daemon.ts";
export { runServeCommand } from "./cli.ts";
export {
  acquireAndPublish,
  daemonLockPath,
  findRunningDaemon,
  readServeState,
  readServeStateVerbose,
  removeServeState,
  serveStatePath,
  writeServeState,
  type ServeState,
} from "./serve-state.ts";
export { acquireDaemonLock, type DaemonLock } from "./daemon-lock.ts";
export { SqliteThreadStore, type SqliteThreadStoreOptions } from "./sqlite-store.ts";
// #279 — composable handler seams. The host entry (#245) imports
// these to spin up its own listener under the same request handler
// as the local daemon.
export {
  createLoopbackGuardPolicy,
  createPublicOriginGuardPolicy,
  isLoopbackHost,
  isLoopbackOrigin,
  isSecFetchAcceptable,
  type GuardOutcome,
  type GuardPolicy,
  type GuardRefusalReason,
  type LoopbackGuardPolicyOptions,
  type OriginCheckInput,
  type PublicOriginGuardPolicyOptions,
} from "./guard-policy.ts";
export {
  AGENT_ONLY_ROUTE_GROUP_NAMES,
  assertRouteGroupsCompatibleWithPolicy,
  HOST_TARGET_ROUTE_GROUPS,
  LOCAL_DAEMON_ROUTE_GROUPS,
  type RouteGroups,
} from "./route-groups.ts";
export {
  createAuthProviderIdentityResolver,
  createLocalIdentityResolver,
  createStaticIdentityResolver,
  type AuthProviderIdentityResolverOptions,
  type IdentityResolution,
  type IdentityResolver,
  type LocalIdentityResolverOptions,
  type StaticIdentityResolverOptions,
} from "./identity-resolver.ts";
