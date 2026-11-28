import 'server-only'
import { and, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { actingContext } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { teamIssues } from '@/lib/db/team-schema'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { workspaceDb } from '@/lib/workspace-db'

type QuestionLike = {
  reference?: unknown
  [key: string]: unknown
}

const uuidSchema = z.uuid()

export function questionBindingIssueId(reference: unknown): string | null {
  if (!reference || typeof reference !== 'object') return null
  const binding = (reference as { binding?: unknown }).binding
  if (!binding || typeof binding !== 'object') return null
  const issueId = (binding as { issueId?: unknown }).issueId
  if (typeof issueId !== 'string') return null
  const parsed = uuidSchema.safeParse(issueId)
  return parsed.success ? parsed.data : null
}

/**
 * Batch-attach authorized `[identifier, title]` labels (`task`) and `issueId`
 * onto `/api/factory/questions` items in one bounded query, eliminating N+1
 * per-question `getIssue()` full-document reads on the client (#1975).
 * Only issues readable by the active workspace reader are labelled; hidden or
 * cross-workspace tasks receive `task: ''`.
 */
export async function attachFactoryQuestionTaskLabels<T extends QuestionLike>(
  questions: readonly T[],
): Promise<Array<T & { issueId: string | null; task: string }>> {
  const issueIds = [...new Set(questions.map(q => questionBindingIssueId(q.reference)).filter((id): id is string => id !== null))]
  const labels = new Map<string, string>()

  if (issueIds.length > 0) {
    const acting = actingContext.getStore()
    const workspaceId = acting?.tokenWorkspaceId
    if (acting?.userId && workspaceId) {
      const reader = Object.defineProperties({ id: acting.userId }, {
        [tokenWorkspace]: { value: workspaceId },
        [enterprisePrincipal]: { value: acting.enterprisePrincipal },
      }) as Exclude<IssueReader, string>
      const visibility = await issueVisibility(reader, false, workspaceId, db, { onlyIssueIds: issueIds, withTeamLinks: false })
      const rows = await db.select({
        id: issues.id,
        userId: issues.userId,
        workspaceId: issues.workspaceId,
        scope: issues.scope,
        title: issues.title,
        issuedIdentifier: issues.issuedIdentifier,
        content: issueAttrsContent,
      }).from(issues).where(and(inArray(issues.id, issueIds), visibility.predicate))

      const liveRows = rows
        .map(row => ({ ...row, metadata: readIssueMetadata(row.content) }))
        .filter(row => !row.metadata.deletedAt)

      if (liveRows.length > 0) {
        const links = await workspaceDb
          .select({ issueId: teamIssues.issueId, workspaceId: teamIssues.workspaceId })
          .from(teamIssues)
          .where(inArray(teamIssues.issueId, liveRows.map(row => row.id)))
        const linked = new Map(links.map(link => [link.issueId, link.workspaceId]))
        const visible = liveRows.filter(row => !linked.has(row.id) || linked.get(row.id) === row.workspaceId)
        if (visible.length > 0) {
          const identifiers = await taskIdentifiers(visible.map(row => ({
            id: row.id,
            ownerId: row.userId,
            scope: row.scope,
            number: row.metadata.number,
            issuedIdentifier: row.issuedIdentifier,
          })))
          for (const row of visible) {
            labels.set(row.id, [identifiers.get(row.id), row.title].filter(Boolean).join(' '))
          }
        }
      }
    }
  }

  return questions.map(question => {
    const issueId = questionBindingIssueId(question.reference)
    return {
      ...question,
      issueId,
      task: issueId ? (labels.get(issueId) ?? '') : '',
    }
  })
}
