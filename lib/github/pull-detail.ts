import "server-only";
import { z } from "zod";
import {
  githubRepositoryReadCredential,
  GitHubAccessError,
} from "./user-access";
import { githubGraphql } from "./pull-directory";
import type { RequestBudget } from "../request-budget";
import type {
  PullCheck,
  PullCommit,
  PullDetail,
  PullReview,
  PullReviewComment,
} from "../pull-directory";

const query = `query PullDetail($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { databaseId nameWithOwner pullRequest(number: $number) {
    number title bodyText state isDraft createdAt updatedAt additions deletions changedFiles headRefName baseRefName headRefOid
    mergeStateStatus mergeable reviewDecision author { login avatarUrl } labels(first: 100) { nodes { name } }
    commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { pageInfo { hasNextPage } nodes {
      __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl }
    } } } } } }
    commitList: commits(last: 25) { totalCount nodes { commit { oid abbreviatedOid messageHeadline committedDate url author { name user { login } } } } }
    reviews(last: 50) { nodes { author { login } state bodyText submittedAt } }
    reviewThreads(first: 30) { nodes { isResolved path line comments(first: 1) { nodes { id bodyText createdAt author { login } } } } }
  } }
}`;
const date = z.string().datetime({ offset: true });
const link = z.string().url().max(2000).nullable();
const context = z.union([
  z.object({
    __typename: z.literal("CheckRun"),
    name: z.string().max(500),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: link,
  }),
  z.object({
    __typename: z.literal("StatusContext"),
    context: z.string().max(500),
    state: z.string(),
    targetUrl: link,
  }),
]);
const rollup = z.enum(["SUCCESS", "PENDING", "FAILURE", "ERROR", "EXPECTED"]);
const reviewState = z.enum([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
]);
const pull = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1000),
  bodyText: z.string().max(200000),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  createdAt: date,
  updatedAt: date,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  mergeStateStatus: z.string(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  reviewDecision: z.string().nullable(),
  author: z
    .object({ login: z.string(), avatarUrl: z.string().url() })
    .nullable(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })).max(100) }),
  commits: z.object({
    nodes: z
      .array(
        z.object({
          commit: z.object({
            oid: z.string(),
            statusCheckRollup: z
              .object({
                state: rollup,
                contexts: z.object({
                  pageInfo: z.object({ hasNextPage: z.boolean() }),
                  // Unknown context kinds stay out rather than failing the page.
                  nodes: z.array(z.unknown()).max(100),
                }),
              })
              .nullable(),
          }),
        }),
      )
      .max(1),
  }),
  commitList: z
    .object({
      totalCount: z.number().int().nonnegative(),
      nodes: z
        .array(
          z.object({
            commit: z.object({
              oid: z.string(),
              abbreviatedOid: z.string().max(40).optional(),
              messageHeadline: z.string(),
              committedDate: date.nullable().optional(),
              url: link.optional().catch(undefined),
              author: z
                .object({
                  name: z.string().nullable().optional(),
                  user: z.object({ login: z.string() }).nullable().optional(),
                })
                .nullable()
                .optional(),
            }),
          }),
        )
        .max(25),
    })
    .optional()
    .catch(undefined),
  reviews: z.object({
    nodes: z
      .array(
        z.object({
          author: z.object({ login: z.string() }).nullable(),
          state: reviewState,
          bodyText: z.string().optional().catch(undefined),
          submittedAt: date.nullable(),
        }),
      )
      .max(50),
  }),
  reviewThreads: z
    .object({
      nodes: z
        .array(
          z.object({
            isResolved: z.boolean(),
            path: z.string().max(4096).nullable().optional(),
            line: z.number().int().nullable().optional(),
            comments: z.object({
              nodes: z
                .array(
                  z.object({
                    id: z.string().max(256),
                    bodyText: z.string(),
                    createdAt: date.nullable().optional(),
                    author: z.object({ login: z.string() }).nullable(),
                  }),
                )
                .max(10),
            }),
          }),
        )
        .max(30),
    })
    .optional()
    .catch(undefined),
});
const result = z.object({
  data: z.object({
    repository: z.object({
      databaseId: z.number().int().positive(),
      nameWithOwner: z.string(),
      pullRequest: pull.nullable(),
    }),
  }),
});

/** GitHub's check vocabulary in the page's four words. */
export function pullCheckState(
  run: z.infer<typeof context>,
): PullCheck["state"] {
  if (run.__typename === "StatusContext")
    return run.state === "SUCCESS"
      ? "success"
      : run.state === "PENDING" || run.state === "EXPECTED"
        ? "pending"
        : "failure";
  if (run.status !== "COMPLETED") return "pending";
  if (
    run.conclusion === "SUCCESS" ||
    run.conclusion === "NEUTRAL"
  )
    return "success";
  if (run.conclusion === "SKIPPED" || run.conclusion === "STALE")
    return "skipped";
  return "failure";
}

