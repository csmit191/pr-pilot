import { describe, expect, it } from "vitest";
import { httpStatus } from "../src/util/http.js";

describe("httpStatus", () => {
  it("reads the status from an Octokit-style error", () => {
    expect(httpStatus(Object.assign(new Error("Not Found"), { status: 404 }))).toBe(404);
  });

  it("returns undefined for anything else", () => {
    expect(httpStatus(new Error("plain"))).toBeUndefined();
    expect(httpStatus({ status: "404" })).toBeUndefined();
    expect(httpStatus(null)).toBeUndefined();
    expect(httpStatus("oops")).toBeUndefined();
  });
});
