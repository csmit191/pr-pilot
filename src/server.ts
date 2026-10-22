import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logger } from "./logger.js";
import { verifySignature } from "./signature.js";
import type { InFlightTracker } from "./util/inflight.js";

const MAX_BODY_BYTES = 25 * 1024 * 1024; // GitHub's documented payload cap is 25 MB.

export interface WebhookEvent {
  name: string; // X-GitHub-Event, e.g. "pull_request"
  deliveryId: string; // X-GitHub-Delivery, useful for tracing a single webhook in logs
  payload: unknown;
}

export interface ServerOptions {
  secret: string;
  onEvent: (event: WebhookEvent) => Promise<void>;
  /** If given, every request and the review it starts are registered here, so a shutdown can wait for them. */
  tracker?: InFlightTracker;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("Body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function createWebhookServer({ secret, onEvent, tracker }: ServerOptions): Server {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404).end();
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }

    // Verify BEFORE parsing or trusting anything in the body.
    const signature = req.headers["x-hub-signature-256"];
    if (!verifySignature(secret, body, typeof signature === "string" ? signature : undefined)) {
      logger.warn("Rejected webhook: bad signature");
      res.writeHead(401).end("invalid signature");
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      res.writeHead(400).end("invalid json");
      return;
    }

    // Acknowledge fast; GitHub gives up after ~10s. Do the real work after responding.
    res.writeHead(202).end();

    const name = String(req.headers["x-github-event"] ?? "unknown");
    const deliveryId = String(req.headers["x-github-delivery"] ?? "unknown");
    const work = onEvent({ name, deliveryId, payload }).catch((err: unknown) => {
      logger.error("Event handler failed", {
        event: name,
        deliveryId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    tracker?.track(work);
  };

  return createServer((req, res) => {
    const request = handle(req, res).catch((err: unknown) => {
      logger.error("Webhook request failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.writeHead(500).end();
    });
    tracker?.track(request);
  });
}
