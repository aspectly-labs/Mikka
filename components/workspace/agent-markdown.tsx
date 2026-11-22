'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { Children, createContext, isValidElement, memo, use, useMemo, type ComponentProps, type ReactNode } from 'react'
import { AgentCodeBlock } from './agent-code-block'
import dynamic from '@/lib/client-runtime/dynamic'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { remarkCitations } from '@/lib/coordinator/citations'
import { CitationAnchor, useAgentCitations } from './agent-citations'
import { hasMathDelimiters } from '@/lib/math-delimiters'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const MermaidDiagram = dynamic(() => import('./agent-mermaid').then(module => module.AgentMermaid), {
  ssr: false,
  loading: () => { const agentCopy = useAgentCopy(); return (<p role="status" className="text-sm text-muted-foreground">{agentCopy.loadingDiagram}</p>) },
})

const remarkPlugins = [remarkGfm]
const NO_PLUGINS: [] = []
const MathMarkdown = dynamic(() => import('./agent-math-markdown').then(module => module.AgentMathMarkdown))

export type AgentMarkdownProps = {
  text: string
  isStreaming?: boolean
  size?: 'small' | 'default' | 'large' | 'small-heavy' | 'large-heavy'
}

export const AgentMarkdown = memo(function AgentMarkdown(props: AgentMarkdownProps) {
  return hasMathDelimiters(props.text) ? <MathMarkdown {...props} /> : <AgentMarkdownContent {...props} />
})

/** Whether the reply is still arriving, for the code and diagram blocks inside it. */
const MarkdownStreaming = createContext(false)
/** The body size, so headings and inline code keep their step from it in a small card as in a reply. */
const MarkdownSize = createContext<NonNullable<AgentMarkdownProps['size']>>('default')

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
/**
 * LobeHub's chat Markdown, mapped to R-32's sizes (lobe-ui `src/Markdown/style.css`; the chat variant at :356-361 sets a
 * 14px body, line-height 1.6, `margin-multiple` 1 and `header-multiple` 0.25). Headings (:115-154) are 1.375×, 1.25×,
 * 1.125× and 1.0625× the body at line-height 1.25: 19.25 / 17.5 / 15.75 / 14.9px on the thread's 14px body, here 20 / 18 / 15px
 * and the body size for h4-h6. A small card (12px) steps from its own size. Weights stop at SemiBold (R-32).
 */
const sizeStep = (size: NonNullable<AgentMarkdownProps['size']>) => size === 'small' || size === 'small-heavy' ? 'small' : size === 'large' || size === 'large-heavy' ? 'large' : 'default'

function MarkdownHeading({ as: Tag, node: _node, ...props }: ComponentProps<'h1'> & { as: HeadingTag; node?: unknown }) {
  const small = sizeStep(use(MarkdownSize)) === 'small'
  // LobeHub keeps max(1em, …) = 14px around a heading (:121-124); on the 8px paragraph gap that is 16px above and 12px below.
  // The size goes first: a later text size would drop `leading-tight` in the class merge.
  return <Tag {...props} className={cn({
    'text-xl': Tag === 'h1' && !small,
    'text-lg': Tag === 'h2' && !small,
    'text-md': (Tag === 'h3' && !small) || (Tag === 'h1' && small),
    'text-sm': Tag === 'h2' && small,
  }, 'mt-2 mb-1 leading-tight font-semibold first:mt-0 last:mb-0')} />
}

function MarkdownCode({ node: _node, ...props }: ComponentProps<'code'> & { node?: unknown }) {
  // Inline code at about LobeHub's 0.875em (:47-60) of each body size: 11 / 12 / 13px on 12 / 13-14 / 15px.
  const step = sizeStep(use(MarkdownSize))
  return <code {...props} className={cn('rounded bg-muted px-1 py-0.5 font-mono', { 'text-2xs': step === 'small', 'text-xs': step === 'default', 'text-sm': step === 'large' })} />
}

function MarkdownImage({ alt }: { alt?: string }) {
  const agentCopy = useAgentCopy()
  return <span className="text-muted-foreground">{alt || agentCopy.image}{agentCopy.useTheIllustrationComponentForImages}</span>
}

