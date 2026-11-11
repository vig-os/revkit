// Runs the shared conformance suite against the hosted D1 store.
//
// The suite itself lives in `packages/review-core/test/store-conformance.ts`
// and runs against all THREE `ThreadStore` implementations; this file is the
// hosted lane. See that file's header for why the count is three and not two.
//
// Every case here wipes the tables between runs so the suite is
// order-independent: `bun test` may interleave, and a leaked event would
// make A5's "seq starts at 1" fail for the wrong reason.

import { afterAll, beforeAll, describe } from "bun:test";
import type { ThreadStore } from "@revkit/review-core";
import { D1ThreadStore } from "../src/d1-store.ts";
import { previewScopePath } from "../src/router.ts";
import { fixedClock, storeConformance, persistedAppendConformance, type StoreFactory } from "../../review-core/test/store-conformance.ts";
import { startWorker, type Harness } from "./harness.ts";

describe("D1ThreadStore (hosted, miniflare D1)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startWorker();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  // Slice 5: the hosted lane is the one store that must name WHICH log it is,
  // because the hosted table holds one log per `(repo, PR)` in the deployment.
  // The key is built by the same `previewScopePath` a route's scope uses, and
  // `reset` clears the whole partition rather than one key — the suite asserts
  // nothing about a log's neighbours, and a leaked row from another key would
  // make A5's "seq starts at 1" fail for the wrong reason, exactly as a leaked
  // event in the flat table used to.
  const d1Factory: StoreFactory = {
    name: "D1ThreadStore (hosted D1, workerd, one review's log)",
    async make(): Promise<ThreadStore> {
      return new D1ThreadStore({ db: harness.db, logKey: previewScopePath("revkit", 7), clock: fixedClock() });
    },
    // The hosted lane's production shape, verbatim: `src/index.ts` builds
    // `new D1ThreadStore({ db: env.DB, logKey })` per request, so the
    // instance that judges an archive is never the instance that wrote the
    // log. Before #107's fix that meant a per-instance `#head` of 0 and an
    // empty `#logState`, and the shared cases passed anyway — because the
    // suite handed every case ONE instance and that instance did the
    // appends too.
    async reopen(): Promise<ThreadStore> {
      return new D1ThreadStore({ db: harness.db, logKey: previewScopePath("revkit", 7), clock: fixedClock() });
    },
    async reset(): Promise<void> {
      for (const table of ["review_logs", "snapshots"]) {
        await harness.db.prepare(`DELETE FROM ${table}`).run();
      }
    },
  };

  storeConformance(d1Factory);
  persistedAppendConformance(d1Factory, async (row) => {
    await harness.db.prepare("INSERT INTO review_logs (log_key, seq, ts, payload) VALUES (?, ?, ?, ?)")
      .bind(previewScopePath("revkit", 7), row.seq, "2026-10-03T12:00:00Z", row.payload).run();
  });
});
