'use client'

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { toast } from 'sonner'
import { TEXT_ATTACHMENT_ACCEPT, textAttachment } from '@/lib/text-attachment'
import { MESSAGE_MAX } from '@/lib/message-limits'
import { sendsMessage } from '@/lib/send-key'
import { CHAT_FILE_ACCEPT } from '@mikka/protocol/chat-attachments'
import { useChatFiles } from '@/components/chat/use-chat-files'
import type { ChatComposerInput, ChatComposerProps } from '@/components/slots/chat-composer-contract'
import { useViewState } from '@/lib/hooks/view-state'
import { rememberPrompt } from '@/lib/chat/prompt-history'
import { useComposerReferences } from '@/hooks/use-composer-references'

/** The default slot's field is a textarea; the hosted one is the chat editor, which handles its own caret and size. */
const textareaOf = (node: ChatComposerInput | null) => (node as HTMLElement | null)?.tagName === 'TEXTAREA' ? node as HTMLTextAreaElement : null

/**
 * Everything a chat composer does, for the chat-composer slot to draw
 * (docs/ui-overlay.md): the draft, its attachments, the send key, Esc to stop,
 * drop and paste, the length limit. The default slot and the hosted layer both
 * call it, so the two composers cannot behave differently.
 */
export function useChatComposer({ ref, value, onChange, onSubmit, sending = false, running = false, editableWhileSending = false, submitDisabled = false, disabled = false, onStop, sendKey = 'enter', thread = false, attachmentScope, attachmentDisabled = false, references: referenceScope, commands, people, historyKey }: ChatComposerProps) {
  const tShell = useTranslations('Shell')
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<ChatComposerInput | null>(null)
  const fileId = useId()
  const attachDisabled = sending || disabled || attachmentDisabled
  const files = useChatFiles(value, onChange, attachmentScope, attachDisabled, tShell)
  const stoppable = !!onStop && (sending || (running && !value.trim()))
  const canSend = !sending && !submitDisabled && !disabled && !files.locked && !!value.trim()
  const references = useComposerReferences({ stored: files.text, setStored: files.edit, input: () => textareaOf(inputRef.current),
    workspaceId: referenceScope?.workspaceId, commands, disabled: disabled || (sending && !editableWhileSending && !onStop) })

  // The person's earlier prompts here, newest last; kept with the drafts (lib/hooks/view-state.tsx), cleared on logout.
  const [history, setHistory] = useViewState<string[]>(historyKey ? `${historyKey}:history` : 'composer:history:none', [])
  // Images drawn in the field as chips (the chat editor): the attachment strip leaves them out while they upload fine.
  const [inline, setInlineState] = useState<string[]>([])
  const setInline = useCallback((keys: string[]) => setInlineState(previous => previous.length === keys.length && previous.every((key, index) => key === keys[index]) ? previous : keys), [])
  const inlineIds = new Set(inline.flatMap(key => [key, files.idOf(key) ?? key]))

  const setInput = (node: ChatComposerInput | null) => {
    inputRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

  // Browsers without `field-sizing: content` get the same one-line-to-max-height growth from scrollHeight,
  // so the draft never scrolls sideways.
  useEffect(() => {
    const input = textareaOf(inputRef.current)
    if (!input) return
    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')) return
    input.style.height = 'auto'
    const max = Number.parseFloat(getComputedStyle(input).maxHeight)
    const height = Number.isFinite(max) ? Math.min(input.scrollHeight, max) : input.scrollHeight
    input.style.height = `${height}px`
    input.style.overflowX = 'hidden'
    input.style.overflowY = input.scrollHeight > height ? 'auto' : 'hidden'
  }, [value])

  async function attachText(items: File[]) {
    if (sending || disabled || !items.length) return
    let next = value
    for (const file of items) {
      const block = await textAttachment(file, MESSAGE_MAX - next.length - 2)
      if (!block) { toast.error(tShell('attachUnsupported', { max: MESSAGE_MAX })); continue }
      next = next.trim() ? `${next.trimEnd()}\n\n${block}` : block
    }
    onChange(next)
    inputRef.current?.focus()
  }

  /** Files from the picker, a drop or a paste: uploaded as chat files where the chat takes them, otherwise read in as text. */
  function addFiles(items: File[]) {
    if (attachDisabled) return []
    if (attachmentScope) return files.add(items)
    void attachText(items)
    return []
  }

  function submit() {
    if (!canSend) return
    if (historyKey) setHistory(previous => rememberPrompt(previous, files.text))
    onSubmit()
  }

  return {
    /** The draft as the textarea shows it: attached files' markers are kept out of it, and each reference shows as its name. */
    text: references.text,
    edit: references.edit,
    /** Each reference's place in `text`, for the field to draw as a chip. */
    referenceTokens: references.tokens,
    /** The `/` command or reference menu while one is open. */
    suggestions: references.suggestions,
    /** The ＋ menu's Reference rows: start a search of one kind at the caret. */
    startReference: referenceScope ? references.startReference : undefined,
    /** The textarea's maxLength, so the whole message, file and reference markers included, stays within the limit. */
    maxLength: MESSAGE_MAX - (value.length - references.text.length),
    /** Show `count / max` only when it is close enough to matter. */
    length: value.length > MESSAGE_MAX - 500 ? { count: value.length, max: MESSAGE_MAX } : null,
    files: files.files,
    pending: files.pending,
    /** The attachment strip's files: all but the images the field draws as chips (a failed upload stays, with its retry). */
    strip: {
      files: files.files.filter(file => !inlineIds.has(file.id)),
      pending: files.pending.filter(item => item.state === 'error' || !inlineIds.has(item.key)),
    },
    /**
     * What the chat editor (components/chat/chat-editor) binds to: the stored draft (file markers kept out), the
     * sources its `@`, `/` and `$` menus read, the person's earlier prompts, and the files it draws inline.
     */
    field: {
      stored: files.text,
      setStored: files.edit,
      /** The longest the stored draft may grow: the message limit less its file markers. */
      maxLength: MESSAGE_MAX - (value.length - files.text.length),
      disabled,
      history,
      workspaceId: referenceScope?.workspaceId,
      runId: referenceScope?.runId,
      commands,
      people,
      sendKey,
      thread,
      addFiles,
      takesFiles: !!attachmentScope,
      setInline,
      fileOf: (key: string) => files.files.find(file => file.id === (files.idOf(key) ?? key)) ?? null,
      pendingOf: (key: string) => files.pending.find(item => item.key === key) ?? null,
    },
    removeFile: files.remove,
    retryFile: files.retry,
    /** The button shows stop instead of send. */
    stoppable,
    stop: onStop,
    canSend,
    submit,
    /** The textarea cannot be edited (a reply is on its way and cannot be stopped). Not disabled, so focus stays. */
    readOnly: sending && !onStop && !editableWhileSending,
    attachDisabled,
    /** The hidden file input the attach button opens. */
    fileInput: { ref: fileRef, id: fileId, accept: attachmentScope ? CHAT_FILE_ACCEPT : TEXT_ATTACHMENT_ACCEPT, onFiles: (list: FileList | null) => addFiles(Array.from(list ?? [])) },
    openFilePicker: () => fileRef.current?.click(),
    inputRef: setInput,
    onSubmit: (event: FormEvent) => { event.preventDefault(); submit() },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      const { key, shiftKey, metaKey, ctrlKey } = event
      if (references.onKeyDown(event)) return
      // In a bot chat Esc stops the reply, as the stop button does.
      if (key === 'Escape' && stoppable && !thread && !event.nativeEvent.isComposing) { event.preventDefault(); onStop?.(); return }
      if (!sendsMessage({ key, shiftKey, metaKey, ctrlKey, isComposing: event.nativeEvent.isComposing }, sendKey)) return
      event.preventDefault()
      submit()
    },
    onDragOver(event: DragEvent) {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = attachDisabled ? 'none' : 'copy'
    },
    onDrop(event: DragEvent) {
      // The chat editor took it already (its file handler).
      if (event.defaultPrevented) return
      const dropped = Array.from(event.dataTransfer.files)
      if (!dropped.length) return
      event.preventDefault()
      event.stopPropagation()
      addFiles(dropped)
    },
    onPaste(event: ClipboardEvent) {
      if (event.defaultPrevented) return
      const pasted = Array.from(event.clipboardData.files)
      if (!pasted.length) return
      event.preventDefault()
      event.stopPropagation()
      addFiles(pasted)
    },
  }
}

export type ChatComposerState = ReturnType<typeof useChatComposer>

/** Caller-supplied controls share the rendered composer's existing commands. */
export const ChatComposerStateContext = createContext<ChatComposerState | null>(null)

export function useChatComposerState() {
  const state = useContext(ChatComposerStateContext)
  if (!state) throw new Error('Chat composer controls require a composer')
  return state
}
