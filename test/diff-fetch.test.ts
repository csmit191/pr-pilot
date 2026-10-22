import { describe, expect, it, vi } from "vitest";
import { MAX_PAGES, PER_PAGE, fetchPullRequestDiff } from "../src/diff/fetch.js";

const fakeFile = (i: number) => ({
  filename: `src/f${i}.ts`,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: "@@ -1 +1 @@",
});

/** A fake GitHub that serves `total` files, honoring page/perPage like the real API. */
function makeSource(total: number) {
  const all = Array.from({ length: total }, (_, i) => fakeFile(i));
  return vi.fn(async (page: number, perPage: number) =>
    all.slice((page - 1) * perPage, page * perPage),
  );
}

describe("fetchPullRequestDiff", () => {
  it("makes one request for a small PR", async () => {
    const source = makeSource(7);
    const diff = await fetchPullRequestDiff(source);
    expect(source).toHaveBeenCalledTimes(1);
    expect(diff.files).toHaveLength(7);
    expect(diff.truncated).toBe(false);
  });

  it("handles a PR with no files", async () => {
    const source = makeSource(0);
    const diff = await fetchPullRequestDiff(source);
    expect(source).toHaveBeenCalledTimes(1);
    expect(diff.files).toEqual([]);
    expect(diff.truncated).toBe(false);
  });

  it("follows pages until a short page: 250 files is 3 requests, in order", async () => {
    const source = makeSource(250);
    const diff = await fetchPullRequestDiff(source);
    expect(source.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
    expect(source.mock.calls.every(([, perPage]) => perPage === PER_PAGE)).toBe(true);
    expect(diff.files).toHaveLength(250);
    expect(diff.files[0]?.path).toBe("src/f0.ts");
    expect(diff.files[249]?.path).toBe("src/f249.ts");
    expect(diff.truncated).toBe(false);
  });

  it("uses one extra request when the file count is an exact multiple of the page size", async () => {
    const source = makeSource(PER_PAGE);
    const diff = await fetchPullRequestDiff(source);
    expect(source).toHaveBeenCalledTimes(2);
    expect(diff.files).toHaveLength(PER_PAGE);
    expect(diff.truncated).toBe(false);
  });

  it("stops at the page cap and reports truncation", async () => {
    const source = makeSource(5000);
    const diff = await fetchPullRequestDiff(source);
    expect(source).toHaveBeenCalledTimes(MAX_PAGES);
    expect(diff.files).toHaveLength(MAX_PAGES * PER_PAGE);
    expect(diff.truncated).toBe(true);
  });

  it("propagates errors from the API instead of returning a partial diff", async () => {
    const source = vi.fn(async (page: number) => {
      if (page === 2) throw new Error("rate limited");
      return Array.from({ length: PER_PAGE }, (_, i) => fakeFile(i));
    });
    await expect(fetchPullRequestDiff(source)).rejects.toThrow("rate limited");
  });
});
