// `POST /api/publish` orchestrator (M2 item 9, story A4, ADR-0001
// amendment).
//
// The daemon accepts a batch of source files, validates them under
// the publish confinement + `revkit check`, writes them atomically,
// re-anchors comments, renders a fast-path HTML fragment for every
// `.md` document, splices that fragment into the existing built
// HTML under the target route, and stores the result as an
// IN-MEMORY OVERRIDE keyed on the route. Subsequent GETs of that
// route serve the override until a full `astro build` refreshes
// `site/dist/` on disk.
//
// The publish path is SERIALISED via a module-level mutex — one
// writer at a time. Concurrent publish requests queue; the second
// caller's request runs against the state the first one left on
// disk, so `revkit check` runs on a consistent snapshot. The rail
// re-fetches its state after `doc.published`, so the second caller
// sees the first caller's already-visible page.
//
// Design notes (why this over an incremental Astro build):
//
// - The whole `astro build` takes 3–5 seconds on this repo; the
//   story bar is under one second. The fast-path pipeline runs the
//   same remark/rehype plugins as `astro.config.mjs` on the SINGLE
//   changed document, so `data-src` stamps are identical and
//   thread anchors survive. Test:
//   `test/serve/publish-equivalence.test.ts` diffs the article
//   body of the fast path against a full build.
// - The shell (Starlight sidebar / header / footer / CSP-safe
//   scripts) is preserved BYTE FOR BYTE by splicing only the
//   `<div class="sl-markdown-content">…</div>` region. A page that
//   has never been built ("brand-new document") falls back to
//   emitting `doc.published` without an override; a background
//   full build catches up.
// - The daemon does NOT write into `site/dist/`. Overrides live in
//   memory; the next `bun run build` produces a fresh `site/dist/`
//   that the daemon serves from disk again (the override map is
//   cleared for that route on daemon restart or when a fresh dist
//   file is served with the matching revision).
//
// **Security discipline** (ADR-0013 amendment):
//
// - Every path goes through `resolvePublishTarget` — allowlisted
//   subtrees, extensions, symlink refusal.
// - Every file's serialised size is capped
//   (`PUBLISH_FILE_MAX_BYTES`), and the whole request too
//   (`PUBLISH_REQUEST_MAX_BYTES`).
// - Writes are ATOMIC (write to a sibling `.tmp-<random>` then
//   rename). A partial write cannot leave a half-written file on
//   disk for the next `revkit check` to trip over.
// - Rollback on `revkit check` failure: the previous content is
//   restored (or the newly-created file is deleted if it did not
//   exist before the publish). The daemon's own reads see the
//   rollback because they always go to disk via the store's
//   snapshot path.
// - `revkit check` runs in-process (no `bun`/`bunx`, per
//   CLAUDE.md's "no bunx/npx in a trusted path"). It uses the
//   same rule set as the pre-commit hook — refuses hand-rolled
//   HTML, off-vocab terms, mis-shaped plots, and so on.
//
// **Presence** (ADR-0007 §5.3 last paragraph, M2 item 6 round 2):
// presence beacons are EPHEMERAL — a viewer chip, not a durable
// log entry. The orchestrator calls the presence hub's
// `editing(actor, location)` BEFORE the write and `idle(actor)`
// AFTER the fanout, matching the "agent is editing X" flow #53
// shipped. Nothing about the publish itself lives on the
// `PresenceFrame` stream — that stream is per-viewer state, not a
// history.
//
// **Fan-out audiences** (M2 item 6 round 2). `doc.published`
// concerns BOTH the rail (page reload) and the agent (turn-level
// "the doc I was iterating on landed"), so the publish emits with
// audiences=["rail","agent"]. The delivery mode's own filter
// (`shouldFanOutToAgent`) accepts `doc.published` unconditionally
// today because publish is initiated by the agent — no
// human-authored comment gating is relevant. If a future ADR
// changes that, this is the one call site to update.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Author, ReviewEvent } from "@revkit/review-core";
import { revisionOf } from "@revkit/review-core";
import { runCheck, toCheckFiles } from "../check.ts";
import { spawnGh } from "../gh-runner.ts";
import type { EventBus, SubscriberAudience } from "./event-bus.ts";
import type { PresenceHub } from "./presence-hub.ts";
import type { SqliteThreadStore } from "./sqlite-store.ts";
import {
  PUBLISH_FILE_MAX_BYTES,
  PUBLISH_REQUEST_MAX_BYTES,
  UNIFORM_PUBLISH_REJECTION,
  resolvePublishTarget,
} from "./publish-confine.ts";
import { isRenderablePath, renderDocFragment } from "./publish-render.ts";

