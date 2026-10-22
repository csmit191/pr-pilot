import { describe, expect, it } from "vitest";
import { extractJsonObject, parseModelJson } from "../src/llm/json.js";
import { reviewSummarySchema } from "../src/llm/schema.js";
import { validReview } from "./fakeProvider.js";

describe("extractJsonObject", () => {
  it("returns bare JSON unchanged", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
    expect(extractJsonObject('  \n{"a":1}\n ')).toBe('{"a":1}');
  });

  it("unwraps code fences, with or without a language tag", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("finds an object surrounded by prose", () => {
    expect(extractJsonObject('Sure! Here you go: {"a":{"b":2}} Hope that helps.')).toBe('{"a":{"b":2}}');
  });

  it("returns null when there is no object", () => {
    expect(extractJsonObject("I cannot help with that.")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("} backwards {")).toBeNull();
  });
});

describe("parseModelJson", () => {
  it("returns validated data", () => {
    const result = parseModelJson(validReview(), reviewSummarySchema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.keyChanges).toEqual(["Writes an audit entry on every login"]);
  });

  it("reports when there is no JSON at all", () => {
    expect(parseModelJson("sorry", reviewSummarySchema)).toEqual({ ok: false, error: "No JSON object found in the reply." });
  });

  it("reports malformed JSON", () => {
    const result = parseModelJson('{"summary": "x",}', reviewSummarySchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  it("reports schema violations with the path of each problem", () => {
    const bad = validReview({ risks: [{ file: "a.ts", reason: "bad", severity: "urgent" }], keyChanges: "nope" });
    const result = parseModelJson(bad, reviewSummarySchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("risks.0.severity");
      expect(result.error).toContain("keyChanges");
    }
  });

  it("rejects missing fields and oversized answers", () => {
    expect(parseModelJson('{"summary":"only this"}', reviewSummarySchema).ok).toBe(false);
    const tooMany = validReview({ keyChanges: Array.from({ length: 11 }, (_, i) => `change ${i}`) });
    expect(parseModelJson(tooMany, reviewSummarySchema).ok).toBe(false);
  });
});
