import { Extension, mergeAttributes, Node, type AnyExtension, type NodeViewRenderer } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { Mention } from '@tiptap/extension-mention'
import { Image } from '@tiptap/extension-image'
import { Placeholder } from '@tiptap/extensions'
import type { SuggestionOptions } from '@tiptap/suggestion'
import type { NodeViewProps } from '@tiptap/react'
import type { ComponentType } from 'react'
import { chipText, docToStored, sourceText, type JSONNode, type MentionAttrs } from './serialize'

/**
 * The chat composer's minimal schema: paragraphs of plain text, hard breaks and
 * undo, plus atomic inline chips. No marks: a chat message is plain text and
 * chips, as Capy's and Claude Code's. One TipTap engine for the whole app
 * (the issue editor uses the same packages).
 */

/** The `@` / `/` / `$` chip: the official Mention node, with what it names. */
export const ChatMention = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      kind: { default: 'task', parseHTML: element => element.getAttribute('data-kind'), renderHTML: attributes => ({ 'data-kind': attributes.kind }) },
    }
  },
})

/** A file or folder in the run's workspace, `@path`. */
export const SourceFile = Node.create({
  name: 'sourceFile',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { path: { default: '' }, folder: { default: false } }
  },
  parseHTML() { return [{ tag: 'span[data-source-file]' }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-source-file': '' }), sourceText(node.attrs.path, node.attrs.folder)]
  },
  renderText({ node }) { return sourceText(node.attrs.path, node.attrs.folder) },
})

/** A long paste, collapsed: the chip names its size; the message carries its text. */
export const Pasted = Node.create({
  name: 'pasted',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    // `fileKey`: the text attachment it goes as (its upload, then its file); none where the chat takes no files.
    return { text: { default: '' }, fileKey: { default: null } }
  },
  parseHTML() { return [{ tag: 'span[data-pasted]' }] },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { 'data-pasted': '' })] },
  renderText({ node }) { return node.attrs.text },
})

/** A pasted or dropped image: the official Image node, inline, tied to its upload by `fileKey`. */
export const ChatImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), fileKey: { default: null } }
  },
  renderText() { return '' },
}).configure({ inline: true, allowBase64: false })

type ChipViews = {
  mention?: ComponentType<NodeViewProps>
  sourceFile: ComponentType<NodeViewProps>
  pasted: ComponentType<NodeViewProps>
  image: ComponentType<NodeViewProps>
  /** ReactNodeViewRenderer, passed in so the schema stays free of React for the server-side tests. */
  render: (component: ComponentType<NodeViewProps>) => NodeViewRenderer
}

export type ChatEditorOptions = {
  placeholder?: () => string
  /** One Suggestion per trigger: `@` references, people, Bots and files; `/` commands and skills; `$` skills. */
  suggestions?: Omit<SuggestionOptions, 'editor'>[]
  /** The class a reference chip draws with: the composer's own link-coloured words (decision #2924). */
  referenceClass?: string
  views?: ChipViews
  /** The longest stored message: an edit past it is refused, as the textarea's maxLength did. */
  maxLength?: () => number
  extra?: AnyExtension[]
}

const keep = (extension: AnyExtension, views: ChipViews | undefined, view: keyof Omit<ChipViews, 'render' | 'mention'>) =>
  views ? (extension as Node).extend({ addNodeView: () => views.render(views[view]) }) : extension

/** The extensions; without options, the bare schema (tests, server). */
export function chatEditorSchemaExtensions(options: ChatEditorOptions = {}): AnyExtension[] {
  const mention = ChatMention.configure({
    deleteTriggerWithBackspace: true,
    HTMLAttributes: options.referenceClass ? { class: options.referenceClass } : {},
    renderText: ({ node }) => chipText(node.attrs as MentionAttrs),
    renderHTML: ({ options: mentionOptions, node }) => ['span', mergeAttributes({ 'data-type': 'mention' }, mentionOptions.HTMLAttributes, { 'data-kind': node.attrs.kind }), node.attrs.label ?? node.attrs.id],
    suggestions: options.suggestions ?? [],
  })
  return [
    StarterKit.configure({
      // Plain text: no marks, no blocks beyond the paragraph, no list or code keys.
      bold: false, italic: false, strike: false, code: false, underline: false, link: false,
      heading: false, blockquote: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false,
      codeBlock: false, horizontalRule: false, dropcursor: false, gapcursor: false, trailingNode: false,
    }),
    mention,
    keep(SourceFile, options.views, 'sourceFile'),
    keep(Pasted, options.views, 'pasted'),
    keep(ChatImage, options.views, 'image'),
    ...(options.placeholder ? [Placeholder.configure({ placeholder: options.placeholder })] : []),
    ...(options.maxLength ? [MaxLength(options.maxLength)] : []),
    ...options.extra ?? [],
  ]
}

/** An edit that would make the stored message longer than the most is refused; one that shortens it always goes. */
function MaxLength(most: () => number) {
  return Extension.create({
    name: 'chatMaxLength',
    addProseMirrorPlugins() {
      return [new Plugin({
        key: new PluginKey('chatMaxLength'),
        filterTransaction: (transaction, state) => {
          if (!transaction.docChanged) return true
          const next = docToStored(transaction.doc.toJSON() as JSONNode).length
          return next <= most() || next <= docToStored(state.doc.toJSON() as JSONNode).length
        },
      })]
    },
  })
}
