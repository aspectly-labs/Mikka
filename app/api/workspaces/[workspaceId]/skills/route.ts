import { auth,apiWorkspaceAllowed } from '@/lib/api-auth'
import { teamSkillStore,skillAssignments } from '@/lib/self-improvement/server'
import { createTeamSkillHandler } from '@/lib/self-improvement/team-skill-http'
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler'
import { defineRoute } from '@/lib/primitives/define-route'

const handle=createTeamSkillHandler({store:teamSkillStore,assignments:skillAssignments,
  async principal(request,workspaceId) {
    const sessionHeaders=humanSessionHeaders(request)
    if(!sessionHeaders)return null
    const session=await auth.api.getSession({headers:sessionHeaders,query:{disableCookieCache:true}})
    return session?.user&&apiWorkspaceAllowed(session,workspaceId)?session.user.id:null
  },
})
type Context={params:Promise<{workspaceId:string}>}
const GETBody=async(request:Request,{params}:Context)=>handle(request,(await params).workspaceId)
const POSTBody=GETBody

export const GET = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/skills',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    desktop: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const POST = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/skills',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    desktop: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
