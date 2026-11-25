import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { pullReviewDependencies, requestPullChanges, type PullReviewDependencies } from "./pull-review";
import { GitHubAccessError } from "./user-access";
import type { PullDetail, PullReviewEvent } from "../pull-directory";

const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sampleDetail(overrides: Partial<PullDetail> = {}): PullDetail {
  return {
    url: "https://github.com/Owner/Repo/pull/12",
    title: "Add native PR screen",
    state: "open",
    repo: "Owner/Repo",
    number: 12,
    author: "octocat",
    authorAvatar: null,
    updatedAt: "2026-11-25T01:00:00Z",
    createdAt: "2026-11-25T00:00:00Z",
    body: "",
    head: "feat/pr",
    base: "main",
    headSha: HEAD_SHA,
    checks: "SUCCESS",
    mergeState: "CLEAN",
    reviewDecision: null,
    labels: [],
    changedFiles: 1,
    mergeable: "MERGEABLE",
    checkRuns: [],
    moreChecks: false,
    reviews: [],
    ...overrides,
  };
}

test("requestPullChanges forwards default REQUEST_CHANGES, APPROVE (head-pinned), and COMMENT events cleanly", async () => {
  const recorded: Array<{ repo: string; number: number; headSha: string | null; body: string; event: PullReviewEvent }> = [];
  const deps: PullReviewDependencies = {
    detail: async () => sampleDetail(),
    userToken: async () => "user-token",
    review: async (_token, repo, number, headSha, body, event) => {
      recorded.push({ repo, number, headSha, body, event });
      return 100 + recorded.length;
    },
  };

  assert.deepEqual(
    await requestPullChanges("u1", { repo: "Owner/Repo", number: 12, body: "Fix edge case" }, deps),
    { kind: "submitted", id: 101 },
  );
  assert.deepEqual(
    await requestPullChanges("u1", { repo: "Owner/Repo", number: 12, event: "APPROVE", expectedHeadSha: HEAD_SHA }, deps),
    { kind: "submitted", id: 102 },
  );
  assert.deepEqual(
    await requestPullChanges("u1", { repo: "Owner/Repo", number: 12, event: "COMMENT", body: "Looks nice" }, deps),
    { kind: "submitted", id: 103 },
  );

  assert.deepEqual(recorded, [
    { repo: "Owner/Repo", number: 12, headSha: HEAD_SHA, body: "Fix edge case", event: "REQUEST_CHANGES" },
    { repo: "Owner/Repo", number: 12, headSha: HEAD_SHA, body: "", event: "APPROVE" },
    { repo: "Owner/Repo", number: 12, headSha: HEAD_SHA, body: "Looks nice", event: "COMMENT" },
  ]);
});

test("requestPullChanges refuses when head commit moved after diff was loaded, PR is closed, or user token missing", async () => {
  let reviewCalled = false;
  const movedDeps: PullReviewDependencies = {
    detail: async () => sampleDetail({ headSha: OTHER_SHA }),
    userToken: async () => "user-token",
    review: async () => { reviewCalled = true; return 1; },
  };
  assert.deepEqual(
    await requestPullChanges("u1", { repo: "Owner/Repo", number: 12, event: "APPROVE", expectedHeadSha: HEAD_SHA }, movedDeps),
    { kind: "refused", code: "githubReviewHeadMoved" },
  );
  assert.equal(reviewCalled, false);

  const closedDeps: PullReviewDependencies = {
    detail: async () => sampleDetail({ state: "merged" }),
    userToken: async () => "unused",
    review: async () => 1,
  };
  assert.deepEqual(
    await requestPullChanges("u1", { repo: "Owner/Repo", number: 12, event: "APPROVE", expectedHeadSha: HEAD_SHA }, closedDeps),
    { kind: "refused", code: "githubReviewClosed" },
  );

  const noTokenDeps: PullReviewDependencies = {
    detail: async () => sampleDetail(),
    userToken: async () => { throw new GitHubAccessError("githubNotConnected", 401); },
    review: async () => 1,
  };
  assert.deepEqual(
    await requestPullChanges("u1", { repo: "Owner/Repo", number: 12, event: "APPROVE", expectedHeadSha: HEAD_SHA }, noTokenDeps),
    { kind: "refused", code: "githubReviewAuthorizationRequired" },
  );
});

test("pullReviewDependencies sends exact GitHub review payload and maps 422/403 refusals", async () => {
  const sentBodies: unknown[] = [];
  let nextStatus = 200;
  let nextJson: unknown = { id: 555 };
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sentBodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(nextJson), { status: nextStatus, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const deps = pullReviewDependencies({ deadline: Date.now() + 10_000, signal: new AbortController().signal });
  assert.equal(await deps.review("tok", "Owner/Repo", 12, HEAD_SHA, "", "APPROVE"), 555);
  assert.equal(await deps.review("tok", "Owner/Repo", 12, HEAD_SHA, "Nitpick", "COMMENT"), 555);
  assert.deepEqual(sentBodies, [
    { event: "APPROVE", commit_id: HEAD_SHA },
    { event: "COMMENT", body: "Nitpick", commit_id: HEAD_SHA },
  ]);

  nextStatus = 422;
  nextJson = { message: "Can not approve your own pull request" };
  const selfRes = await requestPullChanges(
    "u1",
    { repo: "Owner/Repo", number: 12, event: "APPROVE", expectedHeadSha: HEAD_SHA },
    { ...deps, detail: async () => sampleDetail(), userToken: async () => "tok" },
  );
  assert.deepEqual(selfRes, { kind: "refused", code: "githubReviewSelf" });

  nextStatus = 403;
  nextJson = { message: "Forbidden" };
  const forbiddenRes = await requestPullChanges(
    "u1",
    { repo: "Owner/Repo", number: 12, event: "COMMENT", body: "hi" },
    { ...deps, detail: async () => sampleDetail(), userToken: async () => "tok" },
  );
  assert.deepEqual(forbiddenRes, { kind: "refused", code: "githubReviewForbidden" });
});
