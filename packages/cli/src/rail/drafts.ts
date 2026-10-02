// Reply-draft persistence for the rail.
//
// Drafts exist so a reload (the rail's own live refresh, a crash, a
// closed laptop lid) does not lose half-typed prose. They are NOT a
// log: an unattended tab left open for days would otherwise keep every
// draft it ever held, and a reviewer returning to a long-lived session
// would find prose they abandoned weeks ago sitting in a composer with
// no way to tell it from something they meant to send. So every draft
// carries a timestamp and expires.
//
// Storage is passed in rather than reached for, so the expiry logic is
// testable without a DOM; `rail.tsx` hands it `window.sessionStorage`.

/** How long a saved reply draft survives without being restored.
 *
 * A week is far longer than any real interruption (a reload takes
 * milliseconds; a closed laptop is hours) and short enough that a
 * stale draft cannot be mistaken for a live one. */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const DRAFT_KEY_PREFIX = "revkit.rail.draft:";

/** The slice of the Web Storage API this module needs. */
export interface DraftStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What is stored per draft. Wrapping the text with a timestamp makes
 * expiry decidable from the value alone. */
export interface StoredDraft {
  readonly savedAt: number;
  readonly text: string;
}

export function draftKey(threadId: string): string {
  return `${DRAFT_KEY_PREFIX}${threadId}`;
}

export function encodeDraft(text: string, now: number): string {
  return JSON.stringify({ savedAt: now, text } satisfies StoredDraft);
}

/** Read one draft, or `undefined` if it is absent, malformed, or past
 * its TTL. A malformed value is REMOVED rather than guessed at: the
 * pre-TTL bare-string shape is treated as unrecoverable, because
 * restoring it blind is exactly the stale-draft problem this module
 * exists to prevent. */
export function readDraft(
  storage: DraftStorage | undefined,
  threadId: string,
  now: number,
): StoredDraft | undefined {
  if (storage === undefined) return undefined;
  const key = draftKey(threadId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    removeDraft(storage, threadId);
    return undefined;
  }
  const candidate = parsed as { savedAt?: unknown; text?: unknown } | null;
  if (
    typeof candidate !== "object" || candidate === null ||
    typeof candidate.savedAt !== "number" ||
    typeof candidate.text !== "string"
  ) {
    removeDraft(storage, threadId);
    return undefined;
  }
  if (now - candidate.savedAt > DRAFT_TTL_MS) {
    removeDraft(storage, threadId);
    return undefined;
  }
  // A timestamp in the FUTURE (clock skew, a restored profile) is not
  // expired by the arithmetic above, and is not worth a special case:
  // it simply never expires during this session, which is the
  // conservative direction for the reviewer's own words.
  return { savedAt: candidate.savedAt, text: candidate.text };
}

export function saveDraft(
  storage: DraftStorage | undefined,
  threadId: string,
  text: string,
  now: number,
): void {
  if (storage === undefined) return;
  const key = draftKey(threadId);
  try {
    if (text.length === 0) storage.removeItem(key);
    else storage.setItem(key, encodeDraft(text, now));
  } catch {
    // Best effort only.
  }
}

export function removeDraft(storage: DraftStorage | undefined, threadId: string): void {
  if (storage === undefined) return;
  try {
    storage.removeItem(draftKey(threadId));
  } catch {
    // Best effort only.
  }
}

/** Drop every draft past its TTL. Returns the keys removed.
 *
 * Runs on each save, which is the only timer-free point the rail
 * touches storage: the rail has no background loop, and a TTL that is
 * only evaluated when something else happens is still the right trade
 * for a pure client surface. Storage stays bounded by the number of
 * threads the reviewer has actually opened. */
export function sweepExpiredDrafts(
  storage: DraftStorage | undefined,
  now: number,
): string[] {
  if (storage === undefined) return [];
  const stale: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null || !key.startsWith(DRAFT_KEY_PREFIX)) continue;
      const threadId = key.slice(DRAFT_KEY_PREFIX.length);
      if (readDraft(storage, threadId, now) === undefined) stale.push(key);
    }
    // Second pass for removal: `readDraft` removes as a side effect,
    // and removing while iterating shifts the index space.
    for (const key of stale) {
      try {
        storage.removeItem(key);
      } catch {
        /* best effort */
      }
    }
  } catch {
    // Best effort only.
  }
  return stale;
}
