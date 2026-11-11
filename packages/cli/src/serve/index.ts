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
