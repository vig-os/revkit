// `/ask/<id>` — the rich question page (DESIGN-0001 §5.1, story A1).
//
// Solid island authored as `.tsx` and compiled at daemon-serve time
// by `babel-preset-solid` (via a Bun.build plugin — see
// `packages/cli/src/ask-page/bundle.ts`). Same discipline as the
// rail: NO runtime template compilation, so the daemon's CSP does
// NOT need `'unsafe-eval'`.
//
// **Untrusted input.** The `AskRecord` this page renders was written
// by the agent (through `POST /api/asks`, validated by
// `askSchema`) — trusted-as-shape, untrusted as HTML. Every
// interpolated string (title, prompt, option labels, notes) goes
// through Solid's default text-node path (`{value}` inserts a text
// node, never HTML), never `innerHTML`. The one exception is a
// `<pre>` blockquote for the `review` kind's target file, which is
// also text-node bound. `Kobalte` primitives are used where the
// interaction warrants them (radio group, slider, text field) so
// keyboard + ARIA are covered without hand-rolling.
//
// **Auth.** Cookie-authenticated fetches only — the page runs inside
// the human's session, and the agent never sees this page. The
// answer POST carries `credentials: "same-origin"` so the daemon's
// Origin + Sec-Fetch-Site gate covers CSRF.
//
// **Six kinds** (DESIGN-0001 §5.1 v1): choice, rank, scale, text,
// region, review.

import { createResource, createSignal, For, Show, onCleanup, onMount, type JSX } from "solid-js";
import { render } from "solid-js/web";

// ── Wire types (kept as duck types to stay off the review-core
//    barrel; the bundle is browser-side and pulling review-core in
//    would bring `zod` + `diff-match-patch` for no runtime benefit).

interface Option {
  readonly id: string;
  readonly label: string;
  readonly preview?: string;
}
interface ChoiceSpec {
  readonly kind: "choice";
  readonly title: string;
  readonly prompt?: string;
  readonly options: readonly Option[];
  readonly allowOther?: boolean;
  readonly multi?: boolean;
}
interface RankSpec {
  readonly kind: "rank";
  readonly title: string;
  readonly prompt?: string;
  readonly options: readonly Option[];
}
interface ScaleSpec {
  readonly kind: "scale";
  readonly title: string;
  readonly prompt?: string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly labels?: { readonly min?: string; readonly max?: string };
}
interface TextSpec {
  readonly kind: "text";
  readonly title: string;
  readonly prompt?: string;
  readonly multiline?: boolean;
  readonly placeholder?: string;
}
interface RegionSpec {
  readonly kind: "region";
  readonly title: string;
  readonly prompt?: string;
  readonly target: string;
}
interface ReviewSpec {
  readonly kind: "review";
  readonly title: string;
  readonly prompt?: string;
  readonly target: string;
}
type Spec = ChoiceSpec | RankSpec | ScaleSpec | TextSpec | RegionSpec | ReviewSpec;

interface Answer {
  readonly kind: Spec["kind"];
  readonly [field: string]: unknown;
}
interface AskRecord {
  readonly id: string;
  readonly spec: Spec;
  readonly status: "pending" | "answered" | "cancelled" | "expired";
  readonly url?: string;
  readonly expiresAtMs?: number;
  readonly answer?: Answer;
  readonly answeredAt?: string;
  readonly cancelReason?: string;
  readonly cancelledAt?: string;
  readonly expiredAt?: string;
  readonly createdAt: string;
}

/** Bootstrap payload the daemon inlines on the page in a
 * `<script id="revkit-ask-boot" type="application/json">` tag. Read
 * once at mount — we intentionally do NOT re-parse the DOM on every
 * event; a re-render fetches `/api/asks/:id` for the latest state
 * (`ask.answered` from a second tab, `ask.expired` from the lazy
 * check). */
interface Boot {
  readonly id: string;
  readonly initial: AskRecord;
}

