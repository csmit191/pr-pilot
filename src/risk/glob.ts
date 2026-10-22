import picomatch from "picomatch";

const compiled = new Map<string, (path: string) => boolean>();

function matcher(pattern: string): (path: string) => boolean {
  let fn = compiled.get(pattern);
  if (!fn) {
    // dot: true so ".github/**" and other dot-directories are matched by ordinary patterns.
    fn = picomatch(pattern, { dot: true });
    compiled.set(pattern, fn);
  }
  return fn;
}

/** Returns the first pattern that matches `path`, or undefined if none do. */
export function firstMatch(patterns: readonly string[], path: string): string | undefined {
  return patterns.find((pattern) => matcher(pattern)(path));
}
