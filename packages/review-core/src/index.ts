// `@revkit/review-core` — shared review model: dual anchors (ADR-0006),
// typed authors (ADR-0011), append-only event log (ADR-0006 / ADR-0007),
// pure reducer, in-memory store, revision hash, export/import archive
// (ADR-0025). Runtime-neutral: no `node:*` / `bun:*` / DOM-only imports,
// so the same core runs in Bun (M2 daemon, M3 local review) and in a
// Cloudflare Worker (M4 hosted). Enforced by `test/src-imports.test.ts`
// and `test/browser-build.test.ts`.

export { anchorSchema, textQuoteSchema, type Anchor, type TextQuote } from "./anchor.ts";
export { authorKinds, authorSchema, type Author, type AuthorKind } from "./author.ts";
export {
  askAnswerSchema,
  askKinds,
  askSchema,
  type Ask,
  type AskAnswer,
  type AskKind,
} from "./asks.ts";
export {
  eventsFromArchive,
  exportArchive,
  parseArchive,
  threadArchiveSchema,
  type ThreadArchive,
} from "./export.ts";
export {
  presenceStateSchema,
  reviewEventKinds,
  reviewEventSchema,
  type PresenceState,
  type ReviewEvent,
  type ReviewEventInput,
  type ReviewEventKind,
} from "./events.ts";
export { reduce } from "./reducer.ts";
export { revisionOf } from "./revision.ts";
export {
  CURRENT_SCHEMA_VERSION,
  acceptedSchemaVersions,
  schemaVersionField,
} from "./schema-version.ts";
export {
  InMemoryThreadStore,
  ThreadStoreAppendError,
  type AppendRejection,
  type Clock,
  type ThreadStore,
} from "./store.ts";
export {
  commentSchema,
  threadFilterSchema,
  threadSchema,
  threadStatusSchema,
  threadStatuses,
  type Comment,
  type Thread,
  type ThreadFilter,
  type ThreadStatus,
} from "./thread.ts";
export { isoTimestamp } from "./timestamp.ts";
