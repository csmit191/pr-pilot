import type { InFlightTracker } from "./util/inflight.js";

export interface ShutdownOptions {
  /** Anything with close(): stops accepting new connections. */
  server: { close(): unknown };
  tracker: InFlightTracker;
  /** How long to wait for running reviews before giving up. Hosts kill the process soon after SIGTERM. */
  graceMs: number;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  exit: (code: number) => void;
}

/**
 * Returns the function to call when the host asks the process to stop (SIGTERM on a deploy,
 * SIGINT from Ctrl+C). It stops taking new webhooks, lets reviews that are already running
 * finish (up to `graceMs`), then exits. Calling it again while it runs does nothing.
 */
export function createShutdownHandler({ server, tracker, graceMs, log, exit }: ShutdownOptions): (signal: string) => Promise<void> {
  let started = false;

  return async (signal) => {
    if (started) return;
    started = true;

    log.info("Shutting down", { signal, reviewsInFlight: tracker.count() });
    server.close();

    const drained = await tracker.idle(graceMs);
    if (drained) {
      log.info("Shutdown complete");
      exit(0);
    } else {
      log.warn("Grace period ended with reviews still running; abandoning them", { abandoned: tracker.count() });
      exit(1);
    }
  };
}