/** Result of one publish. `published` is one entry per file in the
 * batch that reached disk; `overrides` names the routes for which
 * the daemon now serves a fast-path HTML fragment. On any failure
 * (validation, check, disk) the whole batch is rolled back and
 * `ok: false` is returned with a `kind` the caller can branch on. */
export type PublishOutcome =
  | {
      readonly ok: true;
      readonly published: readonly {
        readonly path: string;
        readonly route: string | undefined;
        readonly revision: string;
      }[];
      readonly seqs: readonly number[];
      readonly overrides: readonly {
        readonly route: string;
        readonly html: string;
        readonly dataSrcCount: number;
      }[];
    }
  | {
      readonly ok: false;
      readonly kind:
        | "confinement"
        | "too-large"
        | "check-failed"
        | "render-failed"
        | "shell-missing"
        | "write-failed"
        | "internal";
      readonly reason: string;
      readonly diagnostics?: readonly string[];
    };

/** One entry the client provided. `content` is the LF-normalised
 * source (the daemon normalises again as a defence in depth). */
export interface PublishFileInput {
  readonly path: string;
  readonly content: string;
}

/** Injection dependencies. Kept as parameters so a test can pass a
 * stubbed store / bus / gh runner without spinning up a full daemon. */
export interface PublishDependencies {
  readonly repoRoot: string;
  readonly store: SqliteThreadStore;
  readonly bus: EventBus;
  readonly presence: PresenceHub;
  readonly agentActor: Author;
  readonly systemActor: Author;
  readonly repoSlug: string;
  /** Trigger the re-anchor pipeline against `path` after the write.
   * The daemon passes its `reanchor.refresh` function; tests may
   * pass a no-op. */
  readonly refreshAnchors: (path: string) => Promise<void>;
  readonly reconcileWatchers: () => void;
  /** Fold a freshly-appended event into the delivery adapter's
   * incremental cache. The daemon's own `safeIngest` handles the
   * `IngestGapError` recovery path; publish just calls this after
   * every append so the derived state stays in lockstep. */
  readonly ingestDelivery: (event: ReviewEvent) => Promise<void>;
  /** Serve-dir root — used to locate the pre-existing built HTML
   * for the fast-path splice. `undefined` when the daemon serves
   * a directory that isn't a real astro build (a template-smoke
   * scenario), in which case `renderIntoSite` degrades to "no
   * override, just the event fanout". */
  readonly distDir: string;
  /** Called with the completed override AFTER the event has been
   * fanned out. The daemon's static handler holds an override map
   * keyed on `route`; this callback is what updates it. Passed in
   * (instead of imported) so the override map's lifecycle stays
   * with the daemon: the map is cleared on daemon stop. */
  readonly setOverride: (route: string, override: PublishOverride) => void;
}

/** One override the daemon holds in memory. `revision` is the source
 * revision the override was rendered from — the static handler uses
 * it to reconcile against disk when a full `astro build` catches
 * up. */
export interface PublishOverride {
  readonly html: string;
  readonly revision: string;
  readonly renderedAtMs: number;
  readonly dataSrcCount: number;
}

/** Public entry point. Runs the whole publish pipeline for one
 * batch of files. */
export async function runPublish(
  input: {
    readonly docs: readonly PublishFileInput[];
    readonly data?: readonly PublishFileInput[];
  },
  deps: PublishDependencies,
): Promise<PublishOutcome> {
  // The mutex is module-scoped so ALL callers on this daemon serialise.
  return await publishMutex.run(() => runPublishInner(input, deps));
}

