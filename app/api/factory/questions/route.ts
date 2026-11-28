import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http';
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler';
import { RouteResponse } from '@/lib/server-runtime/server';
import { auth } from '@/lib/api-auth';
import { factoryLifecycleEnabled, factoryRuntimeForBot } from '@/lib/factory/runtime';
import { handleFactoryQuestionList } from '@/lib/factory/questions/ask-user';
import { defineRoute } from '@/lib/primitives/define-route'
/** GET /api/factory/questions[?taskId=|?runId=] — pending questions in AskUserQuestion shape. */
async function unguardedGET(request: Request) {
  if (!factoryLifecycleEnabled()) return RouteResponse.json({error:'factoryLifecycleUnavailable'},{status:404});
  const sessionHeaders=request.headers.has('authorization')?humanSessionHeaders(request):request.headers;
  if (!sessionHeaders) return RouteResponse.json({error:'authRequired'},{status:401});
  const session=await auth.api.getSession({headers:sessionHeaders,query:{disableCookieCache:true}});
  if (!session?.user) return RouteResponse.json({error:'authRequired'},{status:401});
  return factoryHumanWorkspaceResponse(session?.user, async () => {
    // The selected workspace bounds the human question collection.
    const result = await handleFactoryQuestionList(factoryRuntimeForBot(null).questions, {
      actor: { userId: session.user.id },
      authorization: null,
      method: 'GET',
      url: request.url,
    });
    if (result.status === 200 && 'questions' in result.body && Array.isArray(result.body.questions)) {
      const hasBoundIssue = result.body.questions.some(q => {
        const ref = (q as { reference?: { binding?: { issueId?: unknown } } })?.reference;
        return typeof ref?.binding?.issueId === 'string' && ref.binding.issueId.length > 0;
      });
      if (hasBoundIssue) {
        const { attachFactoryQuestionTaskLabels } = await import('@/lib/factory/questions/issue-labels');
        const questions = await attachFactoryQuestionTaskLabels(result.body.questions);
        return RouteResponse.json({ questions }, { status: 200, headers: { 'Cache-Control': 'private, no-store' } });
      }
    }
    return RouteResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } });
  });

}
export const GET = defineRoute(
  {
    route: '/api/factory/questions',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request }) => unguardedGET(request),
)