function MarkdownTable({ node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
  const agentCopy = useAgentCopy()
  // LobeHub's table (:266-306): as wide as its content up to the column, rounded, outlined, a filled header and roomy cells.
  // The outline is `--rule`, a solid grey in both themes (R-31: never white at low opacity in dark mode).
  return <div tabIndex={0} role="region" aria-label={agentCopy.markdownTable} className="w-fit max-w-full overflow-hidden rounded-md border border-rule"><Table {...props} /></div>
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const isStreaming = use(MarkdownStreaming)
  const child = Children.toArray(children).find(child => isValidElement<{ className?: string; children?: ReactNode }>(child))
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null
  const source = String(child.props.children ?? '').replace(/\n$/, '')
  const language = /language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? 'text'
  return <div className="agent-code-block">{language.toLowerCase() === 'mermaid'
    ? <MermaidDiagram source={source} isStreaming={isStreaming} />
    : <AgentCodeBlock code={source} language={language} isStreaming={isStreaming} />}</div>
}

/**
 * Defined once: react-markdown uses these as element types, so a new function per render would remount every
 * paragraph, chip and code block on each streamed token, replaying their enter animations (the chat flashed).
 */
const components: NonNullable<ComponentProps<typeof Markdown>['components']> = {
  h1: props => <MarkdownHeading {...props} as="h1" />,
  h2: props => <MarkdownHeading {...props} as="h2" />,
  h3: props => <MarkdownHeading {...props} as="h3" />,
  h4: props => <MarkdownHeading {...props} as="h4" />,
  h5: props => <MarkdownHeading {...props} as="h5" />,
  h6: props => <MarkdownHeading {...props} as="h6" />,
  // LobeHub's lists (:178-213, :363-368): 0.33em between items (gap-1), the marker in the secondary colour.
  ul: ({ node: _node, ...props }) => <ul {...props} className="flex list-disc flex-col gap-1 ps-6 marker:text-muted-foreground" />,
  ol: ({ node: _node, ...props }) => <ol {...props} className="flex list-decimal flex-col gap-1 ps-6 marker:text-muted-foreground" />,
  // LobeHub's quote (:37-45): a 4px bar at the start and secondary text, no fill.
  blockquote: ({ node: _node, ...props }) => <blockquote {...props} className="border-s-4 border-rule ps-4 text-muted-foreground" />,
  a: ({ node: _node, ...props }) => <CitationAnchor {...props} />,
  img: MarkdownImage,
  pre: MarkdownPre,
  code: MarkdownCode,
  table: MarkdownTable,
  thead: ({ node: _node, ...props }) => <TableHeader {...props} className="bg-muted" />,
  tbody: ({ node: _node, ...props }) => <TableBody {...props} />,
  // No line between rows (ui-policy style/no-horizontal-rule): the header's fill and the outline group them.
  tr: ({ node: _node, ...props }) => <TableRow {...props} className="hover:bg-transparent" />,
  th: ({ node: _node, ...props }) => <TableHead {...props} className="h-auto min-w-30 px-4 py-3" />,
  td: ({ node: _node, ...props }) => <TableCell {...props} className="min-w-30 px-4 py-3" />,
  // A break is space, not a line (R-31, as the Artifact reader): LobeHub's 1.5em around its rule (:156-165) is 20px here.
  hr: () => <div role="separator" className="h-1" />,
}

export function AgentMarkdownContent({ text, isStreaming = false, size = 'default', mathRemarkPlugins = NO_PLUGINS, rehypePlugins = NO_PLUGINS }: AgentMarkdownProps & {
  mathRemarkPlugins?: NonNullable<ComponentProps<typeof Markdown>['remarkPlugins']>
  rehypePlugins?: NonNullable<ComponentProps<typeof Markdown>['rehypePlugins']>
}) {
  const cites = Boolean(useAgentCitations())
  const plugins = useMemo(() => [...remarkPlugins, ...mathRemarkPlugins, ...(cites ? [remarkCitations] : [])], [mathRemarkPlugins, cites])

  // Blocks 8px apart: LobeHub's 0.5em between paragraphs (:240-251) is 7px on the thread's 14px body.
  return <div data-agent-markdown data-size={size} className={cn('agent-markdown flex min-w-0 max-w-full flex-col gap-2 break-words text-sm leading-5.25 [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex_.cjk_fallback]:font-sans', {
    'text-xs': size === 'small' || size === 'small-heavy',
    'text-md': size === 'large' || size === 'large-heavy',
    'font-semibold': size === 'small-heavy' || size === 'large-heavy',
  })}>
    <MarkdownSize value={size}>
      <MarkdownStreaming value={isStreaming}>
        <Markdown remarkPlugins={plugins} rehypePlugins={rehypePlugins} skipHtml components={components}>{text}</Markdown>
      </MarkdownStreaming>
    </MarkdownSize>
  </div>
}
