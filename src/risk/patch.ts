export interface AddedLine {
  /** 1-indexed line number in the NEW version of the file. */
  line: number;
  text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Extracts the lines a unified diff ADDS, with their line numbers in the new file.
 * Removed lines are ignored (they no longer exist), and a leftover secret on a context
 * line was not introduced by this PR, so it is ignored too.
 *
 * GitHub's `patch` field has no ---/+++ file headers, only hunks.
 */
export function addedLines(patch: string): AddedLine[] {
  const added: AddedLine[] = [];
  let newLine = 0;
  let inHunk = false;

  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (raw.startsWith("+")) {
      added.push({ line: newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // Removed line, or "\ No newline at end of file": neither exists in the new file.
    } else {
      newLine++; // context line
    }
  }
  return added;
}
