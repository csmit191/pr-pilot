import { describe, expect, it } from "vitest";
import { createLatestWinsQueue } from "../src/util/latestWins.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createLatestWinsQueue", () => {
  it("runs a task and returns its value", async () => {
    const queue = createLatestWinsQueue();
    expect(await queue.run("k", async () => 42)).toEqual({ skipped: false, value: 42 });
  });

  it("runs tasks for the same key one at a time, in order", async () => {
    const queue = createLatestWinsQueue();
    const events: string[] = [];
    const aStarted = deferred();
    const gate = deferred();

    const a = queue.run("k", async () => {
      events.push("A start");
      aStarted.resolve();
      await gate.promise;
      events.push("A end");
    });
    await aStarted.promise;
    const b = queue.run("k", async () => {
      events.push("B start");
      events.push("B end");
    });

    expect(events).toEqual(["A start"]); // B is waiting for A
    gate.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(["A start", "A end", "B start", "B end"]);
  });

  it("tells a running task when a newer one has been queued behind it", async () => {
    const queue = createLatestWinsQueue();
    const aStarted = deferred();
    const gate = deferred();
    const seen: boolean[] = [];

    const a = queue.run("k", async (isSuperseded) => {
      seen.push(isSuperseded());
      aStarted.resolve();
      await gate.promise;
      seen.push(isSuperseded());
    });
    await aStarted.promise;
    const b = queue.run("k", async () => undefined);
    gate.resolve();
    await Promise.all([a, b]);

    expect(seen).toEqual([false, true]);
  });

  it("skips queued tasks that a newer task replaced", async () => {
    const queue = createLatestWinsQueue();
    const aStarted = deferred();
    const gate = deferred();
    const ran: string[] = [];

    const a = queue.run("k", async () => {
      ran.push("A");
      aStarted.resolve();
      await gate.promise;
    });
    await aStarted.promise;
    const b = queue.run("k", async () => void ran.push("B"));
    const c = queue.run("k", async () => void ran.push("C"));
    gate.resolve();

    expect(await b).toEqual({ skipped: true });
    expect((await c).skipped).toBe(false);
    await a;
    expect(ran).toEqual(["A", "C"]);
  });

  it("skips a task that is replaced before it even starts", async () => {
    const queue = createLatestWinsQueue();
    const ran: string[] = [];
    const a = queue.run("k", async () => void ran.push("A"));
    const b = queue.run("k", async () => void ran.push("B"));
    expect(await a).toEqual({ skipped: true });
    expect((await b).skipped).toBe(false);
    expect(ran).toEqual(["B"]);
  });

  it("does not make different keys wait for each other", async () => {
    const queue = createLatestWinsQueue();
    const gate = deferred();
    const slow = queue.run("one", async () => gate.promise);
    expect(await queue.run("two", async () => "done")).toEqual({ skipped: false, value: "done" });
    gate.resolve();
    await slow;
  });

  it("rejects the failing caller but still runs the next task", async () => {
    const queue = createLatestWinsQueue();
    const aStarted = deferred();
    const gate = deferred();
    const a = queue.run("k", async () => {
      aStarted.resolve();
      await gate.promise;
      throw new Error("boom");
    });
    const caught = a.catch((e: unknown) => e);
    await aStarted.promise;
    const b = queue.run("k", async () => "ok");
    gate.resolve();

    expect((await caught) as Error).toBeInstanceOf(Error);
    expect(await b).toEqual({ skipped: false, value: "ok" });
  });

  it("starts fresh once everything has finished", async () => {
    const queue = createLatestWinsQueue();
    await queue.run("k", async () => undefined);
    const seen: boolean[] = [];
    await queue.run("k", async (isSuperseded) => void seen.push(isSuperseded()));
    expect(seen).toEqual([false]);
  });
});