// ── implementation ─────────────────────────────────────────────────

async function runPublishInner(
  input: {
    readonly docs: readonly PublishFileInput[];
    readonly data?: readonly PublishFileInput[];
  },
  deps: PublishDependencies,
): Promise<PublishOutcome> {
  const files = [...input.docs, ...(input.data ?? [])];
  if (files.length === 0) {
    return { ok: false, kind: "confinement", reason: "publish: batch is empty" };
  }
  if (files.length > MAX_FILES_PER_PUBLISH) {
    return {
      ok: false,
      kind: "confinement",
      reason: `publish: batch has ${files.length} files, cap is ${MAX_FILES_PER_PUBLISH}`,
    };
  }
  // 1) Aggregate size + per-file size caps + normalise line endings.
  interface Resolved {
    readonly input: PublishFileInput;
    readonly absolutePath: string;
    readonly siteRoute: string | undefined;
    readonly normalised: string;
    readonly revision: string;
  }
  let totalBytes = 0;
  const resolved: Resolved[] = [];
  const seenPaths = new Set<string>();
  for (const file of files) {
    if (seenPaths.has(file.path)) {
      return {
        ok: false,
        kind: "confinement",
        reason: `publish: duplicate path in batch: ${file.path}`,
      };
    }
    seenPaths.add(file.path);
    const target = resolvePublishTarget(deps.repoRoot, file.path);
    if (!target.ok) {
      return { ok: false, kind: "confinement", reason: target.reason };
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > PUBLISH_FILE_MAX_BYTES) {
      return {
        ok: false,
        kind: "too-large",
        reason: `publish: file '${file.path}' is ${bytes} bytes, cap is ${PUBLISH_FILE_MAX_BYTES}`,
      };
    }
    totalBytes += bytes;
    if (totalBytes > PUBLISH_REQUEST_MAX_BYTES) {
      return {
        ok: false,
        kind: "too-large",
        reason: `publish: batch total ${totalBytes} bytes exceeds cap ${PUBLISH_REQUEST_MAX_BYTES}`,
      };
    }
    // LF-normalise to match `revisionOf`'s normalisation on read.
    const normalised = file.content.replace(/\r\n?/g, "\n");
    const revision = await revisionOf(normalised);
    resolved.push({
      input: file,
      absolutePath: target.absolutePath,
      siteRoute: target.siteRoute,
      normalised,
      revision,
    });
  }

  // 2) Atomic write with rollback support.
  //
  //    Snapshot the previous contents (or record "did not exist")
  //    BEFORE writing so a `revkit check` failure can restore the
  //    tree exactly as we found it.
  interface Snapshot {
    readonly absolutePath: string;
    readonly existed: boolean;
    readonly previous?: string;
  }
  const snapshots: Snapshot[] = [];
  const writtenPaths: string[] = [];
  const rollback = (): void => {
    for (const snapshot of [...snapshots].reverse()) {
      try {
        if (snapshot.existed && snapshot.previous !== undefined) {
          writeFileSync(snapshot.absolutePath, snapshot.previous, "utf8");
        } else if (existsSync(snapshot.absolutePath)) {
          unlinkSync(snapshot.absolutePath);
        }
      } catch {
        // Best-effort rollback: the disk is inconsistent already,
        // so swallowing the error avoids masking the original
        // failure that the caller is about to return.
      }
    }
  };
  try {
    for (const entry of resolved) {
      let existed = false;
      let previous: string | undefined;
      try {
        const stat = statSync(entry.absolutePath);
        if (stat.isFile()) {
          existed = true;
          previous = readFileSync(entry.absolutePath, "utf8");
        }
      } catch {
        // Not-found is normal on a new-file publish.
      }
      snapshots.push({ absolutePath: entry.absolutePath, existed, ...(previous !== undefined ? { previous } : {}) });
      // Ensure parent exists (allowlist guarantees it, but a fresh
      // repo without `docs/adr/` would 404 here — the caller can
      // publish a new ADR only when the tree already exists, which
      // matches PUBLISH_ROOTS' scope).
      const parent = dirname(entry.absolutePath);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
      // Atomic: write to a temporary sibling, rename over the
      // target. `renameSync` on the same filesystem is atomic on
      // Linux/macOS.
      const tmp = `${entry.absolutePath}.tmp-${randomBytes(8).toString("hex")}`;
      writeFileSync(tmp, entry.normalised, "utf8");
      try {
        renameSync(tmp, entry.absolutePath);
      } catch (error) {
        // Rename failed — remove the temp so it does not linger.
        try {
          rmSync(tmp, { force: true });
        } catch {
          // Best-effort.
        }
        throw error;
      }
      writtenPaths.push(entry.absolutePath);
    }
  } catch (error) {
    rollback();
    return {
      ok: false,
      kind: "write-failed",
      reason: `publish: write failed: ${(error as Error).message}`,
    };
  }

  // 3) Run `revkit check` on the batch. This validates registered-
  //    component usage, vocabulary, links, plot structure, no
  //    hand-rolled UI. Runs OFFLINE (no `--online`) — the local
  //    daemon has no GITHUB_TOKEN by default, and the online check
  //    is a per-annotation issue-existence probe not relevant to a
  //    fresh publish (any `revkit-allow` annotation the agent
  //    writes will still be verified at commit time by the
  //    pre-commit hook).
  //
  //    Trusted mode: the agent is running against the local repo
  //    with the owner's session — the same trust boundary as a
  //    developer running `revkit check` locally. `revkit check`
  //    reads files by absolute path; the batch's paths are the
  //    ones just written.
  const checkOutput = await runCheck(
    deps.repoRoot,
    toCheckFiles(
      resolved.map((entry) => entry.absolutePath),
      deps.repoRoot,
    ),
    [],
    { online: false, repoSlug: deps.repoSlug, gh: spawnGh },
  );
  if (checkOutput.exitCode !== 0) {
    rollback();
    return {
      ok: false,
      kind: "check-failed",
      reason: `publish: revkit check refused the batch (${checkOutput.lines.length} finding${checkOutput.lines.length === 1 ? "" : "s"})`,
      diagnostics: checkOutput.lines,
    };
  }

  // 4) Emit `presence editing` for every doc in the batch. Round-2
  //    (M2 item 6) makes presence EPHEMERAL — no store append; the
  //    hub broadcasts the frame straight to `/events` subscribers.
  //    A restart forgets the beacon, which is exactly the right
  //    lifetime for "agent is editing X RIGHT NOW".
  for (const entry of resolved) {
    deps.presence.editing(deps.agentActor, { path: entry.input.path });
  }

  // 5) Fast-path render + shell splice.
  interface Rendered {
    readonly entry: Resolved;
    readonly override?: { route: string; html: string; dataSrcCount: number };
  }
  const rendered: Rendered[] = [];
  for (const entry of resolved) {
    if (entry.siteRoute === undefined || !isRenderablePath(entry.input.path)) {
      // Data side file (plot data, vocab) — no override, just the
      // event fanout below.
      rendered.push({ entry });
      continue;
    }
    let fragment: string;
    let dataSrcCount: number;
    try {
      const result = await renderDocFragment({
        repoRoot: deps.repoRoot,
        path: entry.input.path,
        source: entry.normalised,
      });
      fragment = result.html;
      dataSrcCount = result.dataSrcCount;
    } catch (error) {
      // A render failure after write is a "we-almost-had-it": the
      // file was accepted by `revkit check`, so leaving the write
      // in place is the right call (the next full build will still
      // render it). Emit `doc.published` without an override.
      rendered.push({ entry });
      // eslint-disable-next-line no-console
      console.error(`publish: fast-path render failed for ${entry.input.path}: ${(error as Error).message}`);
      continue;
    }
    // Splice the fragment into the existing built HTML.
    const spliced = await spliceIntoShell({
      distDir: deps.distDir,
      route: entry.siteRoute,
      fragment,
    });
    if (spliced === undefined) {
      // Shell missing (no full build ever ran, or the route is
      // new). Emit `doc.published` without an override.
      rendered.push({ entry });
      continue;
    }
    rendered.push({
      entry,
      override: { route: entry.siteRoute, html: spliced, dataSrcCount },
    });
  }

  // 6) Install overrides + emit `doc.published` for every entry.
  const overrides: { route: string; html: string; dataSrcCount: number }[] = [];
  const seqs: number[] = [];
  const publishedPaths = resolved.map((entry) => entry.input.path);
  const publishedAtMs = Date.now();
  for (const item of rendered) {
    if (item.override !== undefined) {
      deps.setOverride(item.override.route, {
        html: item.override.html,
        revision: item.entry.revision,
        renderedAtMs: publishedAtMs,
        dataSrcCount: item.override.dataSrcCount,
      });
      overrides.push(item.override);
    }
    const event: import("@revkit/review-core").ReviewEventInput = {
      kind: "doc.published",
      actor: deps.agentActor,
      path: item.entry.input.path,
      revision: item.entry.revision,
      ...(item.entry.siteRoute !== undefined ? { route: item.entry.siteRoute } : {}),
      // The full batch's paths — a listener that fetches ONE route
      // can decide whether a plot data change on the same batch
      // affects it.
      paths: publishedPaths,
    };
    const seq = await appendAndFanOut(deps, event, ["rail", "agent"] as const);
    seqs.push(seq);
  }

  // 7) Re-anchor each source-carrying path so any thread whose
  //    anchor lived on the file transitions to the new revision.
  //    `reanchor.refresh` is per-path and serialises per-path
  //    internally, so a concurrent watcher trigger joins the
  //    in-flight run.
  for (const entry of resolved) {
    // Only paths under `docs/` and `site/src/content/docs/` can
    // carry thread anchors; data files like `plots/x/data.json`
    // still trigger `refresh` because the plot spec that
    // references them is stamped, and a page render change from
    // the data may reposition the plot block. Cheap either way.
    try {
      await deps.refreshAnchors(entry.input.path);
    } catch {
      // Best-effort — a re-anchor failure is a separate concern,
      // and the publish itself is not undone by it.
    }
  }
  deps.reconcileWatchers();

  // 8) Emit `presence idle` per doc so the "agent is editing X"
  //    beacon flips off. Ephemeral broadcast; no store append.
  for (const entry of resolved) {
    deps.presence.idle(deps.agentActor, { path: entry.input.path });
  }

  return {
    ok: true,
    published: resolved.map((entry) => ({
      path: entry.input.path,
      route: entry.siteRoute,
      revision: entry.revision,
    })),
    seqs,
    overrides,
  };
}

