/**
 * Text that ends up in the PR comment comes from untrusted places: the PR author's title and
 * description, file names, and an LLM that has read all of that. Before it goes into markdown we
 * defuse the things an attacker could abuse. These helpers are the only way such text should
 * reach the comment.
 */

const ZERO_WIDTH_SPACE = "\u200b";

/** Truncates to `max` characters, adding an ellipsis if anything was cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Makes multi-line text safe to embed in markdown:
 *  - "<" is escaped, so no HTML, comments (<!-- -->), or autolinks. This also means untrusted
 *    text can never forge the hidden marker that identifies our comment.
 *  - "@name" gets a zero-width space, so it renders the same but notifies nobody.
 *  - "#123" gets one too, so we don't spam cross-reference links into other issues and PRs.
 *  - Images, inline links and link definitions are broken, so text can't hide a link behind
 *    friendly wording.
 *  - Code fences are shortened, so a stray ``` can't swallow the rest of the comment.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/</g, "&lt;")
    .replace(/@(?=[A-Za-z0-9_])/g, `@${ZERO_WIDTH_SPACE}`)
    .replace(/#(?=\d)/g, `#${ZERO_WIDTH_SPACE}`)
    .replace(/!\[/g, "!\\[")
    .replace(/\]\(/g, "\\](")
    .replace(/^\s*\[([^\]\n]+)\]:/gm, "\\[$1]:")
    .replace(/`{3,}/g, "``")
    .replace(/~{3,}/g, "~~");
}

/** One line of sanitized text, for list items and sentences. */
export function inline(text: string, maxLength = 400): string {
  return sanitizeText(truncate(text, maxLength)).replace(/\s+/g, " ").trim();
}

/** Like `inline`, and safe inside a markdown table cell (where "|" would split the column). */
export function cell(text: string, maxLength = 300): string {
  return inline(text, maxLength).replace(/\|/g, "\\|");
}

/**
 * A code span for paths and handles. Markdown shows code spans literally (no mentions, links or
 * HTML), so only three things need care: backticks (would end the span), pipes (would split a
 * table cell) and "<". A raw "<" would be harmless on screen, but we keep the stronger rule that
 * untrusted text never puts "<!--" into the comment, so the hidden marker can't be duplicated.
 */
export function code(text: string, maxLength = 200): string {
  const flat = truncate(text, maxLength)
    .replace(/\s+/g, " ")
    .replace(/`/g, "'")
    .replace(/\|/g, "\\|")
    .replace(/</g, "\u2039"); // ‹ looks like "<" but is not markup
  return `\`${flat}\``;
}
