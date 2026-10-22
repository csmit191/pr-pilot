import { describe, expect, it } from "vitest";
import { cell, code, inline, sanitizeText, truncate } from "../src/comment/sanitize.js";
import { MARKER } from "../src/comment/render.js";

const ZWSP = "\u200b";

describe("truncate", () => {
  it("leaves short text alone and cuts long text with an ellipsis", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcde", 5)).toBe("abcde");
    expect(truncate("abcdef", 5)).toBe("abcd…");
  });
});

describe("sanitizeText", () => {
  it("leaves ordinary prose untouched", () => {
    const text = "Adds retry logic to PaymentClient. Handles timeouts (3s) and `backoff`.";
    expect(sanitizeText(text)).toBe(text);
  });

  it("escapes '<', so HTML and the hidden marker can't be injected", () => {
    const out = sanitizeText(`${MARKER} <script>alert(1)</script> <details open>`);
    expect(out).not.toContain("<");
    expect(out).not.toContain(MARKER);
    expect(out).toContain("&lt;!-- pr-pilot:review -->");
  });

  it("defuses @mentions of users, teams and groups without changing how they look", () => {
    const out = sanitizeText("cc @octocat @acme/platform @everyone, mail a@b.com");
    expect(out).not.toMatch(/@[A-Za-z0-9_]/);
    expect(out.replaceAll(ZWSP, "")).toBe("cc @octocat @acme/platform @everyone, mail a@b.com");
  });

  it("defuses #123 cross-references", () => {
    const out = sanitizeText("Fixes #123 and org/repo#9");
    expect(out).not.toMatch(/#\d/);
    expect(out.replaceAll(ZWSP, "")).toBe("Fixes #123 and org/repo#9");
  });

  it("breaks images, inline links and link definitions", () => {
    const out = sanitizeText("![x](https://evil.test/p.png) [click](https://evil.test)\n[ref]: https://evil.test");
    expect(out).toContain("!\\[x\\](");
    expect(out).toContain("[click\\](");
    expect(out).toContain("\\[ref]:");
    expect(out).not.toMatch(/(?<!\\)\]\(/);
    expect(out).not.toMatch(/(?<!\\)!\[/);
  });

  it("shortens code fences so they can't swallow the rest of the comment", () => {
    const out = sanitizeText("```js\nalert(1)\n```\n~~~\nx\n~~~\n````");
    expect(out).not.toContain("```");
    expect(out).not.toContain("~~~");
  });

  it("normalizes Windows line endings", () => {
    expect(sanitizeText("a\r\nb\rc")).toBe("a\nb\nc");
  });
});

describe("inline", () => {
  it("collapses whitespace and newlines into one line", () => {
    expect(inline("  a\n\n  b \t c  ")).toBe("a b c");
  });

  it("truncates before sanitizing and sanitizes what is left", () => {
    expect(inline("x".repeat(50), 10)).toBe("xxxxxxxxx…");
    expect(inline("<b>")).toBe("&lt;b>");
  });
});

describe("cell", () => {
  it("is a single line and escapes the column separator", () => {
    const out = cell("a | b\nc");
    expect(out).toBe("a \\| b c");
    expect(out).not.toContain("\n");
  });
});

describe("code", () => {
  it("wraps text in a code span", () => {
    expect(code("src/a.ts:12")).toBe("`src/a.ts:12`");
  });

  it("shows mentions literally without notifying anyone", () => {
    expect(code("@alice")).toBe("`@alice`");
  });

  it("can't be broken out of: backticks, pipes and newlines are neutralized", () => {
    const out = code("a`b|c\nd");
    expect(out).toBe("`a'b\\|c d`");
  });

  it("never lets '<' through, so untrusted text can't put a copy of the marker into the comment", () => {
    const out = code(`src/${MARKER}.ts`);
    expect(out).not.toContain("<");
    expect(out).not.toContain(MARKER);
    expect(out).toBe("`src/\u2039!-- pr-pilot:review -->.ts`");
  });

  it("truncates very long paths", () => {
    expect(code("p".repeat(500)).length).toBe(200 + 2);
  });
});
