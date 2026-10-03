// Runs the shared conformance suite against BOTH stores.
//
// `InMemoryThreadStore` is review-core's reference implementation and
// `D1ThreadStore` is the hosted Worker's backing. This is the file that
// makes "one core, two stores" a tested claim rather than a comment: every
// case in `store-conformance.ts` runs for both, with no skip mechanism
// available to reach for.

import { afterAll, beforeAll, describe } from "bun:test";
import { InMemoryThreadStore, type ThreadStore } from "@revkit/review-core";
import { D1ThreadStore } from "../src/d1-store.ts";
import { fixedClock, storeConformance, type StoreFactory } from "./store-conformance.ts";
import { startWorker, type Harness } from "./harness.ts";

storeConformance({
  name: "InMemoryThreadStore (review-core reference)",
  async make(): Promise<ThreadStore> {
    return new InMemoryThreadStore({ clock: fixedClock() });
  },
  async reset(): Promise<void> {
    // Nothing to drop — a fresh instance starts empty, which is what
    // `make()` hands back.
  },
});

describe("D1ThreadStore (hosted, miniflare D1)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startWorker();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  // Every case wipes the tables between runs so the suite is
  // order-independent: `bun test` may interleave, and a leaked event
  // would make A5's "seq starts at 1" fail for the wrong reason.
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
