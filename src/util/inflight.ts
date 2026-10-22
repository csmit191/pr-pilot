export interface InFlightTracker {
  /** Registers work that has started. How it ends doesn't matter here; the caller handles errors. */
  track(work: Promise<unknown>): void;
  /** How many tracked pieces of work are still running. */
  count(): number;
  /** Resolves true as soon as nothing is running, or false if `timeoutMs` passes first. */
  idle(timeoutMs: number): Promise<boolean>;
}

/**
 * Keeps count of work that is still running, so a shutdown can wait for it. We answer webhooks
 * with 202 *before* the review is done, so "no open connections" does not mean "no work left".
 */
export function createInFlightTracker(): InFlightTracker {
  const running = new Set<Promise<void>>();
  let waiters: Array<() => void> = [];

  return {
    track(work) {
      // A failure is the caller's business; here we only need to know when it stopped.
      const stopped = work.then(
        () => undefined,
        () => undefined,
      );
      running.add(stopped);
      void stopped.then(() => {
        running.delete(stopped);
        if (running.size === 0) {
          const ready = waiters;
          waiters = [];
          for (const wake of ready) wake();
        }
      });
    },

    count: () => running.size,

    idle(timeoutMs) {
      if (running.size === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== wake);
          resolve(false);
        }, timeoutMs);
        waiters.push(wake);
      });
    },
  };
}
