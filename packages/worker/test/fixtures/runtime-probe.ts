// ADR-0025's RUNTIME GATE, as code.
//
// ADR-0025 claims one review core serves three surfaces — Bun (the local
// daemon), the browser, and a Cloudflare Worker. review-core already
// guards the claim from two directions that are both PROXIES: a specifier
// scan (`test/src-imports.test.ts`) and a `bun build --target=browser`
// (`test/browser-build.test.ts`). Neither is workerd. A proxy is exactly
// the kind of plausible-mechanism story this repo's durable lessons warn
// about, so this module exists to run the graph in the real runtime.
//
// It is dispatched through the SAME miniflare configuration the Worker
// uses, with the SAME empty `compatibility_flags`. That is what makes the
// no-`nodejs_compat` claim enforced by the platform rather than by a lint:
// workerd simply has no `Buffer`, `process` or `require` to fall back on,
// and the `/globals` route below reports exactly that from inside the
// runtime rather than from a comment.
//
// It imports `../../src/d1-store.ts` — the Worker's OWN module, not just
// the core — so what runs here is the deployed Worker's dependency graph,
// not a hand-picked subset of it.

import { exportArchive, isUnanchoredAnchor, revisionOf, InMemoryThreadStore } from "@revkit/review-core";
import { D1ThreadStore } from "../../src/d1-store.ts";

/** The exact input ADR-0006's acceptance pins: SHA-256 of the source
 * normalised to LF line endings. The CRLF makes it a real test of the
 * normalisation rather than a hash of a string that happens to be LF
 * already. */
const REVISION_INPUT = "line1\r\nline2\n";

export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const url = new URL(request.url);
    const json = (value: unknown, status = 200): Response =>
      new Response(`${JSON.stringify(value)}\n`, { status, headers: { "content-type": "application/json" } });

    if (url.pathname === "/revision") {
      return json({ revision: await revisionOf(REVISION_INPUT) });
    }

    if (url.pathname === "/globals") {
      // Read from INSIDE the runtime. A claim that `Buffer` is absent
      // should be a measurement, not a citation.
      return json({
        buffer: typeof globalThis.Buffer,
        process: typeof globalThis.process,
        require: typeof globalThis.require,
        cryptoRandomUUID: typeof globalThis.crypto?.randomUUID,
        textEncoder: typeof globalThis.TextEncoder,
      });
    }

    if (url.pathname === "/store") {
      // The full hosted-store bridge, executed by workerd: D1 append ->
      // exportArchive -> import into a fresh in-memory store -> threads().
      // This is `revkit threads export|import` running in the Worker.
      const d1 = new D1ThreadStore({ db: env.DB });
      const seq = await d1.append({
        actor: { kind: "gh-user", id: "gerchowl" },
        kind: "comment.created",
        threadId: "th-runtime",
        commentId: "c-runtime",
        anchor: {
          path: "docs/a.mdx",
          startLine: 2,
          endLine: 2,
          quote: { exact: "line2", prefix: "line1\n", suffix: "" },
          revision: await revisionOf("line1\nline2\n"),
        },
        body: "runtime gate",
      });
      const archive = await exportArchive(d1);
      const local = new InMemoryThreadStore();
      await local.import(archive);
      const threads = await local.threads();
      const first = threads[0];
      return json({
        seq,
        archived: archive.events.length,
        threads: threads.length,
        status: first?.status,
        startLine: first === undefined || isUnanchoredAnchor(first.anchor) ? null : first.anchor.startLine,
      });
    }

    return json({ error: "not-found" }, 404);
  },
};
