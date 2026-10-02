// Pure derivations for the rail's resolved-thread and unread
// affordances (issue #60). Extracted from `rail.tsx` so unit tests
// (and any other module) can import them without triggering the
// rail bundle's DOM-side `mount()` call at import time.
//
// Everything in here is a plain function over data — no fetch, no
// DOM, no timers — so bun:test can run it in Node. The rail JSX
// side re-exports these through `rail.tsx` so the browser bundle
// still has one entry point.

/** Rail-side thread projection duck-type. Kept minimal — the rail
 * bundle deliberately does not import the review-core Zod schema,
 * so the browser payload stays small. The comment createdAt is
 * required so the unread derivation can watermark against agent
 * activity, not against every touch (see `latestAgentActivityOf`). */
export interface UnreadThread {
  readonly id: string;
  readonly status: "open" | "resolved" | "orphaned";
  readonly updatedAt: string;
  readonly comments: ReadonlyArray<{
    readonly author: { readonly kind: string };
    readonly createdAt: string;
  }>;
  readonly resolvedBy?: { readonly kind: string };
  readonly resolvedAt?: string;
}

/** Per-viewer "seen" state — a map from thread id to the
 * `latestAgentActivity` value the viewer last acknowledged
 * (a `createdAt` or `resolvedAt` ISO timestamp — NOT `updatedAt`,
 * which advances on every event including the reviewer's own
 * resolve / reopen and pipeline re-anchors). Stored in
 * localStorage. A missing entry means "never seen"; an entry equal
 * to or newer than the current `latestAgentActivity` means "up to
 * date". */
export type SeenMap = Readonly<Record<string, string>>;

/** localStorage key prefix for the seen map. The daemon's
 * `/-/health` `repoId` is appended so the bucket is keyed to THIS
 * repo, stable across daemon restarts on the same `--port` (issue
 * #60 PR #62 round-3 review — the per-start `instanceId` keying
 * wiped seen marks on every restart). `repoId` is a random tag
 * generated once and stored in `.revkit/repo-id` at mode 0600 —
 * never derived from the repo path, so `/-/health` cannot leak
 * filesystem layout. Bumped only if the SeenMap shape changes. */
export const SEEN_STORAGE_KEY_PREFIX = "revkit.rail.seen.v1";
export function seenStorageKeyFor(repoId: string | undefined): string {
  if (repoId === undefined || repoId.length === 0) return SEEN_STORAGE_KEY_PREFIX;
  return `${SEEN_STORAGE_KEY_PREFIX}.${repoId}`;
}

/** True when the thread has any agent activity — an agent-authored
 * comment OR a resolve by an agent. Cheaper predicate for callers
 * that only need the boolean; the value flavour is
 * `latestAgentActivityOf`. */
export function hasAgentActivity(thread: UnreadThread): boolean {
  return latestAgentActivityOf(thread) !== undefined;
}

/** The ISO timestamp of the newest agent-authored touch on this
 * thread — the max of every agent comment's `createdAt` and, when
 * the thread was resolved by an agent, `resolvedAt`. Returns
 * undefined when no agent has touched the thread. This is the
 * ONLY value the unread pill watermarks against; it deliberately
 * ignores `updatedAt` because that field advances on every
 * event, including the reviewer's own resolve / reopen and the
 * re-anchor pipeline's `thread.reanchored` / `thread.orphaned`
 * emissions (PR #62 review, issue #60 blocker). */
export function latestAgentActivityOf(thread: UnreadThread): string | undefined {
  let latest: string | undefined;
  for (const comment of thread.comments) {
    if (comment.author.kind !== "agent") continue;
    if (latest === undefined || comment.createdAt > latest) latest = comment.createdAt;
  }
  if (
    thread.status === "resolved" &&
    thread.resolvedBy?.kind === "agent" &&
    thread.resolvedAt !== undefined &&
    (latest === undefined || thread.resolvedAt > latest)
  ) {
    latest = thread.resolvedAt;
  }
  return latest;
}

/** Is this thread carrying agent activity the viewer has not seen?
 * "Unread" is true when `latestAgentActivityOf(thread)` is newer
 * than the viewer's `seen[thread.id]` mark — never when the
 * reviewer's own resolve, reopen, or a pipeline event bumped
 * `updatedAt`. Storage-unavailable failure paths call this with
 * an empty map, so the fallback default IS "unread everything
 * agent-touched" — louder than silent, so a reviewer never
 * misses an ack. */
export function isThreadUnread(thread: UnreadThread, seen: SeenMap): boolean {
  const latest = latestAgentActivityOf(thread);
  if (latest === undefined) return false;
  const lastSeen = seen[thread.id];
  if (lastSeen === undefined) return true;
  return latest > lastSeen;
}

/** Prune entries in `seen` whose thread id is not in `ids`. Called
 * on refetch so a resolved-then-deleted thread does not leak a
 * seen mark forever. Returns a new map only if a prune actually
 * happened, so callers can bail out of the write path when
 * nothing changed. */
