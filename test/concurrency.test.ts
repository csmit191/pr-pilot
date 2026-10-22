import { describe, expect, it } from "vitest";
import { mapWithLimit } from "../src/util/concurrency.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapWithLimit", () => {
  it("returns results in input order even when tasks finish out of order", async () => {
    const result = await mapWithLimit([30, 5, 15], 3, async (ms) => {
      await sleep(ms);
      return ms * 2;
    });
    expect(result).toEqual([60, 10, 30]);
  });

  it("never runs more than `limit` tasks at once, but does run them in parallel", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithLimit(Array.from({ length: 8 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithLimit([], 4, async (x: number) => x)).toEqual([]);
    expect(await mapWithLimit([1, 2], 10, async (x) => x + 1)).toEqual([2, 3]);
  });

  it("rejects if a task throws", async () => {
    await expect(
      mapWithLimit([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
  });
});
