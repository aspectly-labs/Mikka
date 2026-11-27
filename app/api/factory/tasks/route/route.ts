import { factoryWorkspaceResponse } from '@/lib/factory/workspace-http';
import { actAs } from "@/lib/acting-user";
import { RouteResponse } from "@/lib/server-runtime/server";
import { type ApiSession } from "@/lib/api-auth";
import { factoryRouteEnabled, handleFactoryRoute } from "@/lib/factory/route-http";
import { issueMutationsEnabled } from "@/lib/coordinator/issue-tools-enabled";
import { defineRoute } from '@/lib/primitives/define-route'

/** POST /api/factory/tasks/route: non-LLM routing (BE-10b); contract in lib/factory/route-http.ts. */
async function unguardedPOST(request: Request, session: ApiSession) {
  const scoped = () => factoryWorkspaceResponse(session?.user?.id, async () => {
    const result = await handleFactoryRoute(
      async () => {
        const { factoryRuntimeForBot } = await import("@/lib/factory/runtime");
        const { store } = factoryRuntimeForBot(null);
        return (userId, input) => store.route(userId, input);
      },
      {
        userId: session?.user?.id ?? null,
        origin: request.headers.get("origin"),
        url: request.url,
        body: await request.json().catch(() => null),
        enabled: factoryRouteEnabled(issueMutationsEnabled()),
      },
    );
    return RouteResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "private, no-store" } });
  });
  return session?.user ? actAs(session.user, scoped) : scoped();
}
export const POST = defineRoute(
  {
    route: '/api/factory/tasks/route',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    onOriginFailure: () => RouteResponse.json({ error: 'originRejected' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } }),
    desktop: true,
  },
  ({ request, session }) => unguardedPOST(request, session),
)
