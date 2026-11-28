'use server'
import { requireIssueAccessWithoutBody, requireUser } from '@/lib/issue-access'
import { ActionFailureError } from '@/lib/action-error'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { taskPresentationsInput, type TaskPresentationsInput } from '@/lib/task-presentation-input'
import { readTaskPresentation, readTaskPresentations } from '@/lib/task-presentation-read'

/** Bounded list adapter, refreshed by the existing live channel rather than a
 * new polling loop. An explicit input cannot replace the current tenant. */
export async function getTaskPresentations(input: TaskPresentationsInput) {
  const parsed = taskPresentationsInput.parse(input)
  const user = await requireUser()
  if (await effectiveRequestWorkspace(user) !== parsed.workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  // External metadata must finish before the canonical payload takes its
  // tenant lease and read-only snapshot. A missing review is not a task ACL.
  const reviews = parsed.includeReview && parsed.issueIds.length
    ? await (await import('@/lib/coding-workspace/task-review/summaries')).taskReviewSummaries(user, parsed.issueIds, parsed.workspaceId)
    : null
  const batch = await readTaskPresentations(user, parsed)
  if (reviews) {
    for (const [id, summary] of reviews) {
      if (!batch.items[id] || !summary.pr && !summary.files) continue
      batch.items[id]!.review = {
        pr: summary.pr && { number: summary.pr.number, state: summary.pr.state },
        files: summary.files, additions: summary.additions, deletions: summary.deletions,
        checks: summary.checks && { failed: summary.checks.failed }, running: summary.running,
      }
    }
  }
  return batch
}

/** Existing detail contract and its canonical Factory authorization stay intact. */
export async function getTaskPresentation(issueId: string) {
  const { issue, user } = await requireIssueAccessWithoutBody(issueId)
  if (!issue.workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return readTaskPresentation(user, issue.workspaceId, issue.id)
}
