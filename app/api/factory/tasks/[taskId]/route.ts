import { factoryWorkspaceResponse } from '@/lib/factory/workspace-http';
import { actAs } from "@/lib/acting-user";
import { RouteResponse } from "@/lib/server-runtime/server";
import { type ApiSession } from "@/lib/api-auth";
import { handleFactory } from "@/lib/factory/http";
import { factoryHumanStore } from "@/lib/factory/server";
import { pool } from '@/lib/db';
import { workspacePool } from '@/lib/workspace-db';
import { factoryLiveScopes } from '@/lib/live/factory';
import { defineRoute } from '@/lib/primitives/define-route'

// A retained-delivery retry has a bounded provider inspection and pause step,
// followed by the locked receipt transaction and durable review handoff.
export const maxDuration = 120;
async function respond(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
  session: ApiSession,
) {
  const scoped = () => factoryWorkspaceResponse(session?.user?.id, async () => {
    const { taskId } = await context.params;
    const result = await handleFactory(factoryHumanStore, {
      userId: session?.user?.id ?? null,
      method: request.method,
      taskId,
      origin: request.headers.get("origin"),
      url: request.url,
      body:
        request.method === "POST"
          ? await request.json().catch(() => null)
          : undefined,
    });
    let liveWorkspaceId: string | null = null;
    if (result.status === 200 && session?.user) {
      try { liveWorkspaceId = (await factoryLiveScopes(pool, workspacePool, taskId, session.user.id))?.task.workspaceId ?? null; }
      catch { console.warn('[live] Factory task scope unavailable'); }
    }
    return RouteResponse.json(result.status === 200 ? { ...(result.body as Record<string, unknown>), liveWorkspaceId } : result.body, {
      status: result.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  });
  return session?.user ? actAs(session.user, scoped) : scoped();
}
export const GET = defineRoute<'session','none',{ taskId: string }>(
  {
    route: '/api/factory/tasks/[taskId]',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
  },
  ({ request, params, session }) => respond(request, { params: Promise.resolve(params) }, session),
)

export const POST = defineRoute<'session','none',{ taskId: string }>(
  {
    route: '/api/factory/tasks/[taskId]',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    onOriginFailure: () => RouteResponse.json({ error: 'originRejected' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } }),
  },
  ({ request, params, session }) => respond(request, { params: Promise.resolve(params) }, session),
)
