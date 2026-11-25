'use server'

import { runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import type { EditTaskCommentInput, SetTaskCommentReactionInput, TaskCommentAttachment, TaskCommentReaction, TaskCommentRef, TaskCommentState } from '@/lib/task-comments/contract'
import * as store from '@/lib/task-comments/store'

// A task's comments beyond writing them (which the task document's exchange
// does, app/actions/collaboration.ts): edit, delete and reactions, as Linear,
// Jira, GitHub and Asana offer them. Rules: lib/task-comments/contract.ts.

/** Who may do what on the task's comments, and every comment's reactions (by message id). */
export async function getTaskCommentState(taskId: string): Promise<ActionResult<TaskCommentState>> {
  return runAction(() => store.readTaskCommentState(taskId))
}

/** The author changes their comment's body (and files); it shows 「已编辑」 from then on. */
export async function editTaskComment(input: EditTaskCommentInput): Promise<ActionResult<{ comment: { taskId: string; threadId: string; messageId: string; body: string; editedAt: string | null; attachments: TaskCommentAttachment[] } }>> {
  return runAction(() => store.editTaskComment(input))
}

/** Its author or a workspace admin deletes a comment: a 「评论已删除」 tombstone while its thread has replies, else the thread goes. */
export async function deleteTaskComment(input: TaskCommentRef): Promise<ActionResult<{ deleted: 'tombstone' | 'removed'; threadRemoved: boolean }>> {
  return runAction(() => store.deleteTaskComment(input))
}

/** Gives (`reacted: true`) or takes back the viewer's reaction of one emoji; answers the comment's reactions after the change. */
export async function setTaskCommentReaction(input: SetTaskCommentReactionInput): Promise<ActionResult<{ reactions: TaskCommentReaction[] }>> {
  return runAction(() => store.setTaskCommentReaction(input))
}
