import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http';
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler';
import { RouteResponse } from '@/lib/server-runtime/server';
import { auth } from '@/lib/api-auth';
import { factoryLifecycleEnabled } from '@/lib/factory/runtime';
import { factoryDispatchRecovery } from '@/lib/factory/dispatch-recovery-server';
import { handleFactoryDispatchRecovery } from '@/lib/factory/dispatch-recovery-http';
import { defineRoute } from '@/lib/primitives/define-route'
async function unguardedGET(request: Request,{params}:{params:Promise<{taskId:string}>}) {
  if (!factoryLifecycleEnabled()) return RouteResponse.json({error:'factoryLifecycleUnavailable'},{status:404});
  const sessionHeaders=request.headers.has('authorization')?humanSessionHeaders(request):request.headers;
  if (!sessionHeaders) return RouteResponse.json({error:'authRequired'},{status:401});
  const session=await auth.api.getSession({headers:sessionHeaders,query:{disableCookieCache:true}});
  return factoryHumanWorkspaceResponse(session?.user, async () => {
    const result=await handleFactoryDispatchRecovery(factoryDispatchRecovery,{userId:session?.user?.id ?? null,taskId:(await params).taskId,action:'status'});
    return RouteResponse.json(result.body,{status:result.status,headers:result.headers});
  });

}
export const GET = defineRoute<'public','none',{ taskId: string }>(
  {
    route: '/api/factory/tasks/[taskId]/dispatch',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request, params }) => unguardedGET(request, { params: Promise.resolve(params) }),
)
