// `@revkit/cli/host` — public exports for the Linux-host target
// server entry (ADR-0026 §"Plain Linux host / VM", sub-issue 2 of
// #195). Imported by the `revkit host` dispatcher in
// `packages/cli/src/index.ts` and by the test suite.

export {
  hostConfigSchema,
  parseHostConfig,
  HostConfigError,
  type HostConfig,
  type GroupsRule,
  type ListenConfig,
  type TrustedProxyConfig,
} from "./config.ts";
export {
  authorize,
  type AuthorizeDenyReason,
  type AuthorizeInput,
  type AuthorizeResult,
} from "./authorize.ts";
export {
  applyHostResponseHeaders,
  type HostHeaderContext,
  type ResponseKind,
} from "./headers.ts";
export {
  rewriteAbsolutePaths,
  startHostServer,
  stripBasePath,
  type HostHandle,
  type LineWriter,
  type StartHostOptions,
} from "./server.ts";
export { runHostCommand, parseHostArgs, type RunHostEnv, type RunHostResult } from "./host-cli.ts";
