// The comment rail island (DESIGN-0001 §5.2, ADR-0002).
//
// A minimal Solid island: it discovers every `data-src`-stamped block
// on the page, lets the reviewer create, view and reply to threads
// anchored to those blocks, and re-renders when the daemon fans a
// new event over `/events`. Auth is the session cookie the
// launch-code flow set — the rail never sees the agent bearer token.
//
// The rail runs from a bundle built by the daemon at first serve
// (`packages/cli/src/rail/bundle.ts`), served at `/-/rail.js` and
// `/-/rail.css`. It expects the page to have a `<main>` or `<body>`
// element to anchor its floating panel to; a page with no rendered
// content still gets an inert rail (announcing zero threads) so the
// injection is idempotent and does not break plain HTML.
//
// Authored as `.tsx` and compiled at build time by
// `babel-preset-solid` (via a Bun.build plugin — see
// `packages/cli/src/rail/bundle.ts`). Solid's JSX transform emits
// plain DOM code with no `eval` / `new Function`, so the daemon's
// CSP does NOT need `'unsafe-eval'` (ADR-0013 amendment 2026-09-30).
// The previous version used `solid-js/html`'s tagged-template
// runtime, which JIT-compiled templates via `new Function()` — that
// widening is gone.

import { createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { parseDataSrc } from "../data-src-format.ts";

/** The wire shape the daemon returns from `GET /api/threads` — kept as
 * a minimal duck type here so the rail bundle does not pull the whole
 * `@revkit/review-core` package into the browser payload. */
interface RailAuthor {
  readonly kind: string;
  readonly id: string;
  readonly displayName?: string;
}
interface RailAnchor {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly quote: { readonly exact: string; readonly prefix: string; readonly suffix: string };
  readonly revision: string;
}
interface RailComment {
  readonly id: string;
  readonly parentId?: string;
  readonly author: RailAuthor;
  readonly body: string;
  readonly createdAt: string;
}
interface RailThread {
  readonly id: string;
  /** `orphaned` was added in M2 item 5b: the re-anchoring pipeline
   * (ADR-0006, `@revkit/review-core`'s `reanchor.ts`) could not
   * find the thread on a later revision of the source file. The
   * thread is kept, still repliable / resolvable, and surfaced in
   * the orphan panel with a "was at L…" note. A subsequent
   * `thread.reanchored` unorphans it back to `open`. */
  readonly status: "open" | "resolved" | "orphaned";
  readonly anchor: RailAnchor;
  readonly comments: readonly RailComment[];
}
interface RailListResponse {
  readonly threads: readonly RailThread[];
  readonly head: number;
}
interface RailReviewEvent {
  readonly seq: number;
  readonly kind: string;
  readonly threadId?: string;
}

/** Build the SHA-256 hex digest of the LF-normalised body — the
 * `revision` field on the anchor. `revisionOf` in review-core does the
 * same for the server; the rail computes its own locally so a new
 * thread's revision matches the block it points at. Uses WebCrypto
 * (`crypto.subtle`), available in every evergreen browser (ADR-0018). */
async function revisionHex(text: string): Promise<string> {
  const normalised = text.replace(/\r\n/g, "\n");
  const bytes = new TextEncoder().encode(normalised);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex: string[] = [];
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i++) {
    hex.push(view[i]!.toString(16).padStart(2, "0"));
  }
  return hex.join("");
}

/** Fetch review threads for the source paths visible on THIS page.
 * The rail walks every `[data-src]` on load, collects the distinct
 * `path` values, and asks the daemon for each — a large repo with
 * many threads across many files must not stream them all into
 * every page's rail. If the page has no stamped blocks, we fall
 * back to a single unfiltered request so a page carrying nothing
 * more than a `<main>` still surfaces any thread the reviewer has
 * open elsewhere. */
