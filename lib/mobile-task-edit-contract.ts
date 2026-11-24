import { z } from 'zod'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'

// The request shapes and answer codes of the phone's task edits
// (app/api/mobile/tasks/[id]); lib/mobile-task-edit.ts applies them.

/**
 * `PATCH /api/mobile/tasks/:id`. `revision` is the task's revision the phone
 * last read. A status change names the category (`status`) and, optionally, one
 * of the workspace's states of that category (`stateId`), as the web's picker
 * does. `assigneeId` is an active workspace member, or null to unassign.
 */
export const mobileTaskEditInput = z.strictObject({
  revision: z.number().int().positive(),
  status: z.enum(ISSUE_STATUS_CODES).optional(),
  stateId: z.uuid().optional(),
  priority: z.enum(ISSUE_PRIORITY_CODES).optional(),
  assigneeId: z.string().trim().min(1).max(128).nullable().optional(),
}).refine(input => input.status !== undefined || input.priority !== undefined || input.assigneeId !== undefined)
  .refine(input => input.stateId === undefined || input.status !== undefined)
export type MobileTaskEdit = z.infer<typeof mobileTaskEditInput>

/** Linear's comments are the longest Mikka keeps in a discussion (lib/linear-sync/comment-sync.ts). */
export const MOBILE_COMMENT_MAX = 2000

/** `POST /api/mobile/tasks/:id/comments`. `clientId` makes a retried post land once. */
export const mobileTaskCommentInput = z.strictObject({
  body: z.string().trim().min(1).max(MOBILE_COMMENT_MAX),
  clientId: z.uuid().optional(),
})
export type MobileTaskComment = z.infer<typeof mobileTaskCommentInput>

/** How a returned or thrown code reads to the phone: a hidden or unsteerable
 * task is not found, any lost revision race is the list's `issueStale`. */
export function mobileTaskWriteError(code: string): { status: number; error: string } {
  if (code === 'issueStale' || code === 'issueOutdated') return { status: 409, error: 'issueStale' }
  if (code === 'issueNotFound' || code === 'workspaceAccessDenied' || code === 'authRequired') return { status: 404, error: 'issueNotFound' }
  if (code === 'issueSaveFailed' || code === 'issueMetadataSaveFailed') return { status: 500, error: code }
  return { status: 400, error: code }
}
