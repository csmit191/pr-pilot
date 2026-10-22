import { describe, expect, it } from "vitest";
import { createInFlightTracker } from "../src/util/inflight.js";

/** Lets already-resolved promises run their follow-up callbacks before we look at the result. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createInFlightTracker", () => {
  it("is idle immediately when nothing is running", async () => {
    const tracker = createInFlightTracker();
    expect(tracker.count()).toBe(0);
    expect(await tracker.idle(1000)).toBe(true);
  });

  it("counts running work and goes idle when it finishes", async () => {
    const tracker = createInFlightTracker();
    const a = deferred();
    const b = deferred();
    tracker.track(a.promise);
    tracker.track(b.promise);
    expect(tracker.count()).toBe(2);

    const idle = tracker.idle(5000);
    a.resolve();
    await flush();
    expect(tracker.count()).toBe(1);
    b.resolve();
    expect(await idle).toBe(true);
    expect(tracker.count()).toBe(0);
  });

  it("gives up with false when the work outlasts the timeout, and the work stays counted", async () => {
    const tracker = createInFlightTracker();
    const slow = deferred();
    tracker.track(slow.promise);
    expect(await tracker.idle(10)).toBe(false);
    expect(tracker.count()).toBe(1);
    slow.resolve();
  });

  it("treats failed work as finished and never throws or leaves an unhandled rejection", async () => {
    const tracker = createInFlightTracker();
    const failing = deferred();
    tracker.track(failing.promise);
    const idle = tracker.idle(5000);
    failing.reject(new Error("boom"));
    expect(await idle).toBe(true);
  });

  it("wakes every waiter, and waits for work that starts while it is waiting", async () => {
    const tracker = createInFlightTracker();
    const first = deferred();
    const second = deferred();
    tracker.track(first.promise);

    const waiterOne = tracker.idle(5000);
    const waiterTwo = tracker.idle(5000);
    tracker.track(second.promise); // arrives before the first finishes
    first.resolve();
    await flush();
    expect(tracker.count()).toBe(1); // still not idle

    second.resolve();
    expect(await Promise.all([waiterOne, waiterTwo])).toEqual([true, true]);
  });

  it("does not wake a waiter that already timed out when work later finishes", async () => {
    const tracker = createInFlightTracker();
    const slow = deferred();
    tracker.track(slow.promise);
    expect(await tracker.idle(5)).toBe(false);
    slow.resolve();
    await flush();
    expect(await tracker.idle(5)).toBe(true); // a fresh wait works normally
  });
});
