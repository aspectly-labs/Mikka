export interface ThreadMessage {
  id: string
  author: string
  authorUserId?: string
  /** Identifies a specific comment when multiple Factory stages share the same thread. */
  replyToMessageId?: string
  body: string
  at: string
  /** When its author last changed the body or files; the server stamps it (lib/task-comments/authorship.ts). */
  editedAt?: string
  /** A deleted message keeps its place (empty body, no files) while its thread has replies; the server stamps both. */
  deletedAt?: string
  deletedBy?: string
  /** Inline task files the message shows (lib/task-comments/contract.ts). */
  attachments?: { id: string; name: string; size: number; mediaType: string | null }[]
}

export interface ThreadRecord {
  id: string
  author: string
  createdAt: string
  resolved: boolean
  messages: ThreadMessage[]
}
