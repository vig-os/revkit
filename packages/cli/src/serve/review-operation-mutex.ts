export interface AsyncMutex {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/** FIFO process-local mutex for review operations that read GitHub
 * truth and may mutate it. The queue advances even when an operation
 * throws, so one network failure cannot permanently block recovery. */
export function createAsyncMutex(): AsyncMutex {
  let tail: Promise<void> = Promise.resolve();
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}