// ── shell splicing ─────────────────────────────────────────────────

/** The `<div class="sl-markdown-content">…</div>` region is what
 * Starlight puts around the article body (see the built HTML
 * under `site/dist/`). Splicing at this boundary keeps the page
 * shell — sidebar, header, footer, CSP-safe scripts — byte-
 * identical to the last full build. */
export const ARTICLE_OPEN_MARKER = '<div class="sl-markdown-content">';

/** Splice `fragment` into the existing built HTML for `route`.
 * Returns the new HTML on success, or undefined when the shell is
 * missing (the site was never fully built for this route). The
 * caller emits `doc.published` without an override in that case. */
async function spliceIntoShell(options: {
  readonly distDir: string;
  readonly route: string;
  readonly fragment: string;
}): Promise<string | undefined> {
  const shellPath = shellPathForRoute(options.distDir, options.route);
  if (shellPath === undefined) return undefined;
  let raw: string;
  try {
    raw = readFileSync(shellPath, "utf8");
  } catch {
    return undefined;
  }
  return spliceArticleBody(raw, options.fragment);
}

/** Locate the built HTML for a site route. Astro emits
 * `<dist>/<route>/index.html`; the daemon's static handler also
 * accepts the file directly (a 404 fallback). Returns undefined
 * when neither shape exists. */
