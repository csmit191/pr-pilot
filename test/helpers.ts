import type { ChangedFile } from "../src/diff/types.js";

/** Builds a ChangedFile with harmless defaults; override only what a test cares about. */
export function makeFile(overrides: Partial<ChangedFile> & { path: string }): ChangedFile {
  return { status: "modified", additions: 0, deletions: 0, patch: null, ...overrides };
}

/** A patch that adds `lines` at the top of a new file: line 1 is lines[0]. */
export function addedPatch(...lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
}
