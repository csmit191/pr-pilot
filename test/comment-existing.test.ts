import { describe, expect, it } from "vitest";
import { parseIssueComments } from "../src/comment/existing.js";

describe("parseIssueComments", () => {
  it("extracts id, body and the posting app's id", () => {
    const result = parseIssueComments([
      { id: 1, body: "from a person", user: { login: "alice" }, performed_via_github_app: null },
      { id: 2, body: "from our app", performed_via_github_app: { id: 123, slug: "pr-pilot", name: "PR Pilot" } },
    ]);
    expect(result).toEqual([
      { id: 1, body: "from a person", appId: null },
      { id: 2, body: "from our app", appId: 123 },
    ]);
  });

  it("treats a missing or null body as empty, and a missing app as null", () => {
    expect(parseIssueComments([{ id: 5, body: null }, { id: 6 }])).toEqual([
      { id: 5, body: "", appId: null },
      { id: 6, body: "", appId: null },
    ]);
  });

  it("tolerates an app object we can't read", () => {
    expect(parseIssueComments([{ id: 7, body: "x", performed_via_github_app: {} }])).toEqual([
      { id: 7, body: "x", appId: null },
    ]);
  });

  it("drops entries without an id and rejects non-list responses", () => {
    expect(parseIssueComments([{ body: "no id" }, "junk", null])).toEqual([]);
    expect(() => parseIssueComments({ message: "Not Found" })).toThrow("Unexpected comment list response");
  });
});