function shellPathForRoute(distDir: string, route: string): string | undefined {
  const trimmed = route.replace(/^\/+|\/+$/g, "");
  const candidate = trimmed.length === 0 ? `${distDir}/index.html` : `${distDir}/${trimmed}/index.html`;
  try {
    if (statSync(candidate).isFile()) return candidate;
  } catch {
    // Fall through.
  }
  return undefined;
}

/** Splice a rendered article fragment into the built HTML. Exported
 * for unit tests: input is the raw shell HTML plus the fragment, and
 * the return is the new HTML with the article body replaced. */
export function spliceArticleBody(shellHtml: string, fragment: string): string | undefined {
  const openAt = shellHtml.indexOf(ARTICLE_OPEN_MARKER);
  if (openAt === -1) return undefined;
  // Walk balanced `<div>` tags from the open marker to find the
  // matching close. A regex-only match would miss nested divs
  // (Starlight adds a lot). The walker is bounded (one HTML file),
  // linear, and refuses malformed input by returning undefined.
  let depth = 0;
  let cursor = openAt;
  while (cursor < shellHtml.length) {
    const nextOpen = shellHtml.indexOf("<div", cursor + 1);
    const nextClose = shellHtml.indexOf("</div>", cursor + 1);
    if (nextClose === -1) return undefined;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      cursor = nextOpen;
      continue;
    }
    if (depth === 0) {
      // Splice: keep everything before the marker's content start,
      // insert the new fragment, keep everything from the close on.
      const contentStart = openAt + ARTICLE_OPEN_MARKER.length;
      const contentEnd = nextClose;
      return shellHtml.slice(0, contentStart) + fragment + shellHtml.slice(contentEnd);
    }
    depth--;
    cursor = nextClose;
  }
  return undefined;
}

