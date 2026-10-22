import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChangedFiles } from "../src/diff/parse.js";

const loadFixture = (name: string): unknown[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown[];

describe("parseChangedFiles", () => {
  const files = parseChangedFiles(loadFixture("files-basic.json"));
  const byPath = (path: string) => {
    const file = files.find((f) => f.path === path);
    if (!file) throw new Error(`fixture is missing ${path}`);
    return file;
  };

  it("preserves the order GitHub returned", () => {
    expect(files.map((f) => f.path)).toEqual([
      "src/review/summary.ts",
      "src/auth/login.ts",
      "test/old.test.ts",
      "src/utils/format.ts",
      "assets/logo.png",
      "package-lock.json",
    ]);
  });

  it("maps an added file", () => {
    expect(byPath("src/review/summary.ts")).toEqual({
      path: "src/review/summary.ts",
      status: "added",
      additions: 3,
      deletions: 0,
      patch: expect.stringContaining("@@ -0,0 +1,3 @@"),
    });
  });

  it("maps a modified file with both additions and deletions", () => {
    const file = byPath("src/auth/login.ts");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it("maps a removed file", () => {
    const file = byPath("test/old.test.ts");
    expect(file.status).toBe("removed");
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(2);
  });

  it("keeps the old path for a rename and has no patch for a pure rename", () => {
    const file = byPath("src/utils/format.ts");
    expect(file.status).toBe("renamed");
    expect(file.previousPath).toBe("src/utils/fmt.ts");
    expect(file.patch).toBeNull();
  });

  it("uses a null patch for binary files", () => {
    expect(byPath("assets/logo.png").patch).toBeNull();
  });

  it("uses a null patch but keeps counts when GitHub omits an oversized diff", () => {
    const file = byPath("package-lock.json");
    expect(file.patch).toBeNull();
    expect(file.additions).toBe(4200);
    expect(file.deletions).toBe(3100);
  });

  it("drops fields we don't use", () => {
    expect(Object.keys(byPath("src/review/summary.ts")).sort()).toEqual([
      "additions",
      "deletions",
      "patch",
      "path",
      "status",
    ]);
  });

  it("falls back to 'changed' for an unknown status", () => {
    const [file] = parseChangedFiles([
      { filename: "a.ts", status: "teleported", additions: 1, deletions: 0 },
    ]);
    expect(file?.status).toBe("changed");
  });

  it("throws on malformed data", () => {
    expect(() => parseChangedFiles([{ status: "added", additions: 1, deletions: 0 }])).toThrow();
    expect(() =>
      parseChangedFiles([{ filename: "a.ts", status: "added", additions: -1, deletions: 0 }]),
    ).toThrow();
  });

  it("returns an empty list for an empty page", () => {
    expect(parseChangedFiles([])).toEqual([]);
  });
});