export function pruneSeenMap(seen: SeenMap, ids: Iterable<string>): SeenMap {
  const keep = new Set(ids);
  let dropped = false;
  const next: Record<string, string> = {};
  for (const [id, ts] of Object.entries(seen)) {
    if (keep.has(id)) next[id] = ts;
    else dropped = true;
  }
  return dropped ? next : seen;
}

/** A short single-line excerpt of a comment body, for the
 * collapsed resolved-thread row. Whitespace is collapsed and long
 * lines are hard-truncated with an ellipsis so a
 * multi-paragraph reply doesn't blow up the row. */
export function excerptOf(body: string, max: number = 120): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1).trimEnd() + "…";
}

/** A coarse "N seconds ago" / "5 min ago" / "2 h ago" / "3 d ago"
 * label for the resolved-summary row. `now` defaults to
 * `Date.now()`; tests inject a deterministic value. Uses only
 * `Intl.RelativeTimeFormat` where available and falls back to a
 * plain string so the rail bundle keeps its zero-dependency
 * runtime footprint (ADR-0018). */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.round((t - now) / 1000);
  const abs = Math.abs(diffSec);
  const pickUnit = (): { unit: Intl.RelativeTimeFormatUnit; value: number } => {
    if (abs < 60) return { unit: "second", value: diffSec };
    if (abs < 3600) return { unit: "minute", value: Math.round(diffSec / 60) };
    if (abs < 86400) return { unit: "hour", value: Math.round(diffSec / 3600) };
    if (abs < 604_800) return { unit: "day", value: Math.round(diffSec / 86400) };
    if (abs < 2_592_000) return { unit: "week", value: Math.round(diffSec / 604_800) };
    if (abs < 31_536_000) return { unit: "month", value: Math.round(diffSec / 2_592_000) };
    return { unit: "year", value: Math.round(diffSec / 31_536_000) };
  };
  const { unit, value } = pickUnit();
  try {
    if (typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function") {
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
      return rtf.format(value, unit);
    }
  } catch {
    // Fall through to the manual label.
  }
  const suffix = value >= 0 ? " from now" : " ago";
  return `${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? "" : "s"}${suffix}`;
}

/** Read the "seen" map from `localStorage` under a given key.
 * `key` defaults to the unversioned prefix so tests that predate
 * per-instance keying keep working. Wrapped in try/catch; a
 * private window, cleared / blocked site data, or a throwing
 * accessor all resolve to `{}` — the safe default, which shows
 * every agent-touched thread as unread. */
export function readSeenMap(
  storage: Pick<Storage, "getItem"> | undefined = tryLocalStorage(),
  key: string = SEEN_STORAGE_KEY_PREFIX,
): SeenMap {
  if (storage === undefined) return {};
  try {
    const raw = storage.getItem(key);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, ts] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === "string" && typeof ts === "string" && ts.length > 0) out[id] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write the "seen" map to `localStorage` under a given key.
 * Wrapped in try/catch: a full quota or a blocked storage means
 * the mark won't persist across a reload, but the in-memory state
 * still moves so the current session isn't stuck. Never fatal. */
export function writeSeenMap(
  next: SeenMap,
  storage: Pick<Storage, "setItem"> | undefined = tryLocalStorage(),
  key: string = SEEN_STORAGE_KEY_PREFIX,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(key, JSON.stringify(next));
  } catch {
    // Storage unavailable / quota exceeded — the mark won't persist
    // across a reload, but the in-memory state still moves the
    // pill so this session isn't stuck. Never fatal.
  }
}

/** Access `window.localStorage` in an environment where `window`
 * might be undefined (unit tests under bun:test / Node). Returns
 * undefined if the accessor throws (Firefox strict privacy modes
 * throw on `window.localStorage` itself). */
function tryLocalStorage(): Storage | undefined {
  try {
    if (typeof globalThis === "undefined") return undefined;
    const w = globalThis as unknown as { localStorage?: Storage };
    return w.localStorage;
  } catch {
    return undefined;
  }
}

/** A localStorage-shaped surface that can be iterated. Enough of
 * the DOM Storage interface for `migrateSeenStorage`; kept narrow
 * so unit tests can pass an in-memory stand-in. */
export interface IterableStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Index key naming the live per-repo seen buckets on this origin,
 * oldest first. Deliberately OUTSIDE the `revkit.rail.seen.v1`
 * namespace so the bucket scan (which matches the bare prefix and
 * `prefix + "."`) never mistakes it for a bucket — an index listed in
 * its own index is the kind of self-reference that survives every
 * "delete the orphans" pass. Versioned with the bucket shape, since
 * an index written by an older shape would vouch for keys the newer
 * code cannot interpret. */
export const SEEN_INDEX_KEY = "revkit.rail.seen.index.v1";

/** How many per-repo seen buckets one origin keeps. Eight covers a
 * working set (the current repo plus a handful of alternates served
 * on the same fixed `--port`) while bounding what a long-lived
 * browser profile can accumulate to a size no eviction policy ever
 * gets to — the round-3 pile this replaced. */
export const SEEN_BUCKET_LIMIT = 8;

/** True for a per-repo bucket key (`revkit.rail.seen.v1.<repoId>`).
 * The bare `revkit.rail.seen.v1` key is NOT a bucket: it only ever
 * served the window before `/-/health` resolved a `repoId`. */
