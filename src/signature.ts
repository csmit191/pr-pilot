import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies GitHub's X-Hub-Signature-256 header.
 *
 * GitHub computes HMAC-SHA256(secret, rawBody) and sends "sha256=<hex>".
 * We must hash the RAW bytes: re-serializing parsed JSON can change whitespace/key order
 * and break the match. We compare in constant time so timing can't leak the signature.
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  const prefix = "sha256=";
  if (!header || !header.startsWith(prefix)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(header.slice(prefix.length), "hex");

  // timingSafeEqual throws if lengths differ, so check first.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}
