import { auth } from "@/lib/auth";
import { humanSessionHeaders } from "@/lib/desktop-rpc/handler";
import { writeAllowed } from "@/lib/mobile-api";
import { GitHubAccessError } from "@/lib/github/user-access";
import { pullReviewDependencies, requestPullChanges } from "@/lib/github/pull-review";
import { pullReviewInput } from "@/lib/pull-directory";
import { withRequestLog } from "@/lib/request-log";
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };

/** Requesting changes on a pull request as the signed-in person (lib/github/pull-review.ts). */
const unguardedPOST = withRequestLog(
  "/api/integrations/github/repositories/pulls/review",
  async (request: Request) => {
    const sessionHeaders = humanSessionHeaders(request);
    const session =
      sessionHeaders &&
      (await auth.api.getSession({
        headers: sessionHeaders,
        query: { disableCookieCache: true },
      }));
    if (!session?.user)
      return Response.json({ error: "authRequired" }, { status: 401, headers });
    if (!writeAllowed(request))
      return Response.json({ error: "originNotAllowed" }, { status: 403, headers });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalidInput" }, { status: 400, headers });
    }
    const input = pullReviewInput.safeParse(body);
    if (!input.success)
      return Response.json({ error: "invalidInput" }, { status: 400, headers });
    try {
      const result = await requestPullChanges(
        session.user.id,
        input.data,
        pullReviewDependencies({ deadline: Date.now() + 55_000, signal: request.signal }),
      );
      return Response.json(result, { status: result.kind === "submitted" ? 200 : 409, headers });
    } catch (error) {
      if (request.signal.aborted) throw error;
      console.error("Pull request review failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: error instanceof GitHubAccessError ? error.code : null,
      });
      const failure =
        error instanceof GitHubAccessError
          ? error
          : new GitHubAccessError("githubUnavailable", 502, { cause: error });
      return Response.json({ error: failure.code }, { status: failure.status, headers });
    }
  },
);
export const POST = defineRoute(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request }) => unguardedPOST(request),
)
