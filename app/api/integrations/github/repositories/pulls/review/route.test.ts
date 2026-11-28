import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";

const HEAD_SHA = "a".repeat(40);
let owner: string | null = "owner";
let originOk = true;
let result: unknown = { kind: "submitted", id: 77 };
const calls: unknown[][] = [];

const stub = (path: string, namedExports: Record<string, unknown>) =>
  mock.module(new URL(path, import.meta.url).href, { namedExports });

stub("../../../../../../../lib/auth.ts", {
  auth: {
    api: {
      getSession: async () => (owner ? { user: { id: owner }, session: { id: "s1" } } : null),
    },
  },
});
stub("../../../../../../../lib/desktop-rpc/handler.ts", {
  humanSessionHeaders: (request: Request) => request.headers,
});
stub("../../../../../../../lib/mobile-api.ts", {
  writeAllowed: () => originOk,
});
stub("../../../../../../../lib/request-log.ts", {
  noteLogUser: () => {},
  noteLogRpcAction: () => {},
  withRequestLog: (_path: string, handler: unknown) => handler,
});
stub("../../../../../../../lib/github/user-access.ts", {
  GitHubAccessError: class GitHubAccessError extends Error {
    constructor(readonly code: string, readonly status: number) {
      super(code);
    }
  },
});
stub("../../../../../../../lib/github/pull-review.ts", {
  pullReviewDependencies: () => ({}),
  requestPullChanges: async (userId: string, input: unknown) => {
    calls.push([userId, input]);
    return result;
  },
});

let route: typeof import("./route");
before(async () => {
  route = await import("./route");
});
beforeEach(() => {
  owner = "owner";
  originOk = true;
  result = { kind: "submitted", id: 77 };
  calls.length = 0;
});

const post = (payload: unknown) =>
  new Request("https://mikka.example/api/integrations/github/repositories/pulls/review", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(payload),
  });

test("POST /pulls/review submits APPROVE, COMMENT, and legacy REQUEST_CHANGES and maps refusals to 409", async () => {
  const approve = await route.POST(post({ repo: "Owner/Repo", number: 7, event: "APPROVE", expectedHeadSha: HEAD_SHA }));
  assert.equal(approve.status, 200);
  assert.deepEqual(await approve.json(), { kind: "submitted", id: 77 });
  assert.equal(approve.headers.get("cache-control"), "private, no-store");

  const comment = await route.POST(post({ repo: "Owner/Repo", number: 7, event: "COMMENT", body: "Looks clean" }));
  assert.equal(comment.status, 200);

  const legacy = await route.POST(post({ repo: "Owner/Repo", number: 7, body: "Fix lint" }));
  assert.equal(legacy.status, 200);

  assert.deepEqual(calls, [
    ["owner", { repo: "Owner/Repo", number: 7, event: "APPROVE", body: "", expectedHeadSha: HEAD_SHA }],
    ["owner", { repo: "Owner/Repo", number: 7, event: "COMMENT", body: "Looks clean" }],
    ["owner", { repo: "Owner/Repo", number: 7, event: "REQUEST_CHANGES", body: "Fix lint" }],
  ]);

  result = { kind: "refused", code: "githubReviewHeadMoved" };
  const moved = await route.POST(post({ repo: "Owner/Repo", number: 7, event: "APPROVE", expectedHeadSha: HEAD_SHA }));
  assert.equal(moved.status, 409);
  assert.deepEqual(await moved.json(), { kind: "refused", code: "githubReviewHeadMoved" });
});

test("POST /pulls/review enforces auth, origin, and head-SHA/body validation", async () => {
  owner = null;
  assert.equal((await route.POST(post({ repo: "Owner/Repo", number: 7, event: "APPROVE", expectedHeadSha: HEAD_SHA }))).status, 401);
  owner = "owner";
  originOk = false;
  assert.equal((await route.POST(post({ repo: "Owner/Repo", number: 7, event: "APPROVE", expectedHeadSha: HEAD_SHA }))).status, 403);
  originOk = true;
  assert.equal((await route.POST(post({ repo: "Owner/Repo", number: 7, event: "APPROVE" }))).status, 400);
  assert.equal((await route.POST(post({ repo: "Owner/Repo", number: 7, event: "COMMENT", body: "  " }))).status, 400);
  assert.equal(calls.length, 0);
});
