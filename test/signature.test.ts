import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "../src/signature.js";

const secret = "s3cret";
const body = Buffer.from('{"hello":"world"}');
const sign = (b: Buffer, s = secret) => "sha256=" + createHmac("sha256", s).update(b).digest("hex");

describe("verifySignature", () => {
  it("accepts a correct signature", () => {
    expect(verifySignature(secret, body, sign(body))).toBe(true);
  });
  it("rejects a signature made with the wrong secret", () => {
    expect(verifySignature(secret, body, sign(body, "other"))).toBe(false);
  });
  it("rejects a tampered body", () => {
    expect(verifySignature(secret, Buffer.from('{"hello":"w0rld"}'), sign(body))).toBe(false);
  });
  it("rejects a missing header", () => {
    expect(verifySignature(secret, body, undefined)).toBe(false);
  });
  it("rejects a header without the sha256= prefix", () => {
    expect(verifySignature(secret, body, sign(body).slice(7))).toBe(false);
  });
  it("rejects malformed or wrong-length hex without throwing", () => {
    expect(verifySignature(secret, body, "sha256=zzzz")).toBe(false);
    expect(verifySignature(secret, body, "sha256=abcd")).toBe(false);
  });
});