async function fetchThreads(): Promise<RailListResponse> {
  const paths = collectPagePaths();
  // Ask for both open AND orphaned threads on THIS page. The rail
  // renders open threads inline against the block they anchor to,
  // and orphaned threads in the dedicated panel (M2 item 5b).
  // Resolved threads are not surfaced here (the review is over) —
  // an orphaned thread that gets re-anchored becomes `open` again
  // via the reducer's un-orphan rule (ADR-0006 amendment).
  const statusFilter = "open,orphaned";
  if (paths.length === 0) {
    const response = await fetch(
      "/api/threads?status=" + encodeURIComponent(statusFilter),
      {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok) throw new Error(`GET /api/threads failed: ${response.status}`);
    return (await response.json()) as RailListResponse;
  }
  const responses = await Promise.all(
    paths.map((path) =>
      fetch(
        "/api/threads?path=" +
          encodeURIComponent(path) +
          "&status=" +
          encodeURIComponent(statusFilter),
        {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        },
      ).then(async (r) => {
        if (!r.ok) throw new Error(`GET /api/threads?path=${path} failed: ${r.status}`);
        return (await r.json()) as RailListResponse;
      }),
    ),
  );
  const merged: RailThread[] = [];
  let head = 0;
  const seen = new Set<string>();
  for (const one of responses) {
    if (one.head > head) head = one.head;
    for (const t of one.threads) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        merged.push(t);
      }
    }
  }
  return { threads: merged, head };
}

/** Walk `[data-src]` blocks and collect the unique repo-relative
 * paths they anchor to. `parseDataSrc` validates the format (path
 * shape + line range); invalid values are dropped silently. */
function collectPagePaths(): string[] {
  const stamped = document.querySelectorAll<HTMLElement>("[data-src]");
  const seen = new Set<string>();
  for (const el of Array.from(stamped)) {
    const raw = el.getAttribute("data-src");
    if (raw === null) continue;
    const parsed = parseDataSrc(raw);
    if (parsed === undefined) continue;
    seen.add(parsed.path);
  }
  return [...seen];
}

/** Body a `POST /api/threads` accepts. Kept in step with the daemon's
 * `createThreadRequestSchema` (packages/cli/src/serve/api-schemas.ts). */
