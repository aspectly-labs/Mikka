'use client'

import { createContext, useContext, useEffect, useState, type ComponentType } from 'react'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { FileText, Folder, Image as ImageIcon, Maximize2, X } from '@/components/icons'
import type { PendingChatFile } from '@/components/chat/use-chat-files'
import { cn } from '@/lib/utils'
import { withBasePath } from '@/lib/base-path'
import { Button } from '@/components/ui/button'

/** One chip in the field: a file or folder, a collapsed paste, an image. The hosted layer draws it with BoardUI's Chip. */
export type ChatChipProps = {
  kind: 'file' | 'folder' | 'pasted' | 'image'
  label: string
  /** The whole name or text, on hover. */
  title?: string
  /** An image's preview. */
  thumbnail?: string
  /** 「上传中 40%」, or why it failed. */
  status?: string
  failed?: boolean
  selected: boolean
  actions: { id: 'expand' | 'remove'; label: string; onPress: () => void }[]
}

export type ChatChipRenderer = ComponentType<ChatChipProps>

type ChipSources = {
  Chip?: ChatChipRenderer
  pendingOf: (key: string) => PendingChatFile | null
  fileOf: (key: string) => { id: string; name: string } | null
}
export const ChatChipContext = createContext<ChipSources | null>(null)

const icons = { file: FileText, folder: Folder, pasted: FileText, image: ImageIcon } as const

/** Mikka's own chip, for the public build: BoardUI's tokens and type. */
export function DefaultChatChip({ kind, label, title, thumbnail, status, failed, selected, actions }: ChatChipProps) {
  const Icon = icons[kind]
  return <span title={title} data-chat-chip={kind} className={cn('mx-0.5 inline-flex max-w-64 items-center gap-1 rounded-md bg-background-secondary-default px-1.5 align-baseline text-caption-1-medium text-text-secondary',
    selected && 'ring-2 ring-border-focus-ring', failed && 'text-text-error-primary')}>
    {thumbnail ? <img src={thumbnail} alt="" className="size-4 rounded-sm object-cover" /> : <Icon aria-hidden="true" className="size-3.5 shrink-0 text-foreground-icon-tertiary" />}
    <span className="truncate">{label}</span>
    {status && <span className="shrink-0 text-text-tertiary">{status}</span>}
    {actions.map(action => <Button key={action.id} type="button" variant="ghost" size="icon-compact" aria-label={action.label} title={action.label} contentEditable={false}
      onMouseDown={event => event.preventDefault()} onClick={action.onPress} className="size-4 rounded-sm text-foreground-icon-tertiary">
      {action.id === 'expand' ? <Maximize2 aria-hidden="true" /> : <X aria-hidden="true" />}
    </Button>)}
  </span>
}

function useChip() {
  const sources = useContext(ChatChipContext)
  return { Chip: sources?.Chip ?? DefaultChatChip, sources }
}

export function SourceFileView({ node, deleteNode, selected }: NodeViewProps) {
  const t = useTranslations('ChatEditor')
  const { Chip } = useChip()
  const path = String(node.attrs.path)
  const folder = Boolean(node.attrs.folder)
  const name = path.split('/').filter(Boolean).at(-1) ?? path
  return <NodeViewWrapper as="span" className="inline">
    <Chip kind={folder ? 'folder' : 'file'} label={folder ? `${name}/` : name} title={path} selected={selected}
      actions={[{ id: 'remove', label: t('remove', { name }), onPress: deleteNode }]} />
  </NodeViewWrapper>
}

export function PastedView({ node, editor, getPos, deleteNode, selected, updateAttributes }: NodeViewProps) {
  const t = useTranslations('ChatEditor')
  const { Chip, sources } = useChip()
  const text = String(node.attrs.text)
  const key = node.attrs.fileKey ? String(node.attrs.fileKey) : null
  const pending = key ? sources?.pendingOf(key) : null
  const file = key ? sources?.fileOf(key) : null
  // A saved draft's paste is its attachment: read its text back once, for the size and for expanding.
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (text || !file || failed) return
    let current = true
    fetch(withBasePath(`/api/chat/attachments/${file.id}?download`), { credentials: 'same-origin' })
      .then(response => response.ok ? response.text() : Promise.reject(new Error(`attachment ${response.status}`)))
      .then(body => { if (current) updateAttributes({ text: body }) }, () => { if (current) setFailed(true) })
    return () => { current = false }
  }, [file?.id, text, failed]) // eslint-disable-line react-hooks/exhaustive-deps
  const lines = text.split('\n').length
  // Expanding puts the pasted text back in the field, as plain text (its attachment goes with the chip).
  const expand = () => {
    const at = typeof getPos === 'function' ? getPos() : undefined
    if (typeof at !== 'number' || !text) return
    editor.chain().focus().insertContentAt({ from: at, to: at + node.nodeSize }, text.split('\n').flatMap((line, index) =>
      [...index ? [{ type: 'hardBreak' }] : [], ...line ? [{ type: 'text', text: line }] : []])).run()
  }
  const status = pending ? pending.state === 'error' ? t('uploadFailed') : t('uploading', { percent: Math.min(99, pending.percent) }) : undefined
  return <NodeViewWrapper as="span" className="inline">
    <Chip kind="pasted" label={text ? t('pasted', { lines, chars: text.length }) : t('pastedFile')} title={text ? text.slice(0, 400) : file?.name} selected={selected}
      status={status} failed={pending?.state === 'error'}
      actions={[...text ? [{ id: 'expand' as const, label: t('expand'), onPress: expand }] : [], { id: 'remove', label: t('removePasted'), onPress: deleteNode }]} />
  </NodeViewWrapper>
}

export function ImageView({ node, deleteNode, selected }: NodeViewProps) {
  const t = useTranslations('ChatEditor')
  const { Chip, sources } = useChip()
  const key = String(node.attrs.fileKey ?? '')
  const pending = key ? sources?.pendingOf(key) : null
  const file = key ? sources?.fileOf(key) : null
  const name = String(node.attrs.alt || node.attrs.title || file?.name || t('image'))
  // The paste's own preview (a blob URL kept for undo; it goes with the page).
  const thumbnail = String(node.attrs.src ?? '')
  const status = pending ? pending.state === 'error' ? t('uploadFailed') : t('uploading', { percent: Math.min(99, pending.percent) }) : undefined
  return <NodeViewWrapper as="span" className="inline">
    <Chip kind="image" label={name} title={name} thumbnail={thumbnail || undefined} status={status} failed={pending?.state === 'error'} selected={selected}
      actions={[{ id: 'remove', label: t('remove', { name }), onPress: deleteNode }]} />
  </NodeViewWrapper>
}