// ── event append + fanout ──────────────────────────────────────────

/** Append + fold into the delivery-mode cache + fan out to the named
 * audiences. `doc.published` reaches both `rail` and `agent`. Returns
 * the assigned `seq`. */
async function appendAndFanOut(
  deps: PublishDependencies,
  event: import("@revkit/review-core").ReviewEventInput,
  audiences: readonly SubscriberAudience[],
): Promise<number> {
  const seq = await deps.store.append(event);
  const events = await deps.store.since(seq - 1);
  const materialised = events.find((e: ReviewEvent) => e.seq === seq);
  if (materialised !== undefined) {
    await deps.ingestDelivery(materialised);
    // AWAIT the fanout so the POST /api/publish response cannot
    // return before every SSE subscriber has enqueued the frame.
    // A previous `void bus.publish` version let the daemon reply
    // 201 before the microtask that delivers to the SSE stream
    // ran; on CI that produced a flaky test where the client
    // polled `/events` after the 201 landed and missed the
    // frame. `bus.publish` awaits each subscriber's `deliver`,
    // which for SSE is a synchronous `controller.enqueue` — so
    // awaiting here is nearly free but removes the race.
    await deps.bus.publish(materialised, { audiences });
  }
  return seq;
}

// ── serialisation mutex ────────────────────────────────────────────

/** A tiny FIFO mutex — the daemon runs one publish at a time.
 * `runPublish` is the only public entry point that acquires it. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let resolve: () => void = () => {};
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this.tail = next;
    return previous.then(async () => {
      try {
        return await fn();
      } finally {
        resolve();
      }
    });
  }
}
const publishMutex = new Mutex();

// ── configuration ──────────────────────────────────────────────────

/** Hard cap on files per publish batch. Sixteen comfortably covers
 * an ADR with a plot (spec + data) plus a vocab tweak; a runaway
 * batch is refused so the mutex cannot be held for long. */
export const MAX_FILES_PER_PUBLISH = 16;

/** Re-export the confinement rejection so `daemon.ts` uses the same
 * spelling as the module tests. */
export { UNIFORM_PUBLISH_REJECTION };
