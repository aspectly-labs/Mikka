import 'server-only'
import type { TaskLabelReferences } from '@mikka/protocol/task-labels'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { db } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import { workspaceIssueLabels } from './schema'

/** Compatibility names resolve within the already-admitted tenant. This never creates entities or writes colors.
 * Both sides are folded by the database, so a submitted name matches the registry under the server's collation
 * rather than JavaScript's contextual Unicode case conversion. */
export async function resolveTaskLabelNames(executor: Pick<typeof db, 'select'>, workspaceId: string, raw: unknown): Promise<TaskLabelReferences> {
  const names = z.array(z.string().trim().min(1).max(40)).max(12).parse(raw)
  if (!names.length) return { labelIds: [], labels: [] }
  const rows = await executor.select({ id: workspaceIssueLabels.id, name: workspaceIssueLabels.name, color: workspaceIssueLabels.color })
    .from(sql`unnest(${sql.param(names)}::text[]) with ordinality as requested(name, ordinality)`)
    .innerJoin(workspaceIssueLabels, and(eq(workspaceIssueLabels.workspaceId, workspaceId),
      sql`lower(${workspaceIssueLabels.name}) = lower(requested.name)`))
    .orderBy(asc(sql`requested.ordinality`)).for('share', { of: workspaceIssueLabels, noWait: true })
  if (rows.length !== names.length) throw new ActionFailureError('issueMetadataInvalid')
  const labels = rows.filter((row, index) => rows.findIndex(other => other.id === row.id) === index)
  return { labelIds: labels.map(label => label.id), labels: labels.map(({ name, color }) => ({ name, color })) }
}

/** Refuse foreign and deleted IDs before entering a writer, so actions return
 * their ordinary validation failure rather than leaking a database exception. */
export async function resolveTaskLabelIds(executor: Pick<typeof db, 'select'>, workspaceId: string, raw: unknown): Promise<TaskLabelReferences> {
  const ids = [...new Set(z.array(z.uuid()).max(12).parse(raw))]
  if (!ids.length) return { labelIds: [], labels: [] }
  const rows = await executor.select({ id: workspaceIssueLabels.id, name: workspaceIssueLabels.name, color: workspaceIssueLabels.color }).from(workspaceIssueLabels)
    .where(and(eq(workspaceIssueLabels.workspaceId, workspaceId), inArray(workspaceIssueLabels.id, ids)))
    .orderBy(asc(workspaceIssueLabels.id)).for('share', { noWait: true })
  const byId = new Map(rows.map(row => [row.id, row]))
  if (ids.some(id => !byId.has(id))) throw new ActionFailureError('issueMetadataInvalid')
  return { labelIds: ids, labels: ids.map(id => { const { name, color } = byId.get(id)!; return { name, color } }) }
}

export function invalidTaskLabelReference(error: unknown): boolean {
  for (let cause: unknown = error; cause && typeof cause === 'object'; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { constraint?: string }).constraint === 'issue_labels_workspace_reference') return true
  }
  return false
}
