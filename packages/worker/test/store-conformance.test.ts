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
import { fixedClock, storeConformance, type StoreFactory } from "../../review-core/test/store-conformance.ts";
import { startWorker, type Harness } from "./harness.ts";

describe("D1ThreadStore (hosted, miniflare D1)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startWorker();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  const d1Factory: StoreFactory = {
    name: "D1ThreadStore (hosted D1, workerd)",
    async make(): Promise<ThreadStore> {
      return new D1ThreadStore({ db: harness.db, clock: fixedClock() });
    },
    async reset(): Promise<void> {
      for (const table of ["events", "snapshots"]) {
        await harness.db.prepare(`DELETE FROM ${table}`).run();
      }
    },
  };

  storeConformance(d1Factory);
});
