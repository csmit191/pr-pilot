import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebhookServer, type WebhookEvent } from "../src/server.js";
import { createInFlightTracker } from "../src/util/inflight.js";

const secret = "test-secret";
const sign = (body: string) =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

let server: Server;
let baseUrl: string;
const received: WebhookEvent[] = [];

beforeAll(async () => {
  server = createWebhookServer({
    secret,
    onEvent: async (e) => {
      received.push(e);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/webhook`, { method: "POST", body, headers });

describe("webhook server", () => {
  it("returns 401 and does not dispatch when the signature is missing", async () => {
    const before = received.length;
    const res = await post("{}");
    expect(res.status).toBe(401);
    expect(received.length).toBe(before);
  });

  it("returns 401 for a wrong signature", async () => {
    const res = await post("{}", { "x-hub-signature-256": "sha256=" + "0".repeat(64) });
    expect(res.status).toBe(401);
  });

  it("returns 202 and dispatches a correctly signed event", async () => {
    const body = JSON.stringify({ action: "opened" });
    const res = await post(body, {
      "x-hub-signature-256": sign(body),
      "x-github-event": "pull_request",
      "x-github-delivery": "abc-123",
    });
    expect(res.status).toBe(202);
    expect(received.at(-1)).toMatchObject({ name: "pull_request", deliveryId: "abc-123" });
  });

  it("returns 400 for a signed but non-JSON body", async () => {
    const body = "not json";
    const res = await post(body, { "x-hub-signature-256": sign(body) });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown routes and 200 for /healthz", async () => {
    expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });
});

describe("webhook server: tracking for graceful shutdown", () => {
  const tracker = createInFlightTracker();
  let release!: () => void;
  let tracked: Server;
  let url: string;

  beforeAll(async () => {
    tracked = createWebhookServer({
      secret,
      tracker,
      onEvent: () => new Promise<void>((resolve) => (release = resolve)), // a review that takes a while
    });
    await new Promise<void>((resolve) => tracked.listen(0, resolve));
    url = `http://127.0.0.1:${(tracked.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => tracked.close(() => resolve())));

  it("keeps counting the review after the 202 has been sent, until it finishes", async () => {
    const body = JSON.stringify({ action: "opened" });
    const res = await fetch(`${url}/webhook`, { method: "POST", body, headers: { "x-hub-signature-256": sign(body), "x-github-event": "pull_request" } });
    expect(res.status).toBe(202); // the client already has its answer...

    expect(tracker.count()).toBeGreaterThanOrEqual(1); // ...yet the server knows work is still going
    expect(await tracker.idle(10)).toBe(false);

    release();
    expect(await tracker.idle(1000)).toBe(true);
  });
});
