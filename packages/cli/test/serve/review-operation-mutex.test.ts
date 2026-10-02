import { describe, expect, test } from "bun:test";
import { createAsyncMutex } from "../../src/serve/review-operation-mutex.ts";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("review operation mutex", () => {
  for (const [firstName, secondName] of [["repost", "discard"], ["discard", "repost"]] as const) {
    test(`serializes ${firstName} before ${secondName}`, async () => {
      const mutex = createAsyncMutex();
      const release = deferred();
      const firstEntered = deferred();
      const order: string[] = [];

      const first = mutex.run(async () => {
        order.push(`${firstName}:start`);
        firstEntered.resolve();
        await release.promise;
        order.push(`${firstName}:end`);
      });
      await firstEntered.promise;
      const second = mutex.run(async () => {
        order.push(`${secondName}:start`);
        order.push(`${secondName}:end`);
      });

      await Promise.resolve();
      expect(order).toEqual([`${firstName}:start`]);
      release.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual([
        `${firstName}:start`, `${firstName}:end`,
        `${secondName}:start`, `${secondName}:end`,
      ]);
    });
  }
});
