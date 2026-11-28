import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http';
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler';
import { RouteResponse } from '@/lib/server-runtime/server';
import { z } from 'zod';
import { auth } from '@/lib/api-auth';
import { pool } from '@/lib/db';
import { FactoryError } from '@/lib/factory/contract';
import { factoryLifecycleEnabled, factoryRuntimeForBot } from '@/lib/factory/runtime';
import { questionRecoverySchema } from '@/lib/factory/questions/contract';
import { defineRoute } from '@/lib/primitives/define-route'
export const maxDuration = 300;
async function unguardedPOST(request: Request, {params}: {params:Promise<{questionId:string}>}) {
  if(!factoryLifecycleEnabled()) return RouteResponse.json({error:'factoryLifecycleUnavailable'},{status:404});
  const sessionHeaders=request.headers.has('authorization')?humanSessionHeaders(request):request.headers;
  if(!sessionHeaders) return RouteResponse.json({error:'authRequired'},{status:401});
  const session=await auth.api.getSession({headers:sessionHeaders,query:{disableCookieCache:true}});
  if(!session?.user || !session.session?.id) return RouteResponse.json({error:'authRequired'},{status:401});
  try {
    if(new URL(request.headers.get('origin') ?? '').origin!==new URL(request.url).origin) throw new Error('origin');
  } catch { return RouteResponse.json({error:'originRejected'},{status:403}); }
  const id=z.uuid().safeParse((await params).questionId);
  const body=questionRecoverySchema.safeParse(await request.json().catch(()=>null));
  if(!id.success || !body.success || body.data.reference.questionId!==id.data.toLowerCase()) return RouteResponse.json({error:'factoryInvalid'},{status:422});
  const humanSessionId = session.session.id;
  return factoryHumanWorkspaceResponse(session?.user, async () => {
    const {rows:[identity]}=await pool.query('SELECT t."botId" FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId" WHERE q.id=$1 AND q."userId"=$2 AND t."userId"=$2',[id.data,session.user.id]);
    if(!identity) return RouteResponse.json({error:'factoryNotFound'},{status:404});
    try {
      const result=await factoryRuntimeForBot(identity.botId).questions.recover({source:'human',userId:session.user.id,sessionId:humanSessionId},body.data);
      return RouteResponse.json(result,{headers:{'Cache-Control':'private, no-store'}});
    } catch(error) {
      if(!(error instanceof FactoryError)) throw error;
      return RouteResponse.json({error:error.code},{status:error.code==='factoryNotFound'?404:error.code==='factoryInvalid'?422:409});
    }
  });

}
export const POST = defineRoute<'public','none',{ questionId: string }>(
  {
    route: '/api/factory/questions/[questionId]/recover',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request, params }) => unguardedPOST(request, { params: Promise.resolve(params) }),
)