function isSeenBucketKey(key: string): boolean {
  return key.startsWith(`${SEEN_STORAGE_KEY_PREFIX}.`);
}

/** Parse the LRU index. Returns `[]` for anything we cannot trust —
 * a missing key, non-JSON, a non-array payload, or an entry that is
 * not a string bucket key. The failure mode is deliberate and
 * one-directional: an entry we refuse to trust vouches for nothing,
 * so its bucket gets reclaimed and the marks read as UNREAD again.
 * A mark can never be manufactured into the current bucket from an
 * index entry we could not read, so the worst case is a re-fired
 * pill (loud), never a silent ack for the wrong repo. */
function readSeenIndex(storage: Pick<IterableStorage, "getItem">): string[] {
  let raw: string | null;
  try {
    raw = storage.getItem(SEEN_INDEX_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || !isSeenBucketKey(entry)) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
  }
  return out;
}

/** Every seen-bucket key the browser currently holds, snapshotted
 * before any write so the passes below see a stable list. */
function snapshotSeenBucketKeys(storage: IterableStorage): string[] {
  const found: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (k === null) continue;
    if (k === SEEN_STORAGE_KEY_PREFIX || isSeenBucketKey(k)) found.push(k);
  }
  return found;
}

/** Called once on mount, after `GET /-/health` returned `repoId`.
 *
 *  1. Folds the BARE key into the target-key bucket, preferring the
 *     newer per-thread ISO timestamp. That key only ever holds marks
 *     made on THIS origin before `/-/health` resolved, so it is the
 *     one bucket whose contents legitimately move between repos
 *     (issue #60 PR #62 round-3: the "early mark race").
 *  2. Touches the target in a bounded LRU index
 *     (`SEEN_INDEX_KEY`), keeping every bucket the previous index
 *     vouched for and evicting oldest-first past `SEEN_BUCKET_LIMIT`.
 *  3. Reclaims only the keys the new index does not list, plus the
 *     bare key.
 *
 * **Why the other buckets survive (issue #63).** This used to merge
 * EVERY `revkit.rail.seen.v1*` bucket into the target and then delete
 * them all. An origin is `127.0.0.1:<port>`, so two repos served one
 * after the other on the same fixed `--port` share one localStorage:
 * opening repo Y therefore wiped repo X's acks, and the reviewer had
 * to re-acknowledge them. Only the bare key crosses that boundary
 * now; a repoId bucket belongs to the repo that minted the id.
 *
 * Order matters: the index is written BEFORE the reclaim pass, so a
 * storage quota failure (which throws out to the catch below) can
 * only ever leave buckets un-reclaimed, never buckets deleted with no
 * index left to justify them.
 *
 * Every branch is wrapped in try/catch — the reviewer's session is
 * never fatal on a storage failure; the pill just re-fires once, then
 * the seen map catches up on the next mark. */
export function migrateSeenStorage(storage: IterableStorage | undefined, targetKey: string): void {
  if (storage === undefined) return;
  try {
    const foundKeys = snapshotSeenBucketKeys(storage);
    const found = new Set(foundKeys);
    // Fold the pre-`repoId` bucket into the resolved one. Read the
    // target first so a per-thread mark already under the target's
    // own bucket wins ties.
    const merged: Record<string, string> = {};
    const readOne = (k: string): void => {
      const map = readSeenMap(storage, k);
      for (const [id, ts] of Object.entries(map)) {
        const cur = merged[id];
        if (cur === undefined || ts > cur) merged[id] = ts;
      }
    };
    if (foundKeys.includes(targetKey)) readOne(targetKey);
    if (foundKeys.includes(SEEN_STORAGE_KEY_PREFIX) && SEEN_STORAGE_KEY_PREFIX !== targetKey) {
      readOne(SEEN_STORAGE_KEY_PREFIX);
    }
    writeSeenMap(merged, storage, targetKey);
    // Rebuild the LRU: previous members that still exist (and are
    // not the target, which we re-touch), then the target itself.
    // Order is oldest first, so `shift()` evicts oldest-first.
    const next: string[] = [];
    for (const k of readSeenIndex(storage)) {
      if (k === targetKey || next.includes(k)) continue;
      if (!found.has(k)) continue;
      next.push(k);
    }
    if (isSeenBucketKey(targetKey)) next.push(targetKey);
    while (next.length > SEEN_BUCKET_LIMIT) next.shift();
    storage.setItem(SEEN_INDEX_KEY, JSON.stringify(next));
    // Reclaim what the index cannot vouch for. The bare key is not a
    // member (it is not a repo bucket) so it lands here, and a target
    // that IS the bare key is never removed — that would delete the
    // bucket the rail is about to read.
    const keep = new Set(next);
    keep.add(targetKey);
    for (const k of foundKeys) {
      if (keep.has(k)) continue;
      try {
        storage.removeItem(k);
      } catch {
        // Skip; not fatal.
      }
    }
  } catch {
    // On any partial failure we keep the pre-migration state.
    // The pill will re-fire, but the reviewer can still mark it
    // seen on the next interaction.
  }
}
