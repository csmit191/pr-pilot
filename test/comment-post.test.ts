import { describe, expect, it, vi } from "vitest";
import type { ExistingComment } from "../src/comment/existing.js";
import { findOurComment, upsertReviewComment, type PostTarget } from "../src/comment/post.js";
import { MARKER } from "../src/comment/render.js";
import type { GithubClient } from "../src/github.js";

const APP_ID = 123;
const target: PostTarget = { installationId: 99, owner: "acme", repo: "widgets", pullNumber: 7, appId: APP_ID };

const ours = (id: number, body = `${MARKER}\nold review`): ExistingComment => ({ id, body, appId: APP_ID });
const person = (id: number, body: string): ExistingComment => ({ id, body, appId: null });
const filler = (n: number): ExistingComment[] => Array.from({ length: n }, (_, i) => person(1000 + i, "lgtm"));

function makeDeps(pages: ExistingComment[][] = [[]]) {
  return {
    listIssueCommentsPage: vi.fn<GithubClient["listIssueCommentsPage"]>(
      async (_installationId, _owner, _repo, _issue, page) => pages[page - 1] ?? [],
    ),
    createIssueComment: vi.fn<GithubClient["createIssueComment"]>(async () => 900),
    updateIssueComment: vi.fn<GithubClient["updateIssueComment"]>(async () => undefined),
  };
}

describe("findOurComment", () => {
  it("finds a comment with the marker that our app posted", async () => {
    const deps = makeDeps([[person(1, "hi"), ours(2)]]);
    expect(await findOurComment(target, deps)).toEqual(ours(2));
  });

  it("ignores a marker pasted into somebody else's comment", async () => {
    const forged = person(1, `${MARKER}\nI am totally the bot`);
    expect(await findOurComment(target, makeDeps([[forged]]))).toBeNull();
  });

  it("ignores comments from other GitHub Apps, even with the marker", async () => {
    const other: ExistingComment = { id: 1, body: `${MARKER}\nimposter`, appId: 999 };
    expect(await findOurComment(target, makeDeps([[other]]))).toBeNull();
  });

  it("ignores our app's comments that lack the marker, or only mention it later in the text", async () => {
    const unmarked: ExistingComment = { id: 1, body: "something else", appId: APP_ID };
    const quoting: ExistingComment = { id: 2, body: `quoting ${MARKER} mid-text`, appId: APP_ID };
    expect(await findOurComment(target, makeDeps([[unmarked, quoting]]))).toBeNull();
  });

  it("tolerates leading whitespace before the marker", async () => {
    const padded = ours(3, `\n  ${MARKER}\nbody`);
    expect(await findOurComment(target, makeDeps([[padded]]))).toEqual(padded);
  });

  it("walks through pages until it finds the comment", async () => {
    const deps = makeDeps([filler(100), [ours(2)]]);
    expect(await findOurComment(target, deps)).toEqual(ours(2));
    expect(deps.listIssueCommentsPage.mock.calls.map((c) => [c[4], c[5]])).toEqual([[1, 100], [2, 100]]);
    expect(deps.listIssueCommentsPage).toHaveBeenCalledWith(99, "acme", "widgets", 7, 1, 100);
  });

  it("stops after a short page", async () => {
    const deps = makeDeps([filler(3), [ours(2)]]);
    expect(await findOurComment(target, deps)).toBeNull();
    expect(deps.listIssueCommentsPage).toHaveBeenCalledTimes(1);
  });

  it("gives up after 10 pages", async () => {
    const deps = makeDeps(Array.from({ length: 20 }, () => filler(100)));
    expect(await findOurComment(target, deps)).toBeNull();
    expect(deps.listIssueCommentsPage).toHaveBeenCalledTimes(10);
  });
});

describe("upsertReviewComment", () => {
  const body = `${MARKER}\n## new review\n`;

  it("creates a comment when there is none", async () => {
    const deps = makeDeps();
    expect(await upsertReviewComment(target, body, deps)).toEqual({ action: "created", commentId: 900 });
    expect(deps.createIssueComment).toHaveBeenCalledWith(99, "acme", "widgets", 7, body);
    expect(deps.updateIssueComment).toHaveBeenCalledTimes(0);
  });

  it("edits our existing comment instead of posting a second one", async () => {
    const deps = makeDeps([[person(1, "hi"), ours(42)]]);
    expect(await upsertReviewComment(target, body, deps)).toEqual({ action: "updated", commentId: 42 });
    expect(deps.updateIssueComment).toHaveBeenCalledWith(99, "acme", "widgets", 42, body);
    expect(deps.createIssueComment).toHaveBeenCalledTimes(0);
  });

  it("leaves the comment alone when nothing changed (no pointless 'edited' marker)", async () => {
    const deps = makeDeps([[ours(42, body.replace(/\n/g, "\r\n") + "  \n")]]);
    expect(await upsertReviewComment(target, body, deps)).toEqual({ action: "unchanged", commentId: 42 });
    expect(deps.updateIssueComment).toHaveBeenCalledTimes(0);
    expect(deps.createIssueComment).toHaveBeenCalledTimes(0);
  });

  it("never edits a lookalike comment from someone else; it posts its own", async () => {
    const deps = makeDeps([[person(5, `${MARKER}\nforged`)]]);
    expect((await upsertReviewComment(target, body, deps)).action).toBe("created");
    expect(deps.updateIssueComment).toHaveBeenCalledTimes(0);
  });

  it("posts a fresh comment if ours was deleted between listing and editing", async () => {
    const deps = makeDeps([[ours(42)]]);
    deps.updateIssueComment.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    expect(await upsertReviewComment(target, body, deps)).toEqual({ action: "created", commentId: 900 });
  });

  it.each([403, 500])("propagates a %s from editing instead of hiding it", async (status) => {
    const deps = makeDeps([[ours(42)]]);
    deps.updateIssueComment.mockRejectedValue(Object.assign(new Error("nope"), { status }));
    await expect(upsertReviewComment(target, body, deps)).rejects.toThrow("nope");
    expect(deps.createIssueComment).toHaveBeenCalledTimes(0);
  });

  it("propagates failures to create and to list", async () => {
    const createFails = makeDeps();
    createFails.createIssueComment.mockRejectedValue(new Error("create failed"));
    await expect(upsertReviewComment(target, body, createFails)).rejects.toThrow("create failed");

    const listFails = makeDeps();
    listFails.listIssueCommentsPage.mockRejectedValue(new Error("list failed"));
    await expect(upsertReviewComment(target, body, listFails)).rejects.toThrow("list failed");
  });
});