/**
 * One pull request's page: its summary, checks on the current head and reviews. Same
 * admitted repository and credential as the directory (githubRepositoryReadCredential),
 * so a number can never reach another repository's pull request.
 */
export async function readPullDetail(
  userId: string,
  repo: string,
  number: number,
  budget: RequestBudget,
): Promise<PullDetail> {
  const access = await githubRepositoryReadCredential(
    userId,
    "v2/github.com/" + repo.toLowerCase(),
    budget,
  );
  const [owner, name] = access.repository.fullName.split("/");
  const parsed = result.safeParse(
    await githubGraphql(access.token, budget, query, { owner, name, number }),
  );
  if (!parsed.success) throw new GitHubAccessError("githubUnavailable", 502);
  const repository = parsed.data.data.repository;
  if (
    String(repository.databaseId) !== access.repository.id ||
    repository.nameWithOwner.toLowerCase() !==
      access.repository.fullName.toLowerCase()
  )
    throw new GitHubAccessError("githubRepositoryForbidden", 403);
  const row = repository.pullRequest;
  if (!row || row.number !== number)
    throw new GitHubAccessError("githubPullRequestInvalid", 404);
  const commit = row.commits.nodes[0]?.commit;
  const current = commit?.oid === row.headRefOid ? commit : undefined;
  const checkRuns = (current?.statusCheckRollup?.contexts.nodes ?? []).flatMap(
    (raw): PullCheck[] => {
      const item = context.safeParse(raw);
      if (!item.success) return [];
      const run = item.data;
      return [
        {
          name: run.__typename === "CheckRun" ? run.name : run.context,
          state: pullCheckState(run),
          url: run.__typename === "CheckRun" ? run.detailsUrl : run.targetUrl,
        },
      ];
    },
  );
  const avatar = row.author?.avatarUrl;
  const reviews: PullReview[] = row.reviews.nodes.map((review) => ({
    author: review.author?.login ?? null,
    state: review.state,
    submittedAt: review.submittedAt,
    ...(review.bodyText?.trim() ? { body: review.bodyText.trim().slice(0, 10000) } : {}),
  }));
  const commits: PullCommit[] | undefined = row.commitList
    ? row.commitList.nodes.map(({ commit: item }) => ({
        oid: item.oid,
        shortOid: item.abbreviatedOid || item.oid.slice(0, 7),
        message: item.messageHeadline.slice(0, 500),
        author: item.author?.user?.login ?? item.author?.name ?? null,
        committedAt: item.committedDate ?? null,
        url: item.url ?? null,
      }))
    : undefined;
  const comments: PullReviewComment[] | undefined = row.reviewThreads
    ? row.reviewThreads.nodes.flatMap((thread): PullReviewComment[] => {
        const first = thread.comments.nodes[0];
        if (!first?.bodyText.trim()) return [];
        return [
          {
            id: first.id,
            author: first.author?.login ?? null,
            body: first.bodyText.trim().slice(0, 10000),
            path: thread.path ?? null,
            line: thread.line ?? null,
            resolved: thread.isResolved,
            createdAt: first.createdAt ?? null,
            state: thread.isResolved ? "RESOLVED" : "OPEN",
          },
        ];
      })
    : undefined;
  return {
    url: `https://github.com/${repository.nameWithOwner}/pull/${row.number}`,
    repo: repository.nameWithOwner,
    number: row.number,
    title: row.title,
    state:
      row.state === "MERGED"
        ? "merged"
        : row.state === "CLOSED"
          ? "closed"
          : row.isDraft
            ? "draft"
            : "open",
    author: row.author?.login ?? null,
    authorAvatar: avatar?.startsWith("https://avatars.githubusercontent.com/")
      ? avatar
      : null,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    body: row.bodyText,
    head: row.headRefName,
    base: row.baseRefName,
    headSha: row.headRefOid,
    checks: current?.statusCheckRollup?.state ?? null,
    mergeState: row.mergeStateStatus,
    reviewDecision: row.reviewDecision,
    additions: row.additions,
    deletions: row.deletions,
    labels: row.labels.nodes.map((label) => label.name),
    changedFiles: row.changedFiles,
    mergeable: row.mergeable,
    checkRuns,
    moreChecks:
      current?.statusCheckRollup?.contexts.pageInfo.hasNextPage ?? false,
    reviews,
    ...(commits ? { commits, commitCount: row.commitList?.totalCount ?? commits.length } : {}),
    ...(comments ? { comments } : {}),
  };
}