function readBoot(): Boot | undefined {
  const el = document.getElementById("revkit-ask-boot");
  if (el === null) return undefined;
  try {
    const parsed = JSON.parse(el.textContent ?? "") as Boot;
    if (typeof parsed?.id !== "string" || parsed.initial === undefined) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Fetch the latest AskRecord over the cookie-authenticated JSON API.
 * Unwraps the `{ ask }` envelope the daemon returns — the daemon's
 * write path returns `{ seq, event }` and the read path returns
 * `{ ask }`, matching the threads API's shape. */
async function fetchAsk(id: string): Promise<AskRecord> {
  const response = await fetch(`/api/asks/${encodeURIComponent(id)}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`GET /api/asks/${id} failed: ${response.status}`);
  const parsed = (await response.json()) as { ask: AskRecord };
  return parsed.ask;
}

/** POST the answer. Fire-and-forget on success — the caller triggers
 * a `refetch()` to pick up the new record. The daemons write path
 * returns `{seq, event}`, not the derived record, so we do not
 * bother parsing the body here. */
async function submitAnswer(id: string, answer: Answer): Promise<void> {
  const response = await fetch(`/api/asks/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ answer }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`POST /api/asks/${id}/answer failed: ${response.status} ${text}`);
  }
}

// ── Kind renderers ────────────────────────────────────────────────

