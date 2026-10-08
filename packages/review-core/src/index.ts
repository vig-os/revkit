// `@revkit/review-core` — shared review model: dual anchors (ADR-0006),
// typed authors (ADR-0011), append-only event log (ADR-0006 / ADR-0007),
// pure transition validator, pure reducer, in-memory store with
// import/export, revision hash, and the archive shape (ADR-0025).
// Runtime-neutral: no `node:*` / `bun:*` / DOM-only imports, so the
// same core runs in Bun (M2 daemon, M3 local review) and in a
// Cloudflare Worker (M4 hosted). Enforced by `test/src-imports.test.ts`,
// `test/browser-build.test.ts` and the src-only tsconfig
// (`tsconfig.src.json`) that typechecks without bun globals.

export {
  anchorPathSchema,
  anchorSchema,
  anyAnchorSchema,
  isLineAnchor,
  isUnanchoredAnchor,
  textQuoteSchema,
  unanchoredAnchorSchema,
  type Anchor,
  type AnyAnchor,
  type TextQuote,
  type UnanchoredAnchor,
} from "./anchor.ts";
export {
  anchorToPrComment,
  anchorToPrCommentWithHunks,
  fileFallbackPreamble,
  findFile,
  prCommentToAnchor,
  type AnchorMapOptions,
  type AnchorMapResult,
  type FileFallbackReason,
  type OrphanReason,
  type PrCommentSource,
  type PrCommentTarget,
  type PrCommentToAnchorResult,
  type PrFile,
  type PrFileComment,
  type PrLineComment,
} from "./anchor-map.ts";
export {
  composeFileFallbackBody,
  DEFAULT_GITHUB_BASE_URL,
  DEFAULT_GITHUB_GRAPHQL_URL,
  DEFAULT_MAX_FILES_PAGES,
  DEFAULT_RETRY_POLICY,
  DEFAULT_USER_AGENT,
  GITHUB_API_VERSION,
  GitHubAdapter,
  GitHubApiError,
  GitHubRateLimitError,
  githubExternal,
  nextPageUrl,
  PrContext,
  retryAfterMs,
  shouldRetry,
  verifyContentAgainstDiffHunk,
  type AddPendingReviewThreadInput,
  type FindOrCreatePendingReviewResult,
  type GhReviewComment,
  type GhReviewThread,
  type GitHubAdapterOptions,
  type PendingReview,
  type PendingReviewComment,
  type ViewerReviewSummary,
  type PrRef,
  type PullRequestSummary,
  type RetryPolicy,
  type ReviewSubmissionEvent,
  type SubmitReviewInput,
  type ThreadSnapshot,
} from "./github-adapter.ts";
export {
  newSideLines,
  oldSideLines,
  parsePatch,
  rangeIsOnRightSide,
  type Hunk,
  type HunkLine,
  type HunkLineKind,
} from "./patch.ts";
export {
  buildQuoteFromLines,
  buildQuoteFromOffsets,
  DEFAULT_QUOTE_CONTEXT_CHARS,
  lineStartsOf,
  type BuildQuoteOptions,
} from "./quote.ts";
export { redactTokenInMessage, type TokenSource } from "./token-source.ts";
export { ID_REGEX, idSchema, isValidId } from "./id.ts";
export { isValidRepoRelativePath } from "./path.ts";
export { authorKinds, authorSchema, type Author, type AuthorKind } from "./author.ts";
export {
  askAnswerSchema,
  askFileSchema,
  askFilterSchema,
  askKinds,
  askRecordSchema,
  askSchema,
  askStatusSchema,
  askStatuses,
  type Ask,
  type AskAnswer,
  type AskFile,
  type AskFilter,
  type AskKind,
  type AskRecord,
  type AskStatus,
} from "./asks.ts";
export {
  matchesAskFilter,
  reduceAsks,
  selectAsks,
} from "./asks-view.ts";
export { exportArchive, parseArchive, threadArchiveSchema, type ThreadArchive } from "./export.ts";
export {
  DEFAULT_DELIVERY_MODE,
  currentDeliveryMode,
  deliveredCommentIds,
  isPending,
  pendingCommentIds,
} from "./delivery.ts";
export {
  deliveryModeSchema,
  handoverTriggerSchema,
  presenceStateSchema,
  reanchorMethodSchema,
  reviewEventKinds,
  reviewEventSchema,
  reviewSubmitEventSchema,
  type DeliveryMode,
  type HandoverTrigger,
  type PresenceState,
  type ReanchorEventMethod,
  type ReviewEvent,
  type ReviewEventInput,
  type ReviewEventKind,
  type ReviewSubmitEvent,
} from "./events.ts";
export {
  isPendingReviewStale,
  reduceReviewState,
  reduceThreadLifecycleStates,
  type AgentDraft,
  type CommentSyncState,
  type DroppedReviewerIntent,
  type OpenPendingReview,
  type PendingReviewComment as DerivedPendingReviewComment,
  type ReviewState,
  type SyncFingerprint,
  type TerminalReview,
  type ThreadLifecycleState,
} from "./review-state.ts";
export {
  alignMatchedText,
  buildLineStartIndex,
  classifySpan,
  DEFAULT_ANCHOR_CONTEXT_CHARS,
  DEFAULT_DIFF_TIMEOUT_SECONDS,
  DEFAULT_HUNK_SLACK,
  DEFAULT_MIN_MODIFIED_EQUAL_FRACTION,
  DEFAULT_MIN_MOVE_CONTEXT,
  DEFAULT_MIN_QUOTE_SCORE,
  findHunkWindow,
  lineToOffset,
  offsetToLine,
  prepareReanchor,
  reanchor,
  reanchorEvent,
  reanchorWith,
  toLF,
  tryMove,
  type LineRange,
  type ReanchorContext,
  type ReanchorMethod,
  type ReanchorOptions,
  type ReanchorResult,
  type SpanClass,
} from "./reanchor.ts";
export { reduce } from "./reducer.ts";
export { GIT_COMMIT_HEX_REGEX, SHA256_HEX_REGEX, revisionOf } from "./revision.ts";
export {
  CURRENT_SCHEMA_VERSION,
  acceptedSchemaVersions,
  schemaVersionField,
} from "./schema-version.ts";
export {
  InMemoryThreadStore,
  matchesFilter,
  prepareImport,
  selectThreads,
  ThreadStoreAppendError,
  ThreadStoreImportError,
  ThreadStoreOpenError,
  storeRejectionMessage,
  quoteStoreDiagnostic,
  persistedLogError,
  parsePersistedEvent,
  type PersistedEventRow,
  type AppendRejection,
  type Clock,
  type ImportRejection,
  type ThreadStore,
} from "./store.ts";
export {
  commentSchema,
  externalRefSchema,
  threadFilterSchema,
  threadSchema,
  threadStatusSchema,
  threadStatuses,
  type Comment,
  type ExternalRef,
  type Thread,
  type ThreadFilter,
  type ThreadStatus,
} from "./thread.ts";
export { isoTimestamp } from "./timestamp.ts";
export {
  cloneLogState,
  emptyLogState,
  validateAnswerAgainstSpec,
  validateNext,
  type LogState,
  type ValidationResult,
} from "./validator.ts";
