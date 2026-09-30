// Public exports of the `revkit mcp` module. Kept small — the CLI
// glue lives in `cli.ts`; the individual concerns live in their own
// files so a test can pick just what it needs.
export { runMcpCommand, parseMcpArgs, type RunMcpEnv, type RunResult } from "./cli.ts";
export {
  ensureDaemon,
  verifyDaemonInstance,
  type Bootstrapped,
  type BootstrapOptions,
} from "./daemon-bootstrap.ts";
export { DaemonClient, type DaemonClientOptions } from "./daemon-client.ts";
export {
  startEventSubscriber,
  type EventSubscriberOptions,
  type EventSubscriberHandle,
  type WireEvent,
} from "./event-subscriber.ts";
export {
  startChannelServer,
  formatChannelPayload,
  THREADS_TOOL,
  REPLY_TOOL,
  RESOLVE_TOOL,
  type ChannelServerOptions,
  type ChannelServerHandle,
  type ChannelPayload,
} from "./channel-server.ts";
