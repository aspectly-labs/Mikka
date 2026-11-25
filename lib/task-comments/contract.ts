import { z } from 'zod'
import type { ThreadMessage, ThreadRecord } from '@/lib/task-discussion'

// A task's comments (the discussions in its document, lib/task-discussion.ts):
// edit, delete, reactions and inline files. Shared by the server actions
// (app/actions/task-comments.ts) and the UI; no server-only imports.

/** What this server supports, so a client can show an action only when it exists. */
export const TASK_COMMENT_FEATURES = { version: 1, edit: true, delete: true, reactions: true, inlineFiles: true } as const
export type TaskCommentFeatures = typeof TASK_COMMENT_FEATURES

/** Existing discussions can contain historical Linear comments of this length. */
export const TASK_COMMENT_BODY_MAX = 2000
/** Files one comment can carry, as GitHub's and Linear's composers allow several. */
export const TASK_COMMENT_ATTACHMENTS_MAX = 10

/** The row of quick reactions, as GitHub's eight; any other single emoji comes from the picker. */
export const TASK_COMMENT_QUICK_REACTIONS = ['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'] as const
/** Distinct emoji one comment can carry; a new one beyond this is refused (Slack's cap is 23). */
export const TASK_COMMENT_REACTIONS_MAX = 20

/** A file in a comment: an inline task file (lib/task-attachments, placement `inline`), read with the task's own access. */
export const taskCommentAttachmentSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(255),
  size: z.number().int().min(1).max(3 * 1024 * 1024),
  mediaType: z.string().max(64).nullable(),
})
export type TaskCommentAttachment = z.infer<typeof taskCommentAttachmentSchema>
export const taskCommentAttachmentsSchema = z.array(taskCommentAttachmentSchema).max(TASK_COMMENT_ATTACHMENTS_MAX)
  .refine(list => new Set(list.map(file => file.id)).size === list.length)

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const PICTOGRAPH = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]️?⃣)/u

/** One emoji: a single grapheme that starts with a pictograph, a flag or a keycap (skin tones and ZWJ sequences included). */
export function isReactionEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 32 || value !== value.trim()) return false
  if (!PICTOGRAPH.test(value)) return false
  if (!segmenter) return [...value].length <= 8
  let count = 0
  for (const _ of segmenter.segment(value)) if (++count > 1) return false
  return count === 1
}
export const taskCommentEmojiSchema = z.string().refine(isReactionEmoji)

/** A comment's address in its task document. */
export const taskCommentRefSchema = z.strictObject({
  taskId: z.uuid(),
  threadId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(300),
})
export type TaskCommentRef = z.infer<typeof taskCommentRefSchema>

export const editTaskCommentInput = taskCommentRefSchema.extend({
  body: z.string().trim().min(1).max(TASK_COMMENT_BODY_MAX),
  /** Omitted keeps the comment's files; a list replaces them. */
  attachments: taskCommentAttachmentsSchema.optional(),
})
export type EditTaskCommentInput = z.input<typeof editTaskCommentInput>

export const setTaskCommentReactionInput = taskCommentRefSchema.extend({ emoji: taskCommentEmojiSchema, reacted: z.boolean() })
export type SetTaskCommentReactionInput = z.input<typeof setTaskCommentReactionInput>

/** One emoji on one comment: how many gave it, whether the viewer did, and who (for the hover list). */
export type TaskCommentReaction = { emoji: string; count: number; reacted: boolean; users: { id: string; name: string; image: string | null }[] }

/** What `getTaskCommentState` answers for the task page. */
export type TaskCommentState = {
  viewerId: string
  features: TaskCommentFeatures
  /** The viewer may write in the discussion (the task's canSteer): comment, react, edit and delete their own. */
  canComment: boolean
  /** The viewer is a workspace admin: may delete anyone's comment. */
  canModerate: boolean
  quickReactions: readonly string[]
  /** By message id. */
  reactions: Record<string, TaskCommentReaction[]>
}

/** A deleted message: no body and no files, kept so the thread's replies keep their place. */
export const isDeletedMessage = (message: Pick<ThreadMessage, 'deletedAt'>) => typeof message.deletedAt === 'string'

/**
 * The messages a thread shows. A deleted message is shown (as 「评论已删除」)
 * only where removing it would break the thread: the thread's first comment
 * while it has replies, or a message a live reply answers. Other deleted
 * replies are hidden, as Linear and GitHub drop them.
 */
export function visibleThreadMessages(thread: Pick<ThreadRecord, 'messages'>): ThreadMessage[] {
  const live = thread.messages.filter(message => !isDeletedMessage(message))
  if (!live.length) return []
  const answered = new Set(live.map(message => message.replyToMessageId).filter(Boolean))
  return thread.messages.filter((message, index) => !isDeletedMessage(message) || index === 0 || answered.has(message.id))
}

/** Hosted editor contract: inline atom inside a paragraph, without child content.
 * { type: 'taskFile', attrs: { id, name, size, mediaType } } uses the inline upload
 * response (omit placement). Resolve bytes against the current task at display time. */
export const TASK_FILE_NODE = 'taskFile'
