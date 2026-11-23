import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { agentRuns, issues, runMessages } from './db/schema'
import { chatPreview } from './agent-history'
import { threadTitle } from './short-title'

/** A thread/task's lightweight hover preview (#2935 item 5): title, run status,
 * when it last moved and the latest reply line. Reads two indexed rows and is
 * safe to call on pointer hover; callers keep it cheap with a 30s cache. */
export interface ThreadPreview {
  runId: string
  title: string
  status: string
  updatedAt: string
  /** The latest reply's first line, trimmed; null when the thread has no reply yet. */
  preview: string | null
}

type Queryable = { select: Function }

export async function readThreadPreview(q: Queryable, opts: { ownerId: string; workspaceId: string; runId: string }): Promise<ThreadPreview | null> {
  const [run] = await q.select({ id: agentRuns.id, title: agentRuns.title, name: agentRuns.name, status: agentRuns.status, updatedAt: agentRuns.updatedAt, issueTitle: issues.title })
    .from(agentRuns)
    .leftJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(and(eq(agentRuns.id, opts.runId), eq(agentRuns.userId, opts.ownerId), eq(agentRuns.workspaceId, opts.workspaceId)))
    .limit(1)
  if (!run) return null
  const [latest] = await q.select({ text: runMessages.text }).from(runMessages)
    .where(eq(runMessages.runId, run.id)).orderBy(desc(runMessages.createdAt)).limit(1)
  return {
    runId: run.id,
    title: threadTitle({ title: run.title, name: run.name, issue: run.issueTitle ? { title: run.issueTitle } : null }),
    status: run.status,
    updatedAt: run.updatedAt.toISOString(),
    preview: latest ? chatPreview(latest.text) : null,
  }
}
