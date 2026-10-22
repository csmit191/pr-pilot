export type OwnerKind = "user" | "team" | "email";

export interface Owner {
  kind: OwnerKind;
  /** Without the leading "@": "alice", "acme/platform" or "dev@example.com". */
  handle: string;
}

export interface CodeownersRule {
  pattern: string;
  owners: Owner[];
  regex: RegExp;
  /** 1-indexed line in the CODEOWNERS file, handy for debugging. */
  line: number;
}

/** GitHub uses the first of these that exists. */
export const CODEOWNERS_LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

const MAX_PATTERN_LENGTH = 256;
const MAX_FILE_CHARS = 512 * 1024; // GitHub allows 3 MB; we are stricter to keep parsing cheap.

const USER = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const TEAM = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const EMAIL = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/;

function parseOwner(token: string): Owner | null {
  if (TEAM.test(token)) return { kind: "team", handle: token.slice(1) };
  if (USER.test(token)) return { kind: "user", handle: token.slice(1) };
  if (EMAIL.test(token)) return { kind: "email", handle: token };
  return null;
}

function escapeRegex(char: string): string {
  return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Translates the glob characters of one pattern into regex source. */
function translate(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "*") {
      if (pattern.charAt(i + 1) === "*") {
        const atSegmentStart = i === 0 || pattern.charAt(i - 1) === "/";
        if (atSegmentStart && pattern.charAt(i + 2) === "/") {
          out += "(?:.*/)?"; // "**/" = zero or more directories
          i += 2;
        } else {
          out += ".*"; // trailing "/**", or "**" glued to other text
          i += 1;
        }
      } else {
        out += "[^/]*"; // "*" never crosses a directory boundary
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
}

/**
 * Converts one CODEOWNERS pattern to a regex over repo-relative paths, or null if the pattern
 * uses syntax GitHub doesn't support (negation, [ranges], backslash escapes).
 *
 * Rules (from GitHub's docs, which differ slightly from .gitignore):
 *  - a slash at the start or middle anchors the pattern to the repo root; otherwise it can
 *    match at any depth;
 *  - a trailing slash means "this directory and everything under it";
 *  - "docs/*" matches files directly in docs/, NOT nested ones, while "docs/" and "/docs"
 *    match everything below.
 */
export function patternToRegExp(raw: string): RegExp | null {
  if (raw.length > MAX_PATTERN_LENGTH) return null;
  if (raw.startsWith("!") || /[[\]\\]/.test(raw)) return null;

  const directoryOnly = raw.endsWith("/");
  const withoutTrailingSlash = directoryOnly ? raw.slice(0, -1) : raw;
  const anchored = withoutTrailingSlash.includes("/");
  const pattern = withoutTrailingSlash.replace(/^\//, "");
  if (pattern === "") return null;

  const lastSegment = pattern.slice(pattern.lastIndexOf("/") + 1);
  const hasWildcard = /[*?]/.test(lastSegment);

  let suffix: string;
  if (directoryOnly) suffix = "/.*";
  else if (hasWildcard) suffix = ""; // wildcard in the last segment: that level only
  else suffix = "(?:/.*)?"; // a plain name matches a file, or a directory and its contents

  const prefix = anchored ? "" : "(?:.*/)?";
  return new RegExp(`^${prefix}${translate(pattern)}${suffix}$`);
}

/**
 * Parses CODEOWNERS text. Like GitHub, a line with invalid syntax is skipped (here: an
 * unsupported pattern, or any owner that isn't @user, @org/team or an email).
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  if (text.length > MAX_FILE_CHARS) return [];

  const rules: CodeownersRule[] = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim(); // comments, including inline ones
    if (line === "") return;

    const [pattern, ...tokens] = line.split(/\s+/);
    if (pattern === undefined) return;

    const regex = patternToRegExp(pattern);
    if (regex === null) return;

    const owners: Owner[] = [];
    for (const token of tokens) {
      const owner = parseOwner(token);
      if (owner === null) return; // invalid owner: skip the whole line
      owners.push(owner);
    }
    rules.push({ pattern, owners, regex, line: index + 1 });
  });
  return rules;
}

/** The last matching rule wins. A matching rule with no owners means "explicitly unowned". */
export function ownersOf(rules: readonly CodeownersRule[], path: string): Owner[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule?.regex.test(path)) return rule.owners;
  }
  return [];
}
