'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EditorContent, ReactNodeViewRenderer, useEditor, type Editor } from '@tiptap/react'
import { FileHandler } from '@tiptap/extension-file-handler'
import { PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { exitSuggestion, type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { findThreadReferences } from '@/app/actions/task-runs'
import { chipLabel } from '@/hooks/use-composer-references'
import type { ChatComposerState } from '@/hooks/use-chat-composer'
import { useThreadWorkspace } from '@/hooks/use-thread-workspace'
import { referenceQueryReady, type ThreadReference } from '@/lib/thread-references'
import { referenceKey, type MessageReference, type ReferenceType } from '@/lib/composer-references'
import { searchFiles } from '@/lib/right-column/workspace-files'
import { sendsMessage } from '@/lib/send-key'
import { stepPrompt } from '@/lib/chat/prompt-history'
import { touchKeyboard } from '@/lib/touch-keyboard'
import { withBasePath } from '@/lib/base-path'
import { chatEditorSchemaExtensions } from './schema'
import { docToStored, isLongPaste, storedToDoc, type ChipKind, type JSONNode, type MentionAttrs } from './serialize'
import { ChatChipContext, ImageView, PastedView, SourceFileView, type ChatChipRenderer } from './chips'

/** A row of the `@`, `/` or `$` menu. */
export type ChatMenuRowKind = 'command' | ChipKind | 'file' | 'folder'
export type ChatMenuRow = { id: string; label: string; description?: string; kind: ChatMenuRowKind }
export type ChatEditorMenu = {
  label: string
  sections: { title: string; rows: ChatMenuRow[] }[]
  /** Searching, nothing found or the search failed: one line instead of rows. */
  status?: string
  active: number
  pick: (id: string) => void
  close: () => void
}

type Char = '@' | '/' | '$'
type Trigger = { char: Char; query: string; command: (item: Pick) => void }
/** What a picked row puts in the field, or runs. */
type Pick =
  | { type: 'mention'; attrs: MentionAttrs }
  | { type: 'sourceFile'; attrs: { path: string; folder: boolean } }
  | { type: 'run'; run: () => void }
type Row = ChatMenuRow & { pick: Pick }
type Skill = { id: string; name: string; slug: string; enabled: boolean }

const KINDED = /^(task|thread|pr|file|folder):(.*)$/s

/** The skills the person has installed and switched on (`/api/skills`), read when a `/` or `$` menu first opens. */
async function readSkills(): Promise<Skill[]> {
  const response = await fetch(withBasePath('/api/skills'), { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error(`skills ${response.status}`)
  const body = await response.json() as { skills?: Skill[] }
  return (body.skills ?? []).filter(skill => skill.enabled)
}

/**
 * The chat composer's field as a TipTap editor (decision: one editor engine, TipTap; Alex 2026-11-22): plain text
 * and atomic chips, serialised to the stored string the textarea wrote (./serialize.ts), with `@` references,
 * people, Bots, files and folders, `/` commands and skills, `$` skills, a long paste collapsed, pasted and dropped
 * images inline, Up to recall an earlier prompt, and the send key (never while an IME composes; Enter is a new
 * line on a touch keyboard). `field` goes where the composer's textarea was; `menu` is drawn by the composer's
 * own suggestion menu.
 */
export function useChatEditor(composer: ChatComposerState, options: {
  label: string
  placeholder?: string
  /** The class the field draws with, so it keeps the composer's own type, size and scroll. */
  className?: string
  /** The class a reference chip draws with (the composer's link-coloured words). */
  referenceClass?: string
  /** Choosing a chat focuses its composer (hooks/use-focus-return.ts). */
  primaryChat?: boolean
  disabled?: boolean
  Chip?: ChatChipRenderer
}) {
  const t = useTranslations('ChatEditor')
  const tReferences = useTranslations('ThreadReferences')
  const field = composer.field
  const live = useRef({ composer, options })
  live.current = { composer, options }
  const names = useRef(new Map<string, string>())
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const triggerRef = useRef(trigger)
  triggerRef.current = trigger
  const [active, setActive] = useState(0)
  const keys = useMemo(() => ({ '@': new PluginKey('chatMentionAt'), '/': new PluginKey('chatMentionSlash'), '$': new PluginKey('chatMentionSkill') }), [])
  // The menu's rows and the picked row for the plugin's key handler, which runs outside React's render.
  const menuRows = useRef<Row[]>([])
  const menuActive = useRef(0)
  const hydrate = useRef<(stored: string) => JSONNode>(() => ({ type: 'doc', content: [{ type: 'paragraph' }] }))
  const emitted = useRef(field.stored)
  const recall = useRef<{ at: number | null; draft: string }>({ at: null, draft: '' })

  const skillsWanted = !!field.commands?.length
  const skills = useSWR(skillsWanted && trigger && trigger.char !== '@' ? ['personal-skills'] : null, readSkills, { revalidateOnFocus: false, shouldRetryOnError: false })

  hydrate.current = stored => storedToDoc(stored, {
    // A reference this composer has not looked up (a saved draft): its kind and short id, as the textarea showed it.
    label: (reference: MessageReference) => names.current.get(referenceKey(reference))
      ?? (reference.type === 'pr' ? undefined : `${tReferences(reference.type === 'chat' ? 'thread' : reference.type)} ${reference.id.slice(0, 8)}`),
    people: field.people,
    skills: skills.data?.map(skill => ({ slug: skill.slug, name: skill.name })),
    files: !!field.runId,
  })

  const suggestion = (char: Char) => ({
    char,
    pluginKey: keys[char],
    // `/` only opens a line that starts the message, as the textarea's command menu did.
    ...(char === '/' ? { startOfLine: true, allow: ({ range }: { range: { from: number } }) => range.from <= 1 && (!!live.current.composer.field.commands?.length) } : {}),
    ...(char === '$' ? { allow: () => !!live.current.composer.field.commands?.length } : {}),
    ...(char === '@' ? { allow: () => { const current = live.current.composer.field; return !!(current.workspaceId || current.people?.length || current.runId) } } : {}),
    items: () => [],
    command: ({ editor, range, props }: { editor: Editor; range: { from: number; to: number }; props: Pick }) => {
      if (props.type === 'run') {
        editor.chain().deleteRange(range).run()
        props.run()
        return
      }
      const after = editor.state.doc.resolve(range.to).nodeAfter
      const to = after?.isText && after.text?.startsWith(' ') ? range.to + 1 : range.to
      editor.chain().focus().insertContentAt({ from: range.from, to }, [
        props.type === 'mention' ? { type: 'mention', attrs: { ...props.attrs, mentionSuggestionChar: char } } : { type: 'sourceFile', attrs: props.attrs },
        { type: 'text', text: ' ' },
      ]).run()
    },
    render: () => ({
      onStart: (props: SuggestionProps<unknown, Pick>) => { setActive(0); setTrigger({ char, query: props.query, command: props.command }) },
      onUpdate: (props: SuggestionProps<unknown, Pick>) => setTrigger(previous => previous?.char === char && previous.query === props.query ? previous : { char, query: props.query, command: props.command }),
      onExit: () => setTrigger(previous => previous?.char === char ? null : previous),
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (event.isComposing) return false
        const rows = menuRows.current
        if (event.key === 'Escape') return true
        if (!rows.length) return false
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          setActive(index => (index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
          return true
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
          pickRow(rows[Math.min(menuActive.current, rows.length - 1)])
          return true
        }
        return false
      },
    }),
  })

  function handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
    const { composer: current } = live.current
    // An IME is composing: its Enter confirms the word, never sends (Safari reports keyCode 229 after composition ends).
    if (view.composing) return false
    // The key still says it composes (Firefox's confirming Enter, Safari's late 229): it is the IME's, neither a send nor a new line.
    if (event.isComposing || event.keyCode === 229) return event.key === 'Enter'
    const menuOpen = !!triggerRef.current
    if (menuOpen && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Escape' || event.key === 'Tab')) return false
    if (menuOpen && event.key === 'Enter' && menuRows.current.length) return false
    if (event.key === 'Enter') {
      const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
      // A touch keyboard has no Shift+Enter: Enter is a new line and Send stays the button.
      if (plain && touchKeyboard()) return false
      if (!sendsMessage({ key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, isComposing: false }, current.field.sendKey)) return false
      event.preventDefault()
      current.submit()
      return true
    }
    // Esc stops whatever answers, in every chat, also with words typed (decision 2026-11-22-1600, as Claude Code and Codex).
    if (event.key === 'Escape' && current.escapeStops) { event.preventDefault(); current.stop?.(); return true }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const stored = current.field.stored
      const recalling = recall.current.at !== null && stored === current.field.history[recall.current.at]
      if (!recalling) recall.current.at = null
      // Up in an empty field, or on the first line of a recalled prompt; Down on the last line of one.
      const { selection, doc } = view.state
      if (event.key === 'ArrowUp' && !(stored === '' || (recalling && selection.$from.index(0) === 0))) return false
      if (event.key === 'ArrowDown' && !(recalling && selection.$to.index(0) === doc.childCount - 1)) return false
      const next = stepPrompt(current.field.history, recall.current.at, event.key === 'ArrowUp' ? 'older' : 'newer')
      if (next === undefined) return false
      if (recall.current.at === null) recall.current.draft = stored
      recall.current.at = next
      event.preventDefault()
      current.field.setStored(next === null ? recall.current.draft : current.field.history[next])
      return true
    }
    return false
  }

  const keyHandler = useRef(handleKeyDown)
  keyHandler.current = handleKeyDown
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      ...chatEditorSchemaExtensions({
        placeholder: () => live.current.options.placeholder ?? '',
        referenceClass: options.referenceClass,
        suggestions: [suggestion('@'), suggestion('/'), suggestion('$')],
        maxLength: () => live.current.composer.field.maxLength,
        views: { sourceFile: SourceFileView, pasted: PastedView, image: ImageView, render: component => ReactNodeViewRenderer(component as Parameters<typeof ReactNodeViewRenderer>[0]) },
        extra: [FileHandler.configure({
          consumePasteEvent: true,
          onPaste: (current, files) => addFiles(current, files, null),
          onDrop: (current, files, at) => addFiles(current, files, at),
        })],
      }),
    ],
    content: hydrate.current(field.stored),
    editorProps: {
      attributes: { class: options.className ?? '', role: 'textbox', 'aria-multiline': 'true', dir: 'auto', spellcheck: 'false' },
      handleKeyDown: (view, event) => keyHandler.current(view, event),
      // A long paste goes in as one chip; files are the file handler's.
      handlePaste: (view, event) => {
        if (event.clipboardData?.files.length) return false
        const text = event.clipboardData?.getData('text/plain') ?? ''
        if (!isLongPaste(text)) return false
        event.preventDefault()
        const { from, to } = view.state.selection
        const pasted = view.state.schema.nodes.pasted.create({ text })
        view.dispatch(view.state.tr.replaceWith(from, to, pasted).scrollIntoView())
        return true
      },
    },
    onUpdate: ({ editor: current }) => {
      const stored = docToStored(current.getJSON() as JSONNode)
      reportImages(current)
      if (stored === emitted.current) return
      emitted.current = stored
      live.current.composer.field.setStored(stored)
    },
  }, [])

  // Pasted or dropped files: uploaded as chat files where the chat takes them, each image drawn where it went in.
  function addFiles(current: Editor, files: File[], at: number | null) {
    const added = live.current.composer.field.addFiles(files)
    const images = added.filter(item => !item.error && item.file.type.startsWith('image/'))
    if (!images.length) return
    const nodes = images.flatMap(item => [{ type: 'image', attrs: { src: URL.createObjectURL(item.file), alt: item.file.name, fileKey: item.key } }, { type: 'text', text: ' ' }])
    const chain = current.chain().focus()
    if (at === null) chain.insertContent(nodes).run()
    else chain.insertContentAt(at, nodes).run()
  }

  // The images drawn inline: the strip leaves them out; one removed from the field is removed from the message.
  const shownImages = useRef<string[]>([])
  function reportImages(current: Editor) {
    const keys: string[] = []
    current.state.doc.descendants(node => { if (node.type.name === 'image' && node.attrs.fileKey) keys.push(String(node.attrs.fileKey)) })
    const { field: currentField, removeFile } = live.current.composer
    for (const key of shownImages.current) if (!keys.includes(key)) void removeFile(currentField.fileOf(key)?.id ?? key)
    shownImages.current = keys
    currentField.setInline(keys)
  }

  // A draft that changes from outside (sent and cleared, a recalled prompt, a starter's sentence, a scope change).
  useEffect(() => {
    if (!editor || field.stored === emitted.current) return
    emitted.current = field.stored
    const focused = editor.isFocused
    editor.commands.setContent(hydrate.current(field.stored), { emitUpdate: false })
    // The stored draft carries no inline images: any still attached go back to the strip, never out of the message.
    shownImages.current = []
    field.setInline([])
    if (focused) editor.commands.focus('end')
  }, [editor, field.stored]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reads, callers and the composer's own frame focus the field through the same handle the textarea gave.
  useEffect(() => {
    if (!editor) return
    composer.inputRef({
      focus: () => { editor.commands.focus('end', { scrollIntoView: false }) },
      setSelectionRange: () => { editor.commands.focus('end') },
    })
    return () => composer.inputRef(null)
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  const editable = !composer.readOnly && !options.disabled
  useEffect(() => { if (editor && editor.isEditable !== editable) editor.setEditable(editable, false) }, [editor, editable])

  // The field's name, state and menu for assistive technology, and the hook the focus helpers find it by.
  useEffect(() => {
    const dom = editor?.view.dom
    if (!dom) return
    const set = (name: string, value: string | null) => value === null ? dom.removeAttribute(name) : dom.setAttribute(name, value)
    set('aria-label', options.label)
    set('aria-disabled', options.disabled ? 'true' : null)
    set('aria-readonly', composer.readOnly ? 'true' : null)
    set('aria-autocomplete', 'list')
    set('aria-expanded', trigger ? 'true' : 'false')
    set('data-chat-composer', options.primaryChat ? '' : null)
  }, [editor, options.label, options.disabled, options.primaryChat, composer.readOnly, trigger])

  // ---- The menu's rows ----
  const parsed = trigger?.char === '@' ? KINDED.exec(trigger.query) : null
  const kind = (parsed?.[1] ?? null) as ThreadReference['kind'] | 'file' | 'folder' | null
  const query = parsed ? parsed[2] : trigger?.query ?? ''
  const referencesWanted = trigger?.char === '@' && !!field.workspaceId && (kind === null || kind === 'task' || kind === 'thread' || kind === 'pr') && referenceQueryReady(query)
  const filesWanted = trigger?.char === '@' && !!field.runId && (kind === null || kind === 'file' || kind === 'folder') && (query.length > 0 || kind !== null)
  const references = useLookup(referencesWanted ? JSON.stringify([field.workspaceId, kind, query]) : null,
    () => kind && kind !== 'file' && kind !== 'folder' ? findThreadReferences(field.workspaceId!, query, kind) : findThreadReferences(field.workspaceId!, query))
  const workspace = useThreadWorkspace(filesWanted ? field.runId! : null)
  const checkout = workspace.data?.checkout
  const files = useLookup(filesWanted && checkout ? JSON.stringify([checkout.runId, checkout.repoId, query]) : null,
    () => searchFiles({ runId: checkout!.runId, repoId: checkout!.repoId, workspaceId: workspace.data!.workspaceId }, query || '.'))

  const sections: { title: string; rows: Row[] }[] = []
  const lower = query.toLowerCase()
  if (trigger?.char === '@') {
    if (kind === null) for (const group of ['person', 'bot'] as const) {
      const rows = (field.people ?? []).filter(person => person.kind === group && person.name.toLowerCase().includes(lower)).slice(0, 8)
        .map(person => ({ id: `${group}:${person.id}`, label: person.name, kind: group, pick: { type: 'mention' as const, attrs: { id: person.id, label: person.name, kind: group } } }))
      if (rows.length) sections.push({ title: t(group === 'person' ? 'people' : 'bots'), rows })
    }
    if (referencesWanted && references.items) for (const group of ['task', 'thread', 'pr'] as const) {
      const rows = (references.items as ThreadReference[]).filter(item => item.kind === group).map(item => {
        const type: ReferenceType = item.kind === 'thread' && item.conversationKind === 'chat' ? 'chat' : item.kind
        return { id: `${type}:${item.id}`, label: item.title, kind: type, pick: { type: 'mention' as const, attrs: { id: item.id, label: chipLabel(item), kind: type } } }
      })
      if (rows.length) sections.push({ title: tReferences(group === 'task' ? 'tasks' : group === 'thread' ? 'threads' : 'pullRequests'), rows })
    }
    if (filesWanted && files.items) {
      const rows = (files.items as Awaited<ReturnType<typeof searchFiles>>).filter(entry => kind === null || (kind === 'folder') === (entry.kind === 'directory')).slice(0, 20)
        .map(entry => ({ id: `${entry.kind}:${entry.path}`, label: entry.path, kind: entry.kind === 'directory' ? 'folder' as const : 'file' as const,
          pick: { type: 'sourceFile' as const, attrs: { path: entry.path, folder: entry.kind === 'directory' } } }))
      if (rows.length) sections.push({ title: t('files'), rows })
    }
  }
  if (trigger?.char === '/') {
    const rows = (field.commands ?? []).filter(command => command.name.slice(1).toLowerCase().startsWith(lower))
      .map(command => ({ id: `command:${command.id}`, label: command.name, description: command.description, kind: 'command' as const,
        pick: { type: 'run' as const, run: () => { live.current.composer.field.setStored(''); command.run() } } }))
    if (rows.length) sections.push({ title: tReferences('commands'), rows })
  }
  if (trigger && trigger.char !== '@' && skills.data) {
    const rows = skills.data.filter(skill => skill.slug.toLowerCase().includes(lower) || skill.name.toLowerCase().includes(lower)).slice(0, 12)
      .map(skill => ({ id: `skill:${skill.slug}`, label: trigger.char === '$' ? `$${skill.slug}` : `/${skill.slug}`, description: skill.name, kind: 'skill' as const,
        pick: { type: 'mention' as const, attrs: { id: skill.slug, label: skill.name, kind: 'skill' as const } } }))
    if (rows.length) sections.push({ title: t('skills'), rows })
  }
  const rows = sections.flatMap(section => section.rows)
  menuRows.current = rows
  const searching = (referencesWanted && references.loading) || (filesWanted && (workspace.loading || files.loading)) || (skillsWanted && trigger?.char !== '@' && !skills.data && !skills.error)
  const failed = (referencesWanted && references.failed) || (filesWanted && (files.failed || !!workspace.error)) || (!!trigger && trigger.char !== '@' && !!skills.error)
  const status = rows.length ? undefined : searching ? tReferences('searching') : failed ? tReferences('error') : tReferences('empty')
  const shown = Math.min(active, Math.max(0, rows.length - 1))
  menuActive.current = shown

  function pickRow(row: Row | undefined) {
    const trigger = triggerRef.current
    if (!row || !trigger) return
    if (row.pick.type === 'mention' && (row.kind === 'task' || row.kind === 'thread' || row.kind === 'chat' || row.kind === 'pr'))
      names.current.set(referenceKey({ type: row.kind, id: row.pick.attrs.id }), row.pick.attrs.label)
    trigger.command(row.pick)
  }

  // An empty `@` with nothing to offer yet (no people, a search not ready) draws no menu, as before.
  const open = !!trigger && (rows.length > 0 || searching || (trigger.char === '@' ? referencesWanted || filesWanted : false))
  const menu: ChatEditorMenu | null = open && trigger ? {
    label: trigger.char === '@' ? tReferences('references') : trigger.char === '/' ? tReferences('commands') : t('skills'),
    sections: sections.map(section => ({ title: section.title, rows: section.rows.map(({ pick: _pick, ...row }) => row) })),
    status,
    active: shown,
    pick: id => pickRow(rows.find(row => row.id === id)),
    close: () => { if (editor) exitSuggestion(editor.view, keys[trigger.char]) },
  } : null

  const fieldNode: ReactNode = <ChatChipContext value={{ Chip: options.Chip, pendingOf: field.pendingOf, fileOf: field.fileOf }}>
    <EditorContent editor={editor} className="contents" />
  </ChatChipContext>

  return {
    editor, field: fieldNode, menu,
    focus: () => { editor?.commands.focus('end') },
    /** The ＋ menu's Reference rows start a search of one kind where the caret is (`@task:`). */
    startReference(kind: ThreadReference['kind']) {
      if (!editor) return
      const before = editor.state.doc.textBetween(Math.max(0, editor.state.selection.from - 1), editor.state.selection.from, '\n', ' ')
      editor.chain().focus().insertContent(`${before && !/\s/.test(before) ? ' ' : ''}@${kind}:`).run()
    },
  }
}

/** One debounced search; its last results stay while the next run, so a growing query never blinks to 「正在搜索」. */
function useLookup<T>(signature: string | null, read: () => Promise<T[]>) {
  const [state, setState] = useState<{ signature: string; items?: T[]; failed?: boolean } | null>(null)
  const reader = useRef(read)
  reader.current = read
  useEffect(() => {
    if (!signature) return
    let current = true
    const timer = setTimeout(async () => {
      try {
        const items = await reader.current()
        if (current) setState({ signature, items })
      } catch { if (current) setState({ signature, failed: true }) }
    }, 180)
    return () => { current = false; clearTimeout(timer) }
  }, [signature])
  if (!signature) return { items: undefined, loading: false, failed: false }
  return { items: state?.items, loading: state?.signature !== signature, failed: state?.signature === signature && !!state.failed }
}
