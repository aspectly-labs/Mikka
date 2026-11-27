import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { apiWorkspaceAllowed, type ApiSession } from '@/lib/api-auth'
import { auditPageInput, auditScopeQuery, csvField } from '@/lib/audit/cursor'
import { createHash } from 'node:crypto'
import { AuditExportError, createAuditExport, readAuditExportPage } from '@/lib/audit/export'
import { WorkspaceError } from '@/lib/workspace-access'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60

type Context = { params: Promise<{ workspaceId: string }> }

/** 审计日志 › 导出 CSV: the last 90 days (or only 安全, some categories, a shorter period), admins only. */
async function GETBody(request: Request, { params }: Context, session: ApiSession) {
  const { workspaceId } = await params
  if (!apiWorkspaceAllowed(session, workspaceId)) return new RouteResponse(null, { status: 403 })
  if (!z.uuid().safeParse(workspaceId).success) return new RouteResponse(null, { status: 404 })
  const search = new URL(request.url).searchParams
  const scope = auditPageInput.safeParse(auditScopeQuery(search))
  if (!scope.success) return new RouteResponse(null, { status: 400 })
  const { filter, categories, from, until } = scope.data
  const format = search.get('format') ?? 'csv'
  const page = z.object({ exportId: z.uuid().nullable(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(100) }).safeParse({
    exportId: search.get('exportId'), offset: search.get('offset') ?? undefined, limit: search.get('limit') ?? undefined,
  })
  if (!page.success || !['csv', 'json'].includes(format) || (format === 'csv' && page.data.exportId) || (!page.data.exportId && page.data.offset !== 0)) return new RouteResponse(null, { status: 400 })
  try {
    const result = page.data.exportId
      ? await readAuditExportPage(session.user.id, workspaceId, page.data.exportId, page.data.offset, page.data.limit)
      : categories || from || until
        ? await createAuditExport(session.user.id, workspaceId, filter, undefined, undefined, undefined, { categories, from, until })
        : await createAuditExport(session.user.id, workspaceId, filter)
    if (format === 'json') {
      const events = page.data.exportId ? result.events : result.events.slice(0, page.data.limit)
      const nextOffset = page.data.exportId && 'nextOffset' in result ? result.nextOffset : events.length < result.manifest.count ? events.length : null
      return RouteResponse.json({ manifest: result.manifest, events, nextOffset }, { headers: { 'cache-control': 'private, no-store' } })
    }
    const events = result.events
    const header = ['time', 'actor', 'actor_type', 'action', 'category', 'target', 'ip', 'city']
    const lines = events.map(event => [event.createdAt, event.actorName, event.actorType, event.action, event.category, event.targetLabel, event.ip, event.geoCity].map(csvField).join(','))
    const content = `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`
    return new RouteResponse(content, { headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'private, no-store',
      'x-mikka-audit-export-id': result.manifest.id,
      'x-mikka-audit-count': String(result.manifest.count),
      'x-mikka-audit-content-sha256': createHash('sha256').update(content).digest('hex'),
      'x-mikka-audit-digest': result.manifest.digest,
    } })
  } catch (error) {
    if (error instanceof AuditExportError) return RouteResponse.json({ error: error.code }, { status: error.status, headers: { 'cache-control': 'private, no-store' } })
    if (error instanceof WorkspaceError) return new RouteResponse(null, { status: 404 })
    throw error
  }
}

export const GET = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/audit-log',
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId: ({ params }) => z.uuid().safeParse(params.workspaceId).success ? params.workspaceId : undefined,
    onAuthFailure: () => new RouteResponse(null, { status: 401 }),
    desktop: true,
  },
  ({ request, params, session }) => GETBody(request, { params: Promise.resolve(params) }, session),
)
