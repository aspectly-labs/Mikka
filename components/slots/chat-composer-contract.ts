// What the chat-composer slot receives (docs/ui-overlay.md). What it does comes
// from hooks/use-chat-composer.ts, which every implementation calls.
import type { ReactNode, Ref } from 'react'
import type { SendKey } from '@/lib/send-key'
import type { ChatFileScope } from '@mikka/protocol/chat-attachments'

/** What a caller may do with the composer's field: a textarea in the default slot, the chat editor in the hosted one. */
export type ChatComposerInput = { focus(options?: FocusOptions): void; setSelectionRange?(start: number, end: number): void }

export type ChatComposerProps = {
  ref: Ref<ChatComposerInput | null>
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  label: string
  placeholder?: string
  /** Waiting for a reply. With `onStop`, the send button turns into stop. */
  sending?: boolean
  /** The other side keeps working and still takes messages. With `onStop`, the button is stop until something is typed. */
  running?: boolean
  /** Keep the draft editable while a thread waits for its stop acknowledgement. */
  editableWhileSending?: boolean
  /** The draft remains editable, but the run no longer accepts new messages. */
  submitDisabled?: boolean
  /** The conversation takes no messages at all (a group chat that failed to load): nothing can be typed, attached or sent. */
  disabled?: boolean
  onStop?: () => void
  /** Something quoted into the message (an artifact quote chip): it sits on top, the buttons move to a row below. */
  quote?: ReactNode
  /** Controls at the presentation's existing leading position, such as its attachment menu. */
  leadingControls?: ReactNode
  /** Controls before the send action, such as model and effort; each presentation keeps their existing position. */
  leftControls?: ReactNode
  /** Caller-owned content below the input. An absent footer adds no wrapper or space. */
  footer?: ReactNode
  /** The person's send key (偏好设置); the caller reads it from their preferences. */
  sendKey?: SendKey
  /** A thread's composer, not a bot chat's: choosing a chat focuses only the latter, and Esc never stops the run (decision 2026-11-02-0301). */
  thread?: boolean
  attachmentScope?: ChatFileScope
  /** Keep a saved draft editable while blocking new files. */
  attachmentDisabled?: boolean
  /**
   * Typed references (#2924): the workspace whose tasks, threads and pull requests `@`
   * and the ＋ menu's Reference rows search. A reference shows as one chip in the draft
   * and is sent as its marker (lib/composer-references.ts). Absent: no references.
   */
  references?: {
    workspaceId: string
    /** The thread's run: `@` also searches its workspace's files and folders (`/api/runs/:id/workspace/files`). */
    runId?: string
  }
  /** The people and Bots `@` can name (a group chat's members); a chip is sent as `@Name` (lib/group-mentions.ts). */
  people?: readonly { id: string; name: string; kind: 'person' | 'bot' }[]
  /** Where the person's earlier prompts are kept (a thread's or chat's own key): Up in an empty composer recalls them. */
  historyKey?: string
  /** The `/` commands this chat can run; only commands with a working action are listed. */
  commands?: ChatComposerCommand[]
}

export type ChatComposerCommand = { id: string; name: string; description: string; run: () => void }
