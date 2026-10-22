import { describe, expect, it } from "vitest";
import { ownersOf, parseCodeowners, patternToRegExp } from "../src/reviewers/codeowners.js";

const handles = (text: string, path: string) => ownersOf(parseCodeowners(text), path).map((o) => o.handle);

describe("patternToRegExp: which paths a pattern matches (GitHub's documented semantics)", () => {
  const cases: Array<[pattern: string, path: string, matches: boolean]> = [
    // a lone * matches everything, at any depth
    ["*", "a.txt", true],
    ["*", "src/deep/a.txt", true],
    // extension globs match at any depth
    ["*.js", "a.js", true],
    ["*.js", "src/a.js", true],
    ["*.js", "a.jsx", false],
    // "apps/" = any directory named apps, anywhere
    ["apps/", "apps/a.ts", true],
    ["apps/", "src/apps/b.ts", true],
    ["apps/", "myapps/x.ts", false],
    ["apps/", "apps.ts", false],
    // "/docs/" = the root docs directory and everything under it
    ["/docs/", "docs/a.md", true],
    ["/docs/", "docs/x/y.md", true],
    ["/docs/", "src/docs/a.md", false],
    // "/docs" without a trailing slash = the file or directory at the root
    ["/docs", "docs", true],
    ["/docs", "docs/a.md", true],
    ["/docs", "src/docs/a.md", false],
    // "docs/*" = files directly inside docs/, NOT nested ones (GitHub differs from .gitignore here)
    ["docs/*", "docs/getting-started.md", true],
    ["docs/*", "docs/build-app/troubleshooting.md", false],
    ["docs/*", "src/docs/a.md", false],
    // "**/logs" = a logs directory at any depth
    ["**/logs", "logs/a.txt", true],
    ["**/logs", "build/logs/a.txt", true],
    ["**/logs", "deeply/nested/logs/a.txt", true],
    ["**/logs", "mylogs/a.txt", false],
    ["/build/logs/", "build/logs/a.log", true],
    ["/build/logs/", "build/logs/x/a.log", true],
    ["/build/logs/", "src/build/logs/a.log", false],
    // "**" inside and at the end of a pattern
    ["docs/**", "docs/a.md", true],
    ["docs/**", "docs/x/y.md", true],
    ["docs/**", "docs", false],
    ["src/**/test.js", "src/test.js", true],
    ["src/**/test.js", "src/a/b/test.js", true],
    ["src/**/test.js", "other/test.js", false],
    // single-character wildcard
    ["/file?.txt", "file1.txt", true],
    ["/file?.txt", "file12.txt", false],
    ["/file?.txt", "a/file1.txt", false],
    // regex-special characters are literal
    ["/docs/a+b.md", "docs/a+b.md", true],
    ["/docs/a.b.md", "docs/axb.md", false],
    // a plain anchored path matches the file or the directory and its contents
    ["/apps/github", "apps/github", true],
    ["/apps/github", "apps/github/x.ts", true],
    ["/apps/github", "apps/githubby/x.ts", false],
    // paths are case sensitive
    ["/Docs/", "docs/a.md", false],
  ];

  it.each(cases)("%s vs %s -> %s", (pattern, path, expected) => {
    const regex = patternToRegExp(pattern);
    expect(regex).not.toBeNull();
    expect(regex?.test(path)).toBe(expected);
  });

  it("rejects syntax GitHub doesn't support, plus empty and oversized patterns", () => {
    expect(patternToRegExp("!*.md")).toBeNull(); // negation
    expect(patternToRegExp("[ab].js")).toBeNull(); // character ranges
    expect(patternToRegExp("\\#file")).toBeNull(); // backslash escapes
    expect(patternToRegExp("/")).toBeNull();
    expect(patternToRegExp("")).toBeNull();
    expect(patternToRegExp("a".repeat(300))).toBeNull();
  });
});

describe("parseCodeowners", () => {
  it("skips comments and blank lines, including inline comments, and records line numbers", () => {
    const rules = parseCodeowners(
      ["# a comment", "", "*       @global", "*.js    @js-owner #This is an inline comment.", "   # indented comment"].join("\n"),
    );
    expect(rules.map((r) => r.pattern)).toEqual(["*", "*.js"]);
    expect(rules.map((r) => r.line)).toEqual([3, 4]);
    expect(rules[1]?.owners).toEqual([{ kind: "user", handle: "js-owner" }]);
  });

  it("recognizes users, teams and email addresses", () => {
    const [team, email, user] = parseCodeowners(
      ["*.txt @octo-org/octocats", "*.go docs@example.com", "* @alice"].join("\n"),
    );
    expect(team?.owners).toEqual([{ kind: "team", handle: "octo-org/octocats" }]);
    expect(email?.owners).toEqual([{ kind: "email", handle: "docs@example.com" }]);
    expect(user?.owners).toEqual([{ kind: "user", handle: "alice" }]);
  });

  it("allows several owners on one line, and tabs as separators", () => {
    const [rule] = parseCodeowners("/scripts/\t@doctocat   @octocat\t@octo-org/team");
    expect(rule?.owners.map((o) => o.handle)).toEqual(["doctocat", "octocat", "octo-org/team"]);
  });

  it("skips a whole line when any owner is invalid, like GitHub does", () => {
    const rules = parseCodeowners(["*.a not-an-owner", "*.b @ok @@bad", "*.c @ok", "*.d @-bad-"].join("\n"));
    expect(rules.map((r) => r.pattern)).toEqual(["*.c"]);
  });

  it("skips lines using unsupported pattern syntax", () => {
    const text = ["!*.md @x", "[ab].js @x", "\\#file @x", "[section]", "*.ok @x"].join("\n");
    expect(parseCodeowners(text).map((r) => r.pattern)).toEqual(["*.ok"]);
  });

  it("keeps a pattern with no owners (it means 'explicitly unowned')", () => {
    const [rule] = parseCodeowners("/apps/github");
    expect(rule?.owners).toEqual([]);
  });

  it("handles Windows line endings", () => {
    const rules = parseCodeowners("*.js @a\r\n*.ts @b\r\n");
    expect(rules.map((r) => r.owners[0]?.handle)).toEqual(["a", "b"]);
  });

  it("ignores a CODEOWNERS file that is unreasonably large", () => {
    expect(parseCodeowners("* @a\n" + "# filler\n".repeat(80_000))).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCodeowners("")).toEqual([]);
  });
});

describe("ownersOf", () => {
  const text = [
    "*          @global-owner",
    "*.js       @js-owner",
    "/apps/     @octocat",
    "/apps/github",
    "/docs/     @doctocat @docs-team",
  ].join("\n");

  it("uses the last matching rule, so specific rules override the global owner", () => {
    expect(handles(text, "README.md")).toEqual(["global-owner"]);
    expect(handles(text, "src/a.js")).toEqual(["js-owner"]);
    expect(handles(text, "docs/guide.md")).toEqual(["doctocat", "docs-team"]);
  });

  it("treats a later rule with no owners as 'unowned'", () => {
    expect(handles(text, "apps/other/x.ts")).toEqual(["octocat"]);
    expect(handles(text, "apps/github/x.ts")).toEqual([]);
  });

  it("returns nothing when no rule matches or there are no rules", () => {
    expect(handles("/only/here/ @a", "elsewhere.ts")).toEqual([]);
    expect(ownersOf([], "a.ts")).toEqual([]);
  });
});
