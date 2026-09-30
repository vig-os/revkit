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
// Kept vanilla-Solid using `solid-js/html`'s tagged-template runtime
// so the bundle does not need JSX transformation — the daemon can
// build it with `Bun.build` without a babel-preset-solid step.

import html from "solid-js/html";
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
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
  readonly status: "open" | "resolved";
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

/** Fetch threads for the current page — anchored to any file we can
 * see on the page. The rail groups them by anchor.path so a doc
 * that renders many files' fragments shows each's threads. */
async function fetchThreads(): Promise<RailListResponse> {
  const response = await fetch("/api/threads", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`GET /api/threads failed: ${response.status}`);
  return (await response.json()) as RailListResponse;
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
          event.kind === "thread.reopened"
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
function Rail(): unknown {
  const [threads, { refetch }] = createResource(fetchThreads);
  const [composerAnchor, setComposerAnchor] = createSignal<{
    readonly element: HTMLElement;
    readonly anchor: RailAnchor;
    readonly quote: string;
  } | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);

  // Wire the SSE stream on mount, tear it down on unmount.
  const unsubscribe = subscribeEvents(() => {
    void refetch();
  });
  onCleanup(unsubscribe);

  // Selection listener: on `mouseup`, if the user has selected non-empty
  // text inside a stamped block, offer a "comment" button that opens
  // the composer.
  const [selection, setSelection] = createSignal<{
    readonly block: HTMLElement;
    readonly anchor: RailAnchor;
    readonly quote: string;
  } | undefined>(undefined);
  const onMouseUp = (): void => {
    const sel = window.getSelection();
    if (sel === null || sel.isCollapsed) {
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
    });
  };
  document.addEventListener("mouseup", onMouseUp);
  onCleanup(() => document.removeEventListener("mouseup", onMouseUp));

  const openComposer = async (candidate: NonNullable<ReturnType<typeof selection>>): Promise<void> => {
    const revision = await revisionHex(candidate.block.textContent ?? "");
    setComposerAnchor({
      element: candidate.block,
      anchor: { ...candidate.anchor, revision },
      quote: candidate.quote,
    });
    setSelection(undefined);
  };

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

  const [replyDraftFor, setReplyDraftFor] = createSignal<string | undefined>(undefined);
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

  // The DOM shape below is authored with `solid-js/html`'s tagged-
  // template runtime so the bundle needs no JSX transform. `${...}`
  // captures children and event handlers exactly like JSX would.
  return html`
    <aside
      class="revkit-rail"
      role="complementary"
      aria-label="review comments"
      data-testid="revkit-rail"
    >
      <header class="revkit-rail__header">
        <h2 class="revkit-rail__title">Comments</h2>
        <button
          type="button"
          class="revkit-rail__refresh"
          onClick=${() => void refetch()}
          aria-label="refresh"
        >refresh</button>
      </header>
      ${() => {
        const err = error();
        return err !== undefined
          ? html`<p class="revkit-rail__error" role="alert">${err}</p>`
          : null;
      }}
      <${Show} when=${() => selection() !== undefined}>
        <div class="revkit-rail__selection" role="region" aria-label="selected text">
          <p class="revkit-rail__quote">"${() => selection()!.quote}"</p>
          <button
            type="button"
            class="revkit-rail__new"
            data-testid="revkit-rail-new"
            onClick=${() => void openComposer(selection()!)}
          >comment on selection</button>
        </div>
      <//>
      <${Show} when=${() => composerAnchor() !== undefined}>
        ${() => {
          const composed = composerAnchor()!;
          return html`
            <form
              class="revkit-rail__composer"
              data-testid="revkit-rail-composer"
              onSubmit=${(event: SubmitEvent): void => {
                event.preventDefault();
                const form = event.currentTarget as HTMLFormElement;
                const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
                if (textarea === null || textarea.value.trim().length === 0) return;
                void submitNewThread(textarea.value.trim());
              }}
            >
              <p class="revkit-rail__composer-anchor">
                <span class="revkit-rail__composer-path">${composed.anchor.path}</span>
                <span class="revkit-rail__composer-lines">L${composed.anchor.startLine}–${composed.anchor.endLine}</span>
              </p>
              <p class="revkit-rail__quote">"${composed.quote}"</p>
              <label class="revkit-rail__label">
                <span class="revkit-rail__label-text">Comment</span>
                <textarea
                  required
                  rows="3"
                  data-testid="revkit-rail-composer-input"
                  aria-label="comment body"
                ></textarea>
              </label>
              <div class="revkit-rail__actions">
                <button
                  type="button"
                  class="revkit-rail__cancel"
                  onClick=${() => setComposerAnchor(undefined)}
                >cancel</button>
                <button
                  type="submit"
                  class="revkit-rail__submit"
                  data-testid="revkit-rail-submit"
                >post</button>
              </div>
            </form>
          `;
        }}
      <//>
      <ol class="revkit-rail__threads" aria-live="polite" data-testid="revkit-rail-threads">
        <${For} each=${() => threads()?.threads ?? []}>
          ${(thread: RailThread) => html`
            <li
              class=${`revkit-rail__thread revkit-rail__thread--${thread.status}`}
              data-thread-id=${thread.id}
              data-testid="revkit-rail-thread"
            >
              <button
                type="button"
                class="revkit-rail__thread-anchor"
                onClick=${() => focusAnchor(thread.anchor)}
              >
                <span class="revkit-rail__thread-path">${thread.anchor.path}</span>
                <span class="revkit-rail__thread-lines">L${thread.anchor.startLine}–${thread.anchor.endLine}</span>
              </button>
              <ol class="revkit-rail__comments">
                <${For} each=${() => thread.comments}>
                  ${(comment: RailComment) => html`
                    <li class="revkit-rail__comment">
                      <p class="revkit-rail__author">
                        <span class=${`revkit-rail__author-kind revkit-rail__author-kind--${comment.author.kind}`}>${comment.author.kind}</span>
                        <span class="revkit-rail__author-id">${comment.author.displayName ?? comment.author.id}</span>
                      </p>
                      <p class="revkit-rail__body">${comment.body}</p>
                    </li>
                  `}
                <//>
              </ol>
              <${Show} when=${() => thread.status === "open"}>
                <div class="revkit-rail__thread-actions">
                  <${Show}
                    when=${() => replyDraftFor() === thread.id}
                    fallback=${() => html`
                      <button
                        type="button"
                        class="revkit-rail__reply"
                        data-testid="revkit-rail-reply"
                        onClick=${() => setReplyDraftFor(thread.id)}
                      >reply</button>
                      <button
                        type="button"
                        class="revkit-rail__resolve"
                        data-testid="revkit-rail-resolve"
                        onClick=${() => void doResolve(thread)}
                      >resolve</button>
                    `}
                  >
                    <form
                      class="revkit-rail__reply-form"
                      onSubmit=${(event: SubmitEvent): void => {
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
                          onClick=${() => setReplyDraftFor(undefined)}
                        >cancel</button>
                        <button
                          type="submit"
                          class="revkit-rail__submit"
                          data-testid="revkit-rail-reply-submit"
                        >post reply</button>
                      </div>
                    </form>
                  <//>
                </div>
              <//>
            </li>
          `}
        <//>
      </ol>
      <${Show}
        when=${() => (threads()?.threads.length ?? 0) === 0}
      >
        <p class="revkit-rail__empty" data-testid="revkit-rail-empty">No open threads yet.</p>
      <//>
    </aside>
  `;
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
  // `Rail()` returns a hyperscript-shaped node object (Solid's
  // `solid-js/html` runtime); Solid's `render()` accepts any JSX
  // element expression.
  render(() => Rail() as unknown as ReturnType<typeof render> extends never ? never : any, root);
}

// The bundle's module side-effect: as soon as the browser evaluates
// `/-/rail.js`, the rail mounts itself. The daemon injects the
// `<script type="module" src="/-/rail.js"></script>` tag; no other
// glue is needed on the page.
mount();

// Named export so tests can call `mount()` after tearing the DOM down.
export default mount;