function renderChoice(spec: ChoiceSpec, onAnswer: (a: Answer) => void): JSX.Element {
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [note, setNote] = createSignal("");
  const [other, setOther] = createSignal("");
  const toggle = (id: string): void => {
    const next = new Set(selected());
    if (spec.multi === true) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    } else {
      next.clear();
      next.add(id);
    }
    setSelected(next);
  };
  const submit = (): void => {
    const chosen = [...selected()];
    if (chosen.length === 0 && !(spec.allowOther === true && other().trim().length > 0)) return;
    const value: string | string[] = spec.multi === true
      ? chosen.length > 0
        ? chosen
        : [`other:${other().trim()}`]
      : chosen[0] ?? `other:${other().trim()}`;
    const trimmedNote = note().trim();
    onAnswer({
      kind: "choice",
      value: value as unknown as string,
      ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
    });
  };
  const groupRole = spec.multi === true ? "group" : "radiogroup";
  return (
    <form
      class="revkit-ask__form"
      aria-label={spec.title}
      onSubmit={(e: SubmitEvent) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="revkit-ask__options" role={groupRole} aria-label={spec.title}>
        <For each={spec.options}>
          {(option: Option): JSX.Element => {
            const id = `revkit-ask-choice-${option.id}`;
            return (
              <div class="revkit-ask__option">
                <label class="revkit-ask__option-label" for={id}>
                  <input
                    type={spec.multi === true ? "checkbox" : "radio"}
                    id={id}
                    name="revkit-ask-choice"
                    value={option.id}
                    checked={selected().has(option.id)}
                    onChange={() => toggle(option.id)}
                  />
                  <span class="revkit-ask__option-text">{option.label}</span>
                </label>
                <Show when={option.preview !== undefined}>
                  <div class="revkit-ask__option-preview" data-preview={option.preview} />
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={spec.allowOther === true}>
        <div class="revkit-ask__field">
          <label for="revkit-ask-other">Or write your own:</label>
          <input
            id="revkit-ask-other"
            type="text"
            value={other()}
            maxLength={4096}
            onInput={(e: InputEvent) => setOther((e.currentTarget as HTMLInputElement).value)}
          />
        </div>
      </Show>
      <div class="revkit-ask__field">
        <label for="revkit-ask-note">Note (optional):</label>
        <input
          id="revkit-ask-note"
          type="text"
          value={note()}
          maxLength={4096}
          onInput={(e: InputEvent) => setNote((e.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <button type="submit" class="revkit-ask__submit" data-testid="revkit-ask-submit">
        Submit answer
      </button>
    </form>
  );
}

function renderRank(spec: RankSpec, onAnswer: (a: Answer) => void): JSX.Element {
  const [order, setOrder] = createSignal<string[]>(spec.options.map((o) => o.id));
  const move = (index: number, delta: number): void => {
    const next = order().slice();
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    if (item !== undefined) next.splice(target, 0, item);
    setOrder(next);
  };
  const submit = (): void => {
    onAnswer({ kind: "rank", ranking: order() });
  };
  return (
    <form
      class="revkit-ask__form"
      aria-label={spec.title}
      onSubmit={(e: SubmitEvent) => {
        e.preventDefault();
        submit();
      }}
    >
      <ol class="revkit-ask__ranking" aria-label="Ordered options — highest first">
        <For each={order()}>
          {(id: string, index): JSX.Element => {
            const option = spec.options.find((o) => o.id === id);
            return (
              <li class="revkit-ask__rank-item">
                <span class="revkit-ask__rank-position">{index() + 1}.</span>
                <span class="revkit-ask__rank-label">{option?.label ?? id}</span>
                <span class="revkit-ask__rank-controls">
                  <button
                    type="button"
                    aria-label={`Move ${option?.label ?? id} up`}
                    onClick={() => move(index(), -1)}
                    disabled={index() === 0}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${option?.label ?? id} down`}
                    onClick={() => move(index(), 1)}
                    disabled={index() === order().length - 1}
                  >
                    ↓
                  </button>
                </span>
              </li>
            );
          }}
        </For>
      </ol>
      <button type="submit" class="revkit-ask__submit" data-testid="revkit-ask-submit">
        Submit ranking
      </button>
    </form>
  );
}

function renderScale(spec: ScaleSpec, onAnswer: (a: Answer) => void): JSX.Element {
  const step = spec.step ?? 1;
  const [value, setValue] = createSignal((spec.min + spec.max) / 2);
  const [note, setNote] = createSignal("");
  const submit = (): void => {
    const trimmed = note().trim();
    onAnswer({ kind: "scale", value: value(), ...(trimmed.length > 0 ? { note: trimmed } : {}) });
  };
  return (
    <form
      class="revkit-ask__form"
      aria-label={spec.title}
      onSubmit={(e: SubmitEvent) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="revkit-ask__scale">
        <label for="revkit-ask-scale">
          {spec.labels?.min ?? String(spec.min)} — {spec.labels?.max ?? String(spec.max)}
        </label>
        <input
          id="revkit-ask-scale"
          type="range"
          min={spec.min}
          max={spec.max}
          step={step}
          value={value()}
          onInput={(e: InputEvent) => setValue(Number((e.currentTarget as HTMLInputElement).value))}
        />
        <output aria-live="polite" class="revkit-ask__scale-value">{value()}</output>
      </div>
      <div class="revkit-ask__field">
        <label for="revkit-ask-note">Note (optional):</label>
        <input
          id="revkit-ask-note"
          type="text"
          value={note()}
          maxLength={4096}
          onInput={(e: InputEvent) => setNote((e.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <button type="submit" class="revkit-ask__submit" data-testid="revkit-ask-submit">
        Submit answer
      </button>
    </form>
  );
}

function renderText(spec: TextSpec, onAnswer: (a: Answer) => void): JSX.Element {
  const [text, setText] = createSignal("");
  const submit = (): void => {
    const trimmed = text().trim();
    if (trimmed.length === 0) return;
    onAnswer({ kind: "text", text: trimmed });
  };
  return (
    <form
      class="revkit-ask__form"
      aria-label={spec.title}
      onSubmit={(e: SubmitEvent) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="revkit-ask__field">
        <label for="revkit-ask-text">Your answer</label>
        <Show
          when={spec.multiline === true}
          fallback={
            <input
              id="revkit-ask-text"
              type="text"
              value={text()}
              placeholder={spec.placeholder ?? ""}
              maxLength={65_535}
              autofocus
              onInput={(e: InputEvent) => setText((e.currentTarget as HTMLInputElement).value)}
            />
          }
        >
          <textarea
            id="revkit-ask-text"
            rows="6"
            value={text()}
            placeholder={spec.placeholder ?? ""}
            maxLength={65_535}
            autofocus
            onInput={(e: InputEvent) => setText((e.currentTarget as HTMLTextAreaElement).value)}
          />
        </Show>
      </div>
      <button type="submit" class="revkit-ask__submit" data-testid="revkit-ask-submit">
        Submit answer
      </button>
    </form>
  );
}

function renderRegion(spec: RegionSpec, onAnswer: (a: Answer) => void): JSX.Element {
  const [x, setX] = createSignal<number | undefined>(undefined);
  const [y, setY] = createSignal<number | undefined>(undefined);
  const [note, setNote] = createSignal("");
  const pick = (event: MouseEvent): void => {
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    // Clamp to [0, 1] so a marginal click reports 0 or 1 rather
    // than a negative outside coordinate.
    setX(Math.max(0, Math.min(1, px / rect.width)));
    setY(Math.max(0, Math.min(1, py / rect.height)));
  };
  const submit = (): void => {
    const cx = x();
    const cy = y();
    if (cx === undefined || cy === undefined) return;
    const trimmed = note().trim();
    onAnswer({
      kind: "region",
      coordinates: [cx, cy],
      ...(trimmed.length > 0 ? { note: trimmed } : {}),
    });
  };
  return (
    <form
      class="revkit-ask__form"
      aria-label={spec.title}
      onSubmit={(e: SubmitEvent) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="revkit-ask__region-target">
        <span class="revkit-ask__region-target-path">Target: {spec.target}</span>
        <div
          class="revkit-ask__region-canvas"
          role="button"
          tabindex="0"
          aria-label={`Click a point on ${spec.target}`}
          onClick={pick}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            // Keyboard fallback: place at the centre. Users who
            // cannot mouse-click still land on a valid coordinate.
            setX(0.5);
            setY(0.5);
          }}
        >
          <Show when={x() !== undefined}>
            <span
              class="revkit-ask__region-marker"
              style={`left: ${(x() ?? 0) * 100}%; top: ${(y() ?? 0) * 100}%;`}
              aria-hidden="true"
            />
          </Show>
        </div>
        <output aria-live="polite" class="revkit-ask__region-value">
          <Show when={x() !== undefined} fallback="No point picked">
            x={x()?.toFixed(3)}, y={y()?.toFixed(3)}
          </Show>
        </output>
      </div>
      <div class="revkit-ask__field">
        <label for="revkit-ask-note">Note (optional):</label>
        <input
          id="revkit-ask-note"
          type="text"
          value={note()}
          maxLength={4096}
          onInput={(e: InputEvent) => setNote((e.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <button
        type="submit"
        class="revkit-ask__submit"
        data-testid="revkit-ask-submit"
        disabled={x() === undefined}
      >
        Submit point
      </button>
    </form>
  );
}

function renderReview(spec: ReviewSpec, onAnswer: (a: Answer) => void): JSX.Element {
  const [decision, setDecision] = createSignal<"approve" | "request-changes" | "comment" | undefined>(undefined);
  const [note, setNote] = createSignal("");
  const submit = (): void => {
    const d = decision();
    if (d === undefined) return;
    const trimmed = note().trim();
    onAnswer({
      kind: "review",
      decision: d,
      ...(trimmed.length > 0 ? { note: trimmed } : {}),
    });
  };
  return (
    <form
      class="revkit-ask__form"
      aria-label={spec.title}
      onSubmit={(e: SubmitEvent) => {
        e.preventDefault();
        submit();
      }}
    >
      <p class="revkit-ask__review-target">Review target: {spec.target}</p>
      <div class="revkit-ask__options" role="radiogroup" aria-label={spec.title}>
        <For each={["approve", "request-changes", "comment"] as const}>
          {(id): JSX.Element => {
            const label = id === "request-changes" ? "Request changes" : id === "approve" ? "Approve" : "Comment";
            const domId = `revkit-ask-review-${id}`;
            return (
              <div class="revkit-ask__option">
                <label class="revkit-ask__option-label" for={domId}>
                  <input
                    type="radio"
                    id={domId}
                    name="revkit-ask-review"
                    value={id}
                    checked={decision() === id}
                    onChange={() => setDecision(id)}
                  />
                  <span class="revkit-ask__option-text">{label}</span>
                </label>
              </div>
            );
          }}
        </For>
      </div>
      <div class="revkit-ask__field">
        <label for="revkit-ask-note">Note (optional):</label>
        <input
          id="revkit-ask-note"
          type="text"
          value={note()}
          maxLength={4096}
          onInput={(e: InputEvent) => setNote((e.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <button
        type="submit"
        class="revkit-ask__submit"
        data-testid="revkit-ask-submit"
        disabled={decision() === undefined}
      >
        Submit review
      </button>
    </form>
  );
}

// ── Root component ────────────────────────────────────────────────

function AskPage(props: { boot: Boot }): JSX.Element {
  const [record, { refetch }] = createResource<AskRecord, string>(
    () => props.boot.id,
    async (id) => fetchAsk(id),
    { initialValue: props.boot.initial },
  );
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [submitting, setSubmitting] = createSignal(false);

  // Live re-render when a `/events` frame arrives that touches THIS
  // ask. The EventSource shares the session cookie via
  // `credentials: "same-origin"` on same-origin requests (EventSource
  // sends cookies by default on same-origin).
  onMount(() => {
    let closed = false;
    const source = new EventSource("/events");
    source.onmessage = (event: MessageEvent<string>): void => {
      try {
        const payload = JSON.parse(event.data) as { readonly kind?: string; readonly askId?: string };
        if (typeof payload.askId === "string" && payload.askId === props.boot.id) {
          void refetch();
        }
      } catch {
        // Ignore keepalives / malformed frames.
      }
    };
    source.onerror = (): void => {
      // Fall back to a poll: if the EventSource cannot reconnect
      // (browser tab in the background, network hiccup), a periodic
      // `refetch` keeps the page truthful without hammering the API.
      if (closed) return;
      setTimeout(() => void refetch(), 2000);
    };
    onCleanup(() => {
      closed = true;
      source.close();
    });
  });

  const onAnswer = async (answer: Answer): Promise<void> => {
    if (submitting()) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await submitAnswer(props.boot.id, answer);
      await refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const renderKind = (r: AskRecord): JSX.Element => {
    switch (r.spec.kind) {
      case "choice":
        return renderChoice(r.spec, onAnswer);
      case "rank":
        return renderRank(r.spec, onAnswer);
      case "scale":
        return renderScale(r.spec, onAnswer);
      case "text":
        return renderText(r.spec, onAnswer);
      case "region":
        return renderRegion(r.spec, onAnswer);
      case "review":
        return renderReview(r.spec, onAnswer);
    }
  };

  return (
    <Show when={record()} fallback={<div class="revkit-ask" data-testid="revkit-ask-root" data-status="pending" />}>
      {(current) => (
        <div class="revkit-ask" data-testid="revkit-ask-root" data-status={current().status}>
          <header class="revkit-ask__header">
            <h1 class="revkit-ask__title">{current().spec.title}</h1>
            <p class="revkit-ask__kind">Kind: {current().spec.kind}</p>
            <Show when={current().spec.prompt !== undefined}>
              <p class="revkit-ask__prompt">{current().spec.prompt}</p>
            </Show>
          </header>
          <main class="revkit-ask__body">
            <Show
              when={current().status === "pending"}
              fallback={
                <section class="revkit-ask__terminal" data-testid="revkit-ask-terminal">
                  <p class="revkit-ask__terminal-status">
                    This question is <strong>{current().status}</strong>.
                  </p>
                  <Show when={current().status === "answered"}>
                    <pre class="revkit-ask__answer"><code>{JSON.stringify(current().answer, null, 2)}</code></pre>
                  </Show>
                  <Show when={current().status === "cancelled" && current().cancelReason !== undefined}>
                    <p>Reason: {current().cancelReason}</p>
                  </Show>
                </section>
              }
            >
              {renderKind(current())}
            </Show>
            <Show when={error() !== undefined}>
              <p class="revkit-ask__error" role="alert">{error()}</p>
            </Show>
            <Show when={submitting()}>
              <p class="revkit-ask__submitting" aria-live="polite">Submitting…</p>
            </Show>
          </main>
        </div>
      )}
    </Show>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────

function mountAskPage(): void {
  const bootRecord = readBoot();
  const mount = document.getElementById("revkit-ask-mount");
  if (bootRecord === undefined || mount === null) return;
  render(() => <AskPage boot={bootRecord} />, mount);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountAskPage, { once: true });
} else {
  mountAskPage();
}
