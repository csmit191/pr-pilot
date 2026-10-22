export type RunResult<T> = { skipped: true } | { skipped: false; value: T };

export interface LatestWinsQueue {
  /**
   * Runs `task` after every earlier task for the same `key` has finished (one at a time per key).
   *
   * If a newer task for the same key is queued before this one starts, this one is skipped:
   * the newer push makes it obsolete. A running task can ask `isSuperseded()` before it does
   * something irreversible (like posting) to find out whether a newer one has arrived since.
   */
  run<T>(key: string, task: (isSuperseded: () => boolean) => Promise<T>): Promise<RunResult<T>>;
}

/** In-memory, so it protects a single server process (fine for one free-tier instance). */
export function createLatestWinsQueue(): LatestWinsQueue {
  const tails = new Map<string, Promise<void>>();
  const latest = new Map<string, number>();
  let counter = 0;

  function run<T>(key: string, task: (isSuperseded: () => boolean) => Promise<T>): Promise<RunResult<T>> {
    const ticket = ++counter;
    latest.set(key, ticket);
    const isSuperseded = (): boolean => latest.get(key) !== ticket;

    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(async (): Promise<RunResult<T>> => {
      if (isSuperseded()) return { skipped: true };
      return { skipped: false, value: await task(isSuperseded) };
    });

    // The next task waits for this one to settle, whether it succeeded or failed.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) {
        tails.delete(key); // nothing newer queued: forget this key so the maps don't grow forever
        latest.delete(key);
      }
    });
    return result;
  }

  return { run };
}
