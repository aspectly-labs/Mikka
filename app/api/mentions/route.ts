import { NextResponse } from '@/lib/server-runtime/server'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { actAs } from '@/lib/acting-user'
import { SearchInputError } from '@/lib/issue-search'
import { parseInput, UnsupportedSourceError } from '@/lib/federated-search/input'
import { readSearchPage, SearchAccessError } from '@/lib/federated-search/store'
import { pool } from '@/lib/db'
import { z } from 'zod'

export const maxDuration = 30
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' }

/** #2941 item 1: one mention search for every reference type. `type=task`
 * reuses the site-search store; the other types are owner/workspace-scoped
 * reads shaped like a picker page. */
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
    if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
    const params = new URL(request.url).searchParams
    const type = params.get('type')
    const q = (params.get('q') ?? '').trim()
    const workspaceId = params.get('workspaceId')
    if (!z.uuid().safeParse(workspaceId).success || !apiWorkspaceAllowed(session, workspaceId!))
      return NextResponse.json({ error: 'searchAccessDenied' }, { status: 403, headers })
    const like = `%${q.replace(/[%_\\]/g, c => `\\${c}`)}%`

    if (type === 'task') {
      const input = parseInput(new URLSearchParams({ source: 'tasks', q, workspaceId: workspaceId! }), session.user.id)
      const read = await actAs(session.user, () => readSearchPage(session.user.id, input))
      const page = await actAs(session.user, () => read.revalidate())
      return NextResponse.json({ type, items: page.items.map(item => ({ type: 'task', id: item.id, title: item.title, detail: item.type === 'task' ? `${item.identifier ?? ''} ${item.status}`.trim() : null })) }, { headers })
    }
    if (type === 'bot') {
      const { rows } = await pool.query<{ id: string; name: string; publicRole: string }>(
        `SELECT id,name,"publicRole" FROM bots WHERE "workspaceId"=$1 AND ($2='' OR name ILIKE $3 ESCAPE '\\' OR "slackAlias" ILIKE $3 ESCAPE '\\') ORDER BY name LIMIT 20`,
        [workspaceId, q, like])
      return NextResponse.json({ type, items: rows.map(r => ({ type: 'bot', id: r.id, title: r.name, detail: r.publicRole || null })) }, { headers })
    }
    if (type === 'thread') {
      const { rows } = await pool.query<{ id: string; status: string; title: string | null }>(
        `SELECT r.id,r.status,COALESCE(r.title,i."issuedIdentifier"||' '||i.title,i.title) AS title FROM agent_runs r
          LEFT JOIN issues i ON i.id=r."issueId"
          WHERE r."userId"=$1 AND r."workspaceId"=$2 AND ($3='' OR i.title ILIKE $4 ESCAPE '\\' OR i."issuedIdentifier" ILIKE $4 ESCAPE '\\' OR r.title ILIKE $4 ESCAPE '\\')
          ORDER BY r."createdAt" DESC LIMIT 20`, [session.user.id, workspaceId, q, like])
      return NextResponse.json({ type, items: rows.map(r => ({ type: 'thread', id: r.id, title: r.title, detail: r.status })) }, { headers })
    }
    if (type === 'pr') {
      const { rows } = await pool.query<{ url: string; title: string | null; state: string | null }>(
        `SELECT p."pullRequest"->>'url' AS url,p."pullRequest"->>'title' AS title,p."pullRequest"->>'state' AS state
          FROM run_publications p JOIN issues i ON i.id=p."issueId" WHERE p."userId"=$1 AND i."workspaceId"=$2 AND p."pullRequest" IS NOT NULL
          AND ($3='' OR p."pullRequest"->>'title' ILIKE $4 ESCAPE '\\' OR p."pullRequest"->>'url' ILIKE $4 ESCAPE '\\')
          ORDER BY p."updatedAt" DESC LIMIT 20`, [session.user.id, workspaceId, q, like])
      return NextResponse.json({ type, items: rows.map(r => ({ type: 'pr', id: r.url, title: r.title, detail: r.state })) }, { headers })
    }
    if (type === 'file') {
      const { rows } = await pool.query<{ id: string; files: { path?: string }[]; runId: string }>(
        `SELECT id,files,"runId" FROM coding_workspace_mentions
          WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "expiresAt">clock_timestamp()
          AND ($3='' OR EXISTS (SELECT 1 FROM jsonb_array_elements(files) f WHERE f->>'path' ILIKE $4 ESCAPE '\\'))
          ORDER BY id DESC LIMIT 20`, [session.user.id, workspaceId, q, like])
      return NextResponse.json({ type, items: rows.map(r => {
        const idx = q ? Math.max(0, (r.files ?? []).findIndex(f => f.path?.toLowerCase().includes(q.toLowerCase()))) : 0
        return { type: 'file', id: r.id, offset: idx, title: r.files?.[idx]?.path ?? null, detail: `${r.files?.length ?? 0} file${r.files?.length === 1 ? '' : 's'}` }
      }) }, { headers })
    }
    return NextResponse.json({ error: 'searchInvalidParam' }, { status: 400, headers })
  } catch (error) {
    if (error instanceof SearchInputError) return NextResponse.json({ error: error.code }, { status: 400, headers })
    if (error instanceof UnsupportedSourceError) return NextResponse.json({ error: 'searchSourceUnsupported' }, { status: 422, headers })
    if (error instanceof SearchAccessError) return NextResponse.json({ error: 'searchAccessDenied' }, { status: 403, headers })
    console.error('Mention search failed')
    return NextResponse.json({ error: 'searchFailed' }, { status: 500, headers })
  }
}
