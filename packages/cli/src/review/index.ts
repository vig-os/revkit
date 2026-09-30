// Barrel — the public surface of the `revkit review` subcommand and
// its pure building blocks. Kept narrow so a consumer that needs an
// internal helper imports the file directly (which shows up in code
// review).

export {
  CONTENT_ALLOWED_EXTENSIONS,
  CONTENT_ALLOWLIST_PREFIXES,
  classifyPath,
  isUnderContentPrefix,
  type PathClass,
} from "./content-allowlist.ts";
export {
  computeToolingDiff,
  formatToolingDiff,
  type ToolingChange,
  type ToolingDiff,
} from "./tooling-diff.ts";
export {
  ensurePrCommits,
  hasCommit,
  parseGithubRemoteUrl,
  perPrRoot,
  perPrSqlitePath,
  perPrStateDir,
  readFetchedHeadSha,
  readOriginUrl,
  reviewTargetDir,
  reviewTargetExists,
  reviewsRoot,
  type EnsurePrCommitsOptions,
} from "./fetch-pr.ts";
export {
  buildChildEnv,
  BUILD_ENV_ALLOWLIST,
  BUILD_ENV_TOKEN_DENYLIST,
  defaultDistOutDir,
  runSafeBuild,
  type RunSafeBuildOptions,
  type SpawnLike,
  type SpawnResult,
} from "./build.ts";
export {
  buildSafeGitArgs,
  runSafeGit,
  runSafeGitOrThrow,
  SAFE_GIT_CONFIG_OVERRIDES,
  SAFE_GIT_TOPLEVEL_FLAGS,
  SafeGitError,
} from "./git-safe.ts";
export {
  BlobTooLargeError,
  formatRefusal,
  listTree,
  materializeSafeTree,
  MaterializeError,
  readBlob,
  validatePath,
  validateSymlinkTarget,
  type MaterializeOptions,
  type MaterializeOutcome,
  type MaterializeRefusal,
  type TreeEntry,
} from "./materialize.ts";
export {
  commentIdOfFactory,
  populateStoreFromPr,
  threadIdOf,
  type PopulateOptions,
  type PopulateOutcome,
} from "./import-threads.ts";
export {
  defaultReviewEnv,
  isPlausibleSha,
  parseReviewArgs,
  runReviewCommand,
  trustMatches,
  type ParsedReviewArgs,
  type RunReviewEnv,
  type RunReviewResult,
} from "./cli.ts";
export { parsePrRef, type PrRefParseResult } from "./pr-ref.ts";
