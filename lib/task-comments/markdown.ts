import type { JSONContent } from '@tiptap/core'

/** Backslash-escape inline Markdown syntax so plain text stays text. */
export function escapeMarkdown(value: string) {
  return value.replace(/([\\`*_{}[\]<>])/g, '\\$1')
}

function textToMarkdown(node: JSONContent): string {
  let value = escapeMarkdown(node.text ?? '')
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') value = `**${value}**`
    else if (mark.type === 'italic') value = `*${value}*`
    else if (mark.type === 'strike') value = `~~${value}~~`
    else if (mark.type === 'code') value = `\`${node.text ?? ''}\``
    else if (mark.type === 'link' && typeof mark.attrs?.href === 'string' && /^(https?:|mailto:)/i.test(mark.attrs.href)) value = `[${value}](${mark.attrs.href})`
  }
  return value
}

function listMarkdown(node: JSONContent, inline: (child: JSONContent) => string, depth = 0): string {
  const ordered = node.type === 'orderedList'
  const start = Number(node.attrs?.start) || 1
  return (node.content ?? []).map((item, index) => {
    const prefix = ordered ? `${start + index}. ` : '- '
    const first = (item.content ?? []).find(child => child.type === 'paragraph')
    const text = (first?.content ?? []).map(inline).join('')
    const nested = (item.content ?? []).filter(child => child.type === 'bulletList' || child.type === 'orderedList').map(child => listMarkdown(child, inline, depth + 1)).join('\n')
    const pad = '  '.repeat(depth)
    return `${pad}${prefix}${text}${nested ? `\n${nested}` : ''}`
  }).join('\n')
}

export function issueContentToMarkdown(doc: JSONContent | null | undefined, options: { mentionLabels?: boolean } = {}) {
  if (!doc) return ''
  function inline(node: JSONContent): string {
    if (node.type === 'hardBreak') return '  \n'
    if (node.type === 'text') return textToMarkdown(node)
    if (node.type === 'mention' && options.mentionLabels && typeof node.attrs?.label === 'string') {
      const label = node.attrs.label.trim().replace(/\s+/g, ' ')
      return label ? `@${escapeMarkdown(label)}` : ''
    }
    return (node.content ?? []).map(inline).join('')
  }
  return (doc.content ?? []).map(node => {
    if (node.type === 'heading') return `${'#'.repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${(node.content ?? []).map(inline).join('')}`
    if (node.type === 'bulletList' || node.type === 'orderedList') return listMarkdown(node, inline)
    if (node.type === 'taskList') return (node.content ?? []).map(item => `- [${item.attrs?.checked ? 'x' : ' '}] ${(item.content ?? []).flatMap(child => child.content ?? []).map(inline).join('')}`).join('\n')
    if (node.type === 'codeBlock') return `\`\`\`${typeof node.attrs?.language === 'string' ? node.attrs.language : ''}\n${(node.content ?? []).map(item => item.text ?? '').join('')}\n\`\`\``
    if (node.type === 'blockquote') return (node.content ?? []).map(child => (child.content ?? []).map(inline).join('')).join('\n').split('\n').map(line => `> ${line}`).join('\n')
    if (node.type === 'horizontalRule') return '---'
    return (node.content ?? []).map(inline).join('')
  }).filter(Boolean).join('\n\n')
}
