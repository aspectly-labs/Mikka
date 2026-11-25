import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { activityActor } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { issues, issueVersions } from '@/lib/db/schema'
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'
import { issueListChanged } from '@/lib/live/lists'
import { lockResourcesAccess } from '@/lib/resource-access/store'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { taskEnvironmentInput, taskEnvironmentsInput, type EnvironmentScope } from './contracts'
import { resourceWriteLock } from './store'

type Reader = { id: string }

/** What a reader sees of a task's 「环境」. `environment` is null when it is archived or someone else's 「仅我」. */
export type TaskEnvironmentView = {
  issueId: string
  environmentId: string | null
  environment: { id: string; name: string; scope: EnvironmentScope; mine: boolean } | null
}

/**
 * Set or clear a task's 「环境」 (decision 2026-11-26-0110 rule 4). Steering the task is the right to change it, and
 * the reader must be able to use the environment: a shared one, or their own personal one. Like the task's
 * other properties it is a new task revision; threads keep the environment their runs were admitted with only
 * when their request chose it, so the next run of an existing thread is admitted with the new one.
 */
export async function setTaskEnvironment(reader: Reader, raw: z.input<typeof taskEnvironmentInput>) {
  const parsed = taskEnvironmentInput.safeParse(raw)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  const { workspaceId, issueId, revision, environmentId } = parsed.data
  const actor = reader.id
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    // The same order as every resource writer: relations -> resources -> entities, then APP.
    await resourceWriteLock(tx, workspaceId)
    if (environmentId) {
      const { rowCount } = await tx.execute(sql`select 1 from workspace_environments where id=${environmentId} and "workspaceId"=${workspaceId}
        and "archivedAt" is null and (scope='workspace' or "ownerId"=${actor}) for share`)
      if (!rowCount) throw new ActionFailureError('projectEnvironmentUnavailable')
    }
    const { rows: [current] } = await tx.execute<{ environmentId: string }>(sql`select "environmentId" from workspace_task_environments
      where "issueId"=${issueId} and "workspaceId"=${workspaceId} for update`)
    return db.transaction(async application => {
      await lockResourcesAccess(application, actor, [{ reference: { kind: 'task', id: issueId, workspaceId }, action: 'canSteer' }])
      const [task] = await application.select().from(issues)
        .where(and(eq(issues.id, issueId), issueVisibilityPredicate(actor, { allowedIds: [], workspaceIds: [workspaceId] }))).for('update')
      if (!task) throw new ActionFailureError('issueNotFound')
      if (task.revision !== revision) throw new ActionFailureError('issueOutdated')
      const previous = current?.environmentId ?? null
      if (previous === environmentId) return { revision: task.revision, environmentId }
      if (environmentId) await tx.execute(sql`insert into workspace_task_environments("issueId","workspaceId","environmentId","updatedBy")
        values(${issueId},${workspaceId},${environmentId},${actor})
        on conflict("issueId") do update set "environmentId"=excluded."environmentId","updatedBy"=excluded."updatedBy","updatedAt"=now()`)
      else await tx.execute(sql`delete from workspace_task_environments where "issueId"=${issueId} and "workspaceId"=${workspaceId}`)
      await tx.execute(sql`insert into workspace_resource_events(id,"workspaceId","actorId",kind,"resourceId",detail)
        values(${randomUUID()},${workspaceId},${actor},'task_environment.changed',${issueId},${JSON.stringify({ environmentId, previous })}::jsonb)`)
      const [saved] = await application.update(issues).set({ revision: sql`${issues.revision} + 1`, updatedAt: new Date() })
        .where(eq(issues.id, task.id)).returning()
      await application.insert(issueVersions).values({
        id: randomUUID(), issueId: saved.id, userId: saved.userId, revision: saved.revision,
        title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...activityActor(actor),
      })
      await issueListChanged(application, saved.id)
      return { revision: saved.revision, environmentId }
    })
  })
}

/** The 「环境」 of the given tasks the reader can see; tasks they cannot see are left out. */
export async function readTaskEnvironments(reader: Reader, raw: z.input<typeof taskEnvironmentsInput>): Promise<TaskEnvironmentView[]> {
  const parsed = taskEnvironmentsInput.safeParse(raw)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  const { workspaceId, issueIds } = parsed.data
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    const visible = await db.select({ id: issues.id }).from(issues)
      .where(and(inArray(issues.id, [...new Set(issueIds)]), issueVisibilityPredicate(reader.id, { allowedIds: [], workspaceIds: [workspaceId] })))
    if (!visible.length) return []
    const { rows } = await tx.execute<{ issueId: string; environmentId: string; name: string | null; scope: EnvironmentScope | null; ownerId: string | null }>(sql`
      select t."issueId", t."environmentId", e.name, e.scope, e."ownerId"
      from workspace_task_environments t
      left join workspace_environments e on e.id=t."environmentId" and e."workspaceId"=t."workspaceId" and e."archivedAt" is null
        and (e.scope='workspace' or e."ownerId"=${reader.id})
      where t."workspaceId"=${workspaceId} and t."issueId" in (${sql.join(visible.map(row => sql`${row.id}::uuid`), sql`,`)})`)
    const byTask = new Map(rows.map(row => [row.issueId, row]))
    return visible.map(({ id }) => {
      const row = byTask.get(id)
      return {
        issueId: id,
        environmentId: row?.environmentId ?? null,
        environment: row?.name != null && row.scope ? { id: row.environmentId, name: row.name, scope: row.scope, mine: row.ownerId === reader.id } : null,
      }
    })
  })
}
