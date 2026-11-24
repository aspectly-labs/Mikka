import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http';
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler';
import { RouteResponse } from '@/lib/server-runtime/server';
import { auth } from '@/lib/api-auth';
import { factoryLifecycleEnabled, factoryRuntimeForBot } from '@/lib/factory/runtime';
import { handleFactoryQuestionList } from '@/lib/factory/questions/ask-user';
/** GET /api/factory/questions[?taskId=|?runId=] — pending questions in AskUserQuestion shape. */
export async function GET(request: Request) {
  if (!factoryLifecycleEnabled()) return RouteResponse.json({error:'factoryLifecycleUnavailable'},{status:404});
  const sessionHeaders=request.headers.has('authorization')?humanSessionHeaders(request):request.headers;
  if (!sessionHeaders) return RouteResponse.json({error:'authRequired'},{status:401});
  const session=await auth.api.getSession({headers:sessionHeaders,query:{disableCookieCache:true}});
  if (!session?.user) return RouteResponse.json({error:'authRequired'},{status:401});
  return factoryHumanWorkspaceResponse(session?.user, async () => {
    // The selected workspace bounds the human question collection.
    const result=await handleFactoryQuestionList(factoryRuntimeForBot(null).questions,{actor:{userId:session.user.id},authorization:null,method:'GET',url:request.url});
    return RouteResponse.json(result.body,{status:result.status,headers:{'Cache-Control':'private, no-store'}});
  });

}
