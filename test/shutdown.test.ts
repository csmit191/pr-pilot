import { describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "../src/shutdown.js";
import { createInFlightTracker } from "../src/util/inflight.js";

function setup(graceMs = 1000) {
  const tracker = createInFlightTracker();
  const server = { close: vi.fn() };
  const log = { info: vi.fn(), warn: vi.fn() };
  const exit = vi.fn();
  const shutdown = createShutdownHandler({ server, tracker, graceMs, log, exit });
  return { tracker, server, log, exit, shutdown };
}

describe("createShutdownHandler", () => {
  it("stops accepting webhooks and exits cleanly when nothing is running", async () => {
    const { server, exit, shutdown, log } = setup();
    await shutdown("SIGTERM");
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.info).toHaveBeenCalledWith("Shutting down", { signal: "SIGTERM", reviewsInFlight: 0 });
  });

  it("waits for a review that is already running before exiting", async () => {
    const { tracker, exit, shutdown, server } = setup();
    let finish!: () => void;
    tracker.track(new Promise<void>((resolve) => (finish = resolve)));

    const done = shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.close).toHaveBeenCalledTimes(1); // stopped taking new work immediately
    expect(exit).toHaveBeenCalledTimes(0); // but has not exited: the review is still running

    finish();
    await done;
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("gives up after the grace period, says what it abandoned, and exits with a failure code", async () => {
    const { tracker, exit, shutdown, log } = setup(10);
    tracker.track(new Promise<void>(() => {})); // never finishes
    await shutdown("SIGTERM");
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("abandoning"), { abandoned: 1 });
  });

  it("ignores a second signal while shutting down (e.g. SIGTERM then Ctrl+C)", async () => {
    const { tracker, server, exit, shutdown } = setup();
    let finish!: () => void;
    tracker.track(new Promise<void>((resolve) => (finish = resolve)));

    const first = shutdown("SIGTERM");
    await shutdown("SIGINT");
    expect(server.close).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
