import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES, type IssuePriority, type IssueStatus } from '@/lib/issue-meta'
import { ISSUE_PRIORITY_MARKS, ISSUE_STATUS_MARKS, stateMarkTone } from '@/lib/state-mark'
import { statusIconTints } from '@/lib/status-appearance'

const statusOptions = {
  backlog: { label: 'Backlog', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  todo: { label: 'Todo', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  doing: { label: 'In Progress', surfaceClassName: 'bg-warning/5', borderClassName: 'border-warning/20' },
  review: { label: 'In Review', surfaceClassName: 'bg-info/5', borderClassName: 'border-info/20' },
  done: { label: 'Done', surfaceClassName: 'bg-success/5', borderClassName: 'border-success/20' },
  canceled: { label: 'Canceled', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  duplicate: { label: 'Duplicate', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
} as const satisfies Record<IssueStatus, { label: string; surfaceClassName: string; borderClassName: string }>

const priorityOptions = {
  urgent: { label: 'Urgent' },
  high: { label: 'High' },
  normal: { label: 'Normal' },
  low: { label: 'Low' },
} as const satisfies Record<IssuePriority, { label: string }>

export const ISSUE_STATUSES = ISSUE_STATUS_CODES.map(value => {
  const tone = stateMarkTone(ISSUE_STATUS_MARKS[value])
  return { value, ...statusOptions[value], indicatorClassName: statusIconTints[tone], tone }
})

export const ISSUE_PRIORITIES = ISSUE_PRIORITY_CODES.map(value => ({
  value,
  ...priorityOptions[value],
  tone: stateMarkTone(ISSUE_PRIORITY_MARKS[value]),
}))

export type { IssuePriority, IssueStatus }
export type IssueView = 'all' | 'mine' | 'shared' | 'favorites' | 'following' | IssueStatus
export { WORKSPACE_NAME, WORKSPACE_SLUG } from '@/lib/workspace-defaults'

/**
 * Shows the id the server resolved with `taskIdentifier` (lib/task-identifier.ts): `MIK-12` or `ALEX-12`.
 * A task without one (a workspace task with no Linear id) shows `pendingLabel`, by default nothing.
 */
export function issueIdentifier(task: { identifier: string | null } | null | undefined, pendingLabel = '') {
  return task?.identifier ?? pendingLabel
}
