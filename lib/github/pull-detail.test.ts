import "../../tests/support/server-only.mjs";
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { GitHubAccessError } from "./user-access-error";

mock.module(new URL("./user-access.ts", import.meta.url).href, {
  namedExports: {
    githubRepositoryReadCredential: async (userId: string, key: string) => {
      assert.equal(userId, "owner");
      assert.equal(key, "v2/github.com/owner/repo");
      return { token: "test-private-token", repository: { id: "91", fullName: "Owner/Repo" } };
    },
    GitHubAccessError,
  },
});
const sha = "a".repeat(40);
let body: () => unknown;
let variables: Record<string, unknown> = {};
let lastQuery = "";
mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
  const sent = JSON.parse(String(init?.body));
  assert.ok(sent.query.startsWith("query PullDetail("));
  assert.ok(!sent.query.includes("mutation"));
  lastQuery = sent.query;
  variables = sent.variables;
  return Response.json(body());
});
const pull = () => ({
  number: 7, title: "A PR", bodyText: "Body", state: "OPEN", isDraft: false,
  createdAt: "2026-11-17T00:00:00Z", updatedAt: "2026-11-18T00:00:00Z",
  additions: 3, deletions: 1, changedFiles: 2, headRefName: "fix", baseRefName: "main", headRefOid: sha,
  mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
  author: { login: "dana", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
  labels: { nodes: [{ name: "ui" }] },
  commits: { nodes: [{ commit: { oid: sha, statusCheckRollup: { state: "FAILURE", contexts: { pageInfo: { hasNextPage: true }, nodes: [
    { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/x" },
    { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
    { __typename: "StatusContext", context: "deploy", state: "SUCCESS", targetUrl: null },
    { __typename: "SomethingNew" },
  ] } } } }] },
  reviews: { nodes: [{ author: { login: "alex" }, state: "APPROVED", submittedAt: "2026-11-18T00:00:00Z" }] },
});
const response = (pr: unknown, databaseId = 91) => ({ data: { repository: { databaseId, nameWithOwner: "Owner/Repo", pullRequest: pr } } });
const { readPullDetail } = await import("./pull-detail");
const read = () => readPullDetail("owner", "owner/repo", 7, { deadline: Date.now() + 25_000 });
beforeEach(() => { body = () => response(pull()); });

test("one PR reads its summary, its current head's checks and its reviews, with or without a task", async () => {
  const detail = await read();
  assert.deepEqual(variables, { owner: "Owner", name: "Repo", number: 7 });
  assert.equal(detail.url, "https://github.com/Owner/Repo/pull/7");
  assert.equal(detail.headSha, sha);
  assert.equal(detail.head, "fix");
  assert.deepEqual(detail.checkRuns.map((check) => [check.name, check.state]), [["unit", "failure"], ["lint", "pending"], ["deploy", "success"]]);
  assert.equal(detail.moreChecks, true);
  assert.deepEqual(detail.reviews, [{ author: "alex", state: "APPROVED", submittedAt: "2026-11-18T00:00:00Z" }]);
  assert.ok(!JSON.stringify(detail).includes("test-private-token"));
});

test("checks of an older head are not reported as this head's", async () => {
  body = () => {
    const pr = pull();
    pr.commits.nodes[0].commit.oid = "b".repeat(40);
    return response(pr);
  };
  const detail = await read();
  assert.deepEqual(detail.checkRuns, []);
  assert.equal(detail.checks, null);
});

test("another repository's identity or a missing PR is refused, never read", async () => {
  body = () => response(pull(), 92);
  await assert.rejects(read(), { message: "githubRepositoryForbidden" });
  body = () => response(null);
  await assert.rejects(read(), { message: "githubPullRequestInvalid" });
  body = () => ({ ...response(pull()), errors: [{ message: "private" }] });
  await assert.rejects(read(), { message: "githubUnavailable" });
});

test("commits and review threads are included when GitHub reports them", async () => {
  body = () =>
    response({
      ...pull(),
      commitList: {
        totalCount: 3,
        nodes: [
          {
            commit: {
              oid: sha,
              abbreviatedOid: "aaaaaaa",
              messageHeadline: "feat: align PR sidebar",
              committedDate: "2026-11-18T00:00:00Z",
              url: "https://github.com/Owner/Repo/commit/" + sha,
              author: { name: "Alex", user: { login: "alexj11324" } },
            },
          },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            path: "web/components/workspace/pull-preview.tsx",
            line: 42,
            comments: {
              nodes: [
                {
                  id: "c1",
                  bodyText: "Please keep the commit selector visible.",
                  createdAt: "2026-11-18T01:00:00Z",
                  author: { login: "reviewer" },
                },
              ],
            },
          },
        ],
      },
    });
  const detail = await read();
  assert.ok(lastQuery.includes("commitList: commits(last: 25)"));
  assert.ok(lastQuery.includes("reviewThreads(first: 30)"));
  assert.equal(detail.commitCount, 3);
  assert.equal(detail.commits?.[0]?.shortOid, "aaaaaaa");
  assert.equal(detail.commits?.[0]?.author, "alexj11324");
  assert.equal(detail.comments?.length, 1);
  assert.equal(detail.comments?.[0]?.path, "web/components/workspace/pull-preview.tsx");
  assert.equal(detail.comments?.[0]?.resolved, false);
});

test("long review paths and malformed supplemental commit data never break PR reads", async () => {
  const longPath = "nested/".repeat(144) + "file.ts";
  assert.ok(longPath.length > 1000 && longPath.length <= 1024);
  body = () =>
    response({
      ...pull(),
      commitList: { totalCount: "bad" },
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            path: longPath,
            line: 10,
            comments: {
              nodes: [
                {
                  id: "c-long",
                  bodyText: "Looks good",
                  createdAt: "2026-11-18T01:00:00Z",
                  author: { login: "reviewer" },
                },
              ],
            },
          },
        ],
      },
    });
  const detail = await read();
  assert.equal(detail.headSha, sha);
  assert.equal(detail.commits, undefined);
  assert.equal(detail.comments?.[0]?.path, longPath);
});