interface CreateThreadBody {
  readonly anchor: RailAnchor;
  readonly body: string;
}
async function createThread(body: CreateThreadBody): Promise<void> {
  const response = await fetch("/api/threads", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST /api/threads failed: ${response.status}`);
}

async function replyToThread(threadId: string, parentId: string, body: string): Promise<void> {
  const response = await fetch(
    `/api/threads/${encodeURIComponent(threadId)}/replies`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId, body }),
    },
  );
  if (!response.ok) throw new Error(`POST /api/threads/:id/replies failed: ${response.status}`);
}

async function resolveThread(threadId: string): Promise<void> {
  const response = await fetch(
    `/api/threads/${encodeURIComponent(threadId)}/resolve`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) throw new Error(`POST /api/threads/:id/resolve failed: ${response.status}`);
}

/** Compute the source-quote context for a selected text range. The
 * daemon's schema requires `exact` non-empty; `prefix` / `suffix` may
 * be empty at start/end of a block. We take a small window (32 chars)
 * so the ADR-0006 re-anchoring pipeline has something to fuzzy-match
 * against later. */
function quoteFromBlock(block: Element, selected: string): {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
} {
  const full = block.textContent ?? "";
  const idx = full.indexOf(selected);
  if (idx < 0) return { exact: selected, prefix: "", suffix: "" };
  const prefix = full.slice(Math.max(0, idx - 32), idx);
  const suffix = full.slice(idx + selected.length, idx + selected.length + 32);
  return { exact: selected, prefix, suffix };
}

/** Find the nearest ancestor of `node` that carries a `data-src` attr.
 * The rail anchors on that ancestor's stamp, so a selection inside a
 * paragraph re-uses the paragraph's `data-src` regardless of where the
 * selection begins. Returns undefined if the node is not inside a
 * stamped ancestor (a plain HTML page with no rehype-stamped blocks). */
function nearestAnchorAncestor(node: Node | null): HTMLElement | undefined {
  let cursor = node;
  while (cursor !== null) {
    if (cursor.nodeType === Node.ELEMENT_NODE) {
      const el = cursor as HTMLElement;
      if (el.hasAttribute("data-src")) return el;
    }
    cursor = cursor.parentNode;
  }
  return undefined;
}

/** SSE subscriber that re-fetches threads whenever the daemon reports
 * a comment / thread event. Reconnects on close with an exponential
 * backoff up to 30 s — a paused laptop can wake into a stale stream
 * and this brings it back quickly without hammering the daemon. */
function subscribeEvents(onBump: () => void): () => void {
  let closed = false;
  let source: EventSource | undefined;
  let retryDelayMs = 500;
  const kick = (): void => {
    if (closed) return;
    // `EventSource` sends the session cookie automatically because we
    // opened the page under the daemon's own origin.
    source = new EventSource("/events");
    source.onmessage = (message: MessageEvent<string>): void => {
      try {
        const event = JSON.parse(message.data) as RailReviewEvent;
        // Any comment/thread transition is a reason to re-fetch. We
        // do not merge into local state — the daemon is authoritative
        // and a re-fetch is one round-trip we can afford.
        if (
          event.kind === "comment.created" ||
          event.kind === "comment.replied" ||
          event.kind === "thread.resolved" ||
          event.kind === "thread.reopened" ||
          // M2 item 5b: re-anchor + orphan events move a thread to a
          // new block (or to the orphan panel) without a page reload.
          // Same refetch strategy — cheap, keeps the rail's model of
          // the world identical to the daemon's authoritative state.
          event.kind === "thread.reanchored" ||
          event.kind === "thread.orphaned"
        ) {
          onBump();
        }
      } catch {
        // A non-JSON frame is the SSE keepalive comment or a corrupt
        // frame — either way, ignore and wait for the next.
      }
      retryDelayMs = 500;
    };
    source.onerror = (): void => {
      source?.close();
      if (closed) return;
      const delay = retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      setTimeout(kick, delay);
    };
  };
  kick();
  return () => {
    closed = true;
    source?.close();
  };
}

/** Try to find the block on the page whose `data-src` matches
 * `anchor.path:start-end`. Used to scroll a thread's anchor into view
 * when the reviewer opens it in the rail. */
function findBlockForAnchor(anchor: RailAnchor): HTMLElement | undefined {
  const wanted = `${anchor.path}:${anchor.startLine}-${anchor.endLine}`;
  const el = document.querySelector<HTMLElement>(`[data-src="${cssEscape(wanted)}"]`);
  return el ?? undefined;
}

/** Tiny CSS.escape polyfill — we run in evergreen browsers (ADR-0018)
 * that ship it, but a defensive fallback keeps the rail working in an
 * embedded webview that lacks it. */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

/** The floating rail root — one panel pinned to the right edge of the
 * viewport at desktop width; a full-width sheet at phone width. Uses
 * ARIA landmarks / dialogs so a screen reader treats it as a
 * complementary region (ADR-0017). */
function Rail(): JSX.Element {
  const [threads, { refetch }] = createResource(fetchThreads);
  const [composerAnchor, setComposerAnchor] = createSignal<{
    readonly element: HTMLElement;
    readonly anchor: RailAnchor;
    readonly quote: string;
  } | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  // `replyDraftFor` holds the id of the thread whose reply form is
  // open. Declared here so keyboard handlers set up below can read
  // it in Escape's dispatch table.
  const [replyDraftFor, setReplyDraftFor] = createSignal<string | undefined>(undefined);

  // Wire the SSE stream on mount, tear it down on unmount.
  const unsubscribe = subscribeEvents(() => {
    void refetch();
  });
  onCleanup(unsubscribe);

  // Selection listener: on `mouseup` (or a keyboard-driven
  // `selectionchange` when a screen reader / keyboard user extends
  // a selection with shift+arrow), if the user has selected
  // non-empty text inside a stamped block, we surface two entry
  // points to the composer. First, a floating "Comment" button
  // pinned to the selection's bounding box, so the click
  // affordance is where the eye is. Second, the `c` keyboard
  // shortcut and the "comment on selection" button inside the rail
  // panel (both wired up further down).
  const [selection, setSelection] = createSignal<{
    readonly block: HTMLElement;
    readonly anchor: RailAnchor;
    readonly quote: string;
    readonly rect: { readonly top: number; readonly left: number; readonly width: number; readonly height: number };
  } | undefined>(undefined);
  const readSelection = (): void => {
    const sel = window.getSelection();
    if (sel === null || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(undefined);
      return;
    }
    const text = sel.toString().trim();
    if (text.length === 0) {
      setSelection(undefined);
      return;
    }
    const anchorNode = sel.anchorNode;
    const block = nearestAnchorAncestor(anchorNode);
    if (block === undefined) {
      setSelection(undefined);
      return;
    }
    // Ignore selections that live INSIDE the rail itself — e.g. a
    // user selecting an old comment's text should not offer to
    // start a NEW thread from that text.
    if (block.closest("[data-testid=\"revkit-rail\"]") !== null) {
      setSelection(undefined);
      return;
    }
    const raw = block.getAttribute("data-src");
    if (raw === null) {
      setSelection(undefined);
      return;
    }
    const parsed = parseDataSrc(raw);
    if (parsed === undefined) {
      setSelection(undefined);
      return;
    }
    const quoteParts = quoteFromBlock(block, text);
    const range = sel.getRangeAt(0);
    const box = range.getBoundingClientRect();
    setSelection({
      block,
      anchor: {
        path: parsed.path,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        quote: quoteParts,
        // The rail computes a revision from the block's rendered
        // text, which is the closest surrogate for the rendered
        // fragment available client-side. Server re-validates the
        // shape (64-hex lower); a mismatch is not a security issue.
        revision: "0".repeat(64),
      },
      quote: text,
      rect: { top: box.top, left: box.left, width: box.width, height: box.height },
    });
  };
  document.addEventListener("mouseup", readSelection);
  // `selectionchange` catches keyboard-driven selections (shift+arrow,
  // shift+home/end) so the floating button appears without the mouse.
  document.addEventListener("selectionchange", readSelection);
  onCleanup(() => {
    document.removeEventListener("mouseup", readSelection);
    document.removeEventListener("selectionchange", readSelection);
  });

  const openComposer = async (candidate: NonNullable<ReturnType<typeof selection>>): Promise<void> => {
    const revision = await revisionHex(candidate.block.textContent ?? "");
    setComposerAnchor({
      element: candidate.block,
      anchor: { ...candidate.anchor, revision },
      quote: candidate.quote,
    });
    setSelection(undefined);
  };

  // Keyboard shortcut: `c` when a selection exists opens the
  // composer. Ignored when the user is typing in a form field (a
  // shortcut that steals `c` in a textarea would be worse than not
  // having one). ADR-0017: keyboard-accessible parity with the
  // "comment on selection" button.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
    const pending = selection();
    if (pending === undefined) return;
    event.preventDefault();
    void openComposer(pending);
  };
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  // Escape closes the composer / reply form / dismisses the
  // selection prompt — the browser's own dismiss gesture.
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (composerAnchor() !== undefined) {
      setComposerAnchor(undefined);
      return;
    }
    if (replyDraftFor() !== undefined) {
      setReplyDraftFor(undefined);
      return;
    }
    if (selection() !== undefined) {
      setSelection(undefined);
    }
  };
  document.addEventListener("keydown", onEscape);
  onCleanup(() => document.removeEventListener("keydown", onEscape));

  const submitNewThread = async (bodyText: string): Promise<void> => {
    const composed = composerAnchor();
    if (composed === undefined) return;
    setError(undefined);
    try {
      await createThread({ anchor: composed.anchor, body: bodyText });
      setComposerAnchor(undefined);
      await refetch();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const submitReply = async (thread: RailThread, bodyText: string): Promise<void> => {
    setError(undefined);
    const last = thread.comments[thread.comments.length - 1];
    if (last === undefined) return;
    try {
      await replyToThread(thread.id, last.id, bodyText);
      setReplyDraftFor(undefined);
      await refetch();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const doResolve = async (thread: RailThread): Promise<void> => {
    setError(undefined);
    try {
      await resolveThread(thread.id);
      await refetch();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  // Scroll the anchor block into view when the reviewer clicks on a
  // thread in the list.
  const focusAnchor = (anchor: RailAnchor): void => {
    const block = findBlockForAnchor(anchor);
    if (block !== undefined) {
      block.scrollIntoView({ behavior: "smooth", block: "center" });
      block.setAttribute("data-rail-focus", "true");
      setTimeout(() => block.removeAttribute("data-rail-focus"), 1200);
    }
  };

  // The DOM below is JSX; `babel-preset-solid` compiles it into
  // plain DOM code at bundle time (no `eval` / `new Function`).
  // `Show`, `For`, and event handlers work the same way as under
  // the tagged-template runtime; the migration is textual.
  return (
    <aside
      class="revkit-rail"
      role="complementary"
      aria-label="review comments"
      data-testid="revkit-rail"
    >
      <Show when={selection() !== undefined && composerAnchor() === undefined}>
        {(() => {
          // Floating "Comment" button pinned to the selection's
          // top-right corner. Uses viewport coordinates from
          // `getBoundingClientRect()` (position: fixed). Clicking
          // opens the composer; the `c` keyboard shortcut is the
          // keyboard-only equivalent.
          const sel = selection()!;
          const style =
            `top: ${Math.max(8, sel.rect.top - 36)}px; ` +
            `left: ${Math.min(window.innerWidth - 120, sel.rect.left + sel.rect.width - 8)}px;`;
          return (
            <button
              type="button"
              class="revkit-rail__floating"
              data-testid="revkit-rail-floating"
              style={style}
              onMouseDown={(event: MouseEvent): void => {
                // `mousedown` fires before the click clears the
                // selection — otherwise `openComposer(selection())`
                // sees `undefined` because the click collapsed the
                // range.
                event.preventDefault();
                void openComposer(sel);
              }}
              aria-label={`Comment on "${sel.quote.slice(0, 40)}" — shortcut: c`}
            >Comment</button>
          );
        })()}
      </Show>
      <header class="revkit-rail__header">
        <h2 class="revkit-rail__title">Comments</h2>
        <button
          type="button"
          class="revkit-rail__refresh"
          onClick={() => void refetch()}
          aria-label="refresh"
        >refresh</button>
      </header>
      <Show when={error() !== undefined}>
        <p class="revkit-rail__error" role="alert">{error()}</p>
      </Show>
      <Show when={selection() !== undefined}>
        <div class="revkit-rail__selection" role="region" aria-label="selected text">
          <p class="revkit-rail__quote">"{selection()!.quote}"</p>
          <button
            type="button"
            class="revkit-rail__new"
            data-testid="revkit-rail-new"
            onClick={() => void openComposer(selection()!)}
          >comment on selection</button>
        </div>
      </Show>
      <Show when={composerAnchor() !== undefined}>
        {(() => {
          const composed = composerAnchor()!;
          return (
            <form
              class="revkit-rail__composer"
              data-testid="revkit-rail-composer"
              onSubmit={(event: SubmitEvent): void => {
                event.preventDefault();
                const form = event.currentTarget as HTMLFormElement;
                const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
                if (textarea === null || textarea.value.trim().length === 0) return;
                void submitNewThread(textarea.value.trim());
              }}
            >
              <p class="revkit-rail__composer-anchor">
                <span class="revkit-rail__composer-path">{composed.anchor.path}</span>
                <span class="revkit-rail__composer-lines">L{composed.anchor.startLine}–{composed.anchor.endLine}</span>
              </p>
              <p class="revkit-rail__quote">"{composed.quote}"</p>
              <label class="revkit-rail__label">
                <span class="revkit-rail__label-text">Comment</span>
                <textarea
                  required
                  rows="3"
                  data-testid="revkit-rail-composer-input"
                  aria-label="comment body"
                  ref={(el: HTMLTextAreaElement): void => {
                    // Focus on mount so a reviewer opening the
                    // composer (via keyboard `c` or the mouse) can
                    // type immediately (WCAG 2.4.3 focus order).
                    queueMicrotask(() => el.focus());
                  }}
                ></textarea>
              </label>
              <div class="revkit-rail__actions">
                <button
                  type="button"
                  class="revkit-rail__cancel"
                  onClick={() => setComposerAnchor(undefined)}
                >cancel</button>
                <button
                  type="submit"
                  class="revkit-rail__submit"
                  data-testid="revkit-rail-submit"
                >post</button>
              </div>
            </form>
          );
        })()}
      </Show>
      <ol class="revkit-rail__threads" aria-live="polite" data-testid="revkit-rail-threads">
        <For each={openThreadsFor(threads())}>
          {(thread: RailThread) => (
            <li
              class={`revkit-rail__thread revkit-rail__thread--${thread.status}`}
              data-thread-id={thread.id}
              data-testid="revkit-rail-thread"
            >
              <button
                type="button"
                class="revkit-rail__thread-anchor"
                onClick={() => focusAnchor(thread.anchor)}
              >
                <span class="revkit-rail__thread-path">{thread.anchor.path}</span>
                <span class="revkit-rail__thread-lines">L{thread.anchor.startLine}–{thread.anchor.endLine}</span>
              </button>
              <ol class="revkit-rail__comments">
                <For each={thread.comments}>
                  {(comment: RailComment) => (
                    <li class="revkit-rail__comment">
                      <p class="revkit-rail__author">
                        <span class={`revkit-rail__author-kind revkit-rail__author-kind--${comment.author.kind}`}>{comment.author.kind}</span>
                        <span class="revkit-rail__author-id">{comment.author.displayName ?? comment.author.id}</span>
                      </p>
                      <p class="revkit-rail__body">{comment.body}</p>
                    </li>
                  )}
                </For>
              </ol>
              <Show when={thread.status === "open"}>
                <div class="revkit-rail__thread-actions">
                  <Show
                    when={replyDraftFor() === thread.id}
                    fallback={
                      <>
                        <button
                          type="button"
                          class="revkit-rail__reply"
                          data-testid="revkit-rail-reply"
                          onClick={() => setReplyDraftFor(thread.id)}
                        >reply</button>
                        <button
                          type="button"
                          class="revkit-rail__resolve"
                          data-testid="revkit-rail-resolve"
                          onClick={() => void doResolve(thread)}
                        >resolve</button>
                      </>
                    }
                  >
                    <form
                      class="revkit-rail__reply-form"
                      onSubmit={(event: SubmitEvent): void => {
                        event.preventDefault();
                        const form = event.currentTarget as HTMLFormElement;
                        const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
                        if (textarea === null || textarea.value.trim().length === 0) return;
                        void submitReply(thread, textarea.value.trim());
                      }}
                    >
                      <label class="revkit-rail__label">
                        <span class="revkit-rail__label-text">Reply</span>
                        <textarea
                          required
                          rows="2"
                          data-testid="revkit-rail-reply-input"
                          aria-label="reply body"
                        ></textarea>
                      </label>
                      <div class="revkit-rail__actions">
                        <button
                          type="button"
                          class="revkit-rail__cancel"
                          onClick={() => setReplyDraftFor(undefined)}
                        >cancel</button>
                        <button
                          type="submit"
                          class="revkit-rail__submit"
                          data-testid="revkit-rail-reply-submit"
                        >post reply</button>
                      </div>
                    </form>
                  </Show>
                </div>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <Show when={openThreadsFor(threads()).length === 0}>
        <p class="revkit-rail__empty" data-testid="revkit-rail-empty">No open threads yet.</p>
      </Show>
      <Show when={orphanedThreadsFor(threads()).length > 0}>
        {/* Orphan panel (M2 item 5b, story A8). Lists threads the
            re-anchoring pipeline could not find on the current
            revision, with the original quote, the file, the "was at
            L…" note, and the pipeline's reason. Orphaned threads
            stay repliable and resolvable — the human/agent can
            still act on them; they just aren't tied to a
            currently-rendered block. Keyboard-accessible via the
            same button tab order as open threads. axe: labelled
            landmark region with `aria-label`. */}
        <section
          class="revkit-rail__orphans"
          aria-label="orphaned review threads"
          data-testid="revkit-rail-orphans"
        >
          <h3 class="revkit-rail__orphans-title">
            Orphaned threads
            <span class="revkit-rail__orphans-count" aria-label="count">
              {" "}({orphanedThreadsFor(threads()).length})
            </span>
          </h3>
          <ol class="revkit-rail__orphans-list">
            <For each={orphanedThreadsFor(threads())}>
              {(thread: RailThread) => (
                <li
                  class="revkit-rail__thread revkit-rail__thread--orphaned"
                  data-thread-id={thread.id}
                  data-testid="revkit-rail-orphan"
                >
                  <p class="revkit-rail__thread-anchor revkit-rail__thread-anchor--orphaned">
                    <span class="revkit-rail__thread-path">{thread.anchor.path}</span>
                    <span class="revkit-rail__thread-lines">
                      was at L{thread.anchor.startLine}–{thread.anchor.endLine}
                    </span>
                  </p>
                  <blockquote class="revkit-rail__orphan-quote" aria-label="original quote">
                    "{thread.anchor.quote.exact}"
                  </blockquote>
                  <p class="revkit-rail__orphan-reason" data-testid="revkit-rail-orphan-reason">
                    {orphanReasonFor(thread)}
                  </p>
                  <ol class="revkit-rail__comments">
                    <For each={thread.comments}>
                      {(comment: RailComment) => (
                        <li class="revkit-rail__comment">
                          <p class="revkit-rail__author">
                            <span class={`revkit-rail__author-kind revkit-rail__author-kind--${comment.author.kind}`}>{comment.author.kind}</span>
                            <span class="revkit-rail__author-id">{comment.author.displayName ?? comment.author.id}</span>
                          </p>
                          <p class="revkit-rail__body">{comment.body}</p>
                        </li>
                      )}
                    </For>
                  </ol>
                  <div class="revkit-rail__thread-actions">
                    <Show
                      when={replyDraftFor() === thread.id}
                      fallback={
                        <>
                          <button
                            type="button"
                            class="revkit-rail__reply"
                            data-testid="revkit-rail-orphan-reply"
                            onClick={() => setReplyDraftFor(thread.id)}
                          >reply</button>
                          <button
                            type="button"
                            class="revkit-rail__resolve"
                            data-testid="revkit-rail-orphan-resolve"
                            onClick={() => void doResolve(thread)}
                          >resolve</button>
                        </>
                      }
                    >
                      <form
                        class="revkit-rail__reply-form"
                        onSubmit={(event: SubmitEvent): void => {
                          event.preventDefault();
                          const form = event.currentTarget as HTMLFormElement;
                          const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
                          if (textarea === null || textarea.value.trim().length === 0) return;
                          void submitReply(thread, textarea.value.trim());
                        }}
                      >
                        <label class="revkit-rail__label">
                          <span class="revkit-rail__label-text">Reply</span>
                          <textarea
                            required
                            rows="2"
                            data-testid="revkit-rail-orphan-reply-input"
                            aria-label="reply body"
                          ></textarea>
                        </label>
                        <div class="revkit-rail__actions">
                          <button
                            type="button"
                            class="revkit-rail__cancel"
                            onClick={() => setReplyDraftFor(undefined)}
                          >cancel</button>
                          <button
                            type="submit"
                            class="revkit-rail__submit"
                            data-testid="revkit-rail-orphan-reply-submit"
                          >post reply</button>
                        </div>
                      </form>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ol>
        </section>
      </Show>
    </aside>
  );
}

/** Partition helper — open threads only (the main list). Kept out
 * of the JSX to make the count-check in the `Show` block below
 * readable. */
function openThreadsFor(response: RailListResponse | undefined): readonly RailThread[] {
  if (response === undefined) return [];
  return response.threads.filter((thread) => thread.status === "open");
}

/** Partition helper — orphaned threads only (the orphan panel).
 * See M2 item 5b: an orphan is a thread the re-anchor pipeline
 * could not place on the current revision. */
function orphanedThreadsFor(response: RailListResponse | undefined): readonly RailThread[] {
  if (response === undefined) return [];
  return response.threads.filter((thread) => thread.status === "orphaned");
}

/** Best-effort human reason for an orphan. The daemon does not
 * ship the reason on the `Thread` view today (the reason lives
 * inside the `thread.orphaned` event), so the rail composes a
 * generic sentence from the anchor's path + line range. A future
 * ADR that extends the Thread view with `lastOrphanReason` would
 * let this render the exact pipeline-reason string. */
function orphanReasonFor(thread: RailThread): string {
  return (
    `The quoted text no longer appears at ${thread.anchor.path}:` +
    `L${thread.anchor.startLine}–${thread.anchor.endLine}. ` +
    `The thread is kept — reply or resolve it here.`
  );
}

/** Mount the rail into a fresh `<div>` appended to `<body>`. Idempotent
 * — a second call replaces the previous mount. The bundle's entry
 * point is the single side-effect below, so `import "…/rail.js"` runs
 * `mount()` at load. */
export function mount(): void {
  const previous = document.querySelector<HTMLElement>("[data-revkit-rail-mount]");
  if (previous !== null) previous.remove();
  const root = document.createElement("div");
  root.setAttribute("data-revkit-rail-mount", "true");
  document.body.appendChild(root);
  // `Rail()` returns a Solid JSX element; `render()` accepts any
  // JSX-element factory.
  render(() => Rail(), root);
}

// The bundle's module side-effect: as soon as the browser evaluates
// `/-/rail.js`, the rail mounts itself. The daemon injects the
// `<script type="module" src="/-/rail.js"></script>` tag; no other
// glue is needed on the page.
mount();

// Named export so tests can call `mount()` after tearing the DOM down.
export default mount;
