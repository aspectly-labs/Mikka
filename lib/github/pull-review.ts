import "server-only";
import { githubTokenForUser, GitHubAccessError } from "./user-access";
import { readPullDetail } from "./pull-detail";
import type { RequestBudget } from "../request-budget";
import {
  pullReviewInput,
  type PullDetail,
  type PullReviewEvent,
  type PullReviewInput,
  type PullReviewResult,
} from "../pull-directory";

export type PullReviewDependencies = {
  /** The admitted-repository read: the same gate as the directory and the PR page. */
  detail: (userId: string, repo: string, number: number) => Promise<PullDetail>;
  /** The person's own GitHub user-to-server token: reviews post as them, never as an app. */
  userToken: (userId: string) => Promise<string>;
  review: (
    token: string,
    repo: string,
    number: number,
    headSha: string | null,
    body: string,
    event: PullReviewEvent,
  ) => Promise<number | null>;
};

export function pullReviewDependencies(budget: RequestBudget): PullReviewDependencies {
  return {
    detail: (userId, repo, number) => readPullDetail(userId, repo, number, budget),
    userToken: async (userId) => (await githubTokenForUser(userId, { budget })).token,
    review: async (token, repo, number, headSha, body, event) => {
      const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/reviews`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        // commit_id binds the review to the head the reader saw — a later push
        // must not catch feedback written against an older diff.
        body: JSON.stringify({ event, ...(body ? { body } : {}), ...(headSha ? { commit_id: headSha } : {}) }),
        signal: budget.signal,
      });
      if (response.status === 422) {
        const payload = (await response.json().catch(() => null)) as { message?: string; errors?: { message?: string }[] } | null;
        const text = `${payload?.message ?? ""} ${(payload?.errors ?? []).map(e => e.message ?? "").join(" ")}`;
        throw new ReviewRefused(/own pull request/i.test(text) ? "githubReviewSelf" : "githubReviewRefused");
      }
      if (response.status === 403) throw new ReviewRefused("githubReviewForbidden");
      if (!response.ok) throw new GitHubAccessError("githubUnavailable", 502);
      const review = (await response.json()) as { id?: number };
      return typeof review.id === "number" ? review.id : null;
    },
  };
}

class ReviewRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The thread PR tab's Request changes (#2929): a review submitted as the person. */
export async function requestPullChanges(
  userId: string,
  raw: PullReviewInput,
  deps: PullReviewDependencies,
): Promise<PullReviewResult> {
  const input = pullReviewInput.parse(raw);
  const detail = await deps.detail(userId, input.repo, input.number);
  if (detail.state !== "open" && detail.state !== "draft")
    return { kind: "refused", code: "githubReviewClosed" };
  if (input.expectedHeadSha && detail.headSha?.toLowerCase() !== input.expectedHeadSha)
    return { kind: "refused", code: "githubReviewHeadMoved" };
  let token: string;
  try {
    token = await deps.userToken(userId);
  } catch (error) {
    if (error instanceof GitHubAccessError)
      return { kind: "refused", code: "githubReviewAuthorizationRequired" };
    throw error;
  }
  const commitSha = input.expectedHeadSha ?? detail.headSha;
  try {
    return { kind: "submitted", id: await deps.review(token, detail.repo, input.number, commitSha, input.body, input.event) };
  } catch (error) {
    if (error instanceof ReviewRefused) return { kind: "refused", code: error.code };
    throw error;
  }
}
