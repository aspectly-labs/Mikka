import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@/lib/intl/i18n-client', { namedExports: { useMessages: () => ({ AgentCopy: { markdownTable: 'Table', image: 'Image', useTheIllustrationComponentForImages: '', loadingDiagram: '' } }) } })
mock.module(new URL('./agent-citations.tsx', import.meta.url).href, { namedExports: {
  useAgentCitations: () => null,
  CitationAnchor: ({ href, children }: { href?: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
} })
mock.module(new URL('./agent-code-block.tsx', import.meta.url).href, { namedExports: { AgentCodeBlock: ({ code }: { code: string }) => <pre>{code}</pre> } })
let AgentMarkdown: typeof import('./agent-markdown')['AgentMarkdown']
before(async () => { ({ AgentMarkdown } = await import('./agent-markdown')) })

const SAMPLE = '# One\n\n## Two\n\n### Three\n\n#### Four\n\nFirst.\n\nSecond `code`.\n\n- a\n- b\n\n> quoted\n\n---\n\n| A | B |\n| - | - |\n| 1 | 2 |'
const classOf = (html: string, tag: string) => new RegExp(`<${tag}(?=[\\s>])[^>]*class="([^"]*)"`).exec(html)?.[1].split(' ') ?? []

// LobeHub's chat Markdown (lobe-ui src/Markdown/style.css :129-154, :356-361): h1 1.375×, h2 1.25×, h3 1.125× the body.
test('a reply\'s headings step down in size instead of h1 and h2 sharing one', () => {
  const html = renderToStaticMarkup(<AgentMarkdown text={SAMPLE} />)
  const [h1, h2, h3, h4] = ['h1', 'h2', 'h3', 'h4'].map(tag => classOf(html, tag))
  assert.ok(h1.includes('text-xl'), h1.join(' '))
  assert.ok(h2.includes('text-lg'), h2.join(' '))
  assert.ok(h3.includes('text-md'), h3.join(' '))
  assert.ok(!h4.some(name => /^text-(?:xs|sm|md|lg|xl)$/.test(name)), 'h4 keeps the body size')
  for (const heading of [h1, h2, h3, h4]) for (const name of ['font-semibold', 'leading-tight', 'mt-2', 'mb-1', 'first:mt-0']) assert.ok(heading.includes(name), name)
})

test('a small card keeps its headings near its own size', () => {
  const html = renderToStaticMarkup(<AgentMarkdown text={SAMPLE} size="small" />)
  assert.ok(classOf(html, 'h1').includes('text-md'))
  assert.ok(classOf(html, 'h2').includes('text-sm'))
  assert.ok(classOf(html, 'code').includes('text-2xs'), 'inline code stays below a 12px body')
})

// lobe-ui style.css :240-251 (0.5em between paragraphs), :37-45 (blockquote), :178-213 and :363-368 (lists).
test('paragraphs sit 8px apart, a quote is a start bar in the body colour and list markers are secondary', () => {
  const html = renderToStaticMarkup(<AgentMarkdown text={SAMPLE} />)
  const root = classOf(html, 'div')
  assert.ok(root.includes('gap-2') && !root.includes('gap-3'), root.join(' '))
  const quote = classOf(html, 'blockquote')
  // Body colour: the official palette's muted text is 3.35:1 on white, under AA for a quote's body text.
  assert.deepEqual(quote.filter(name => /^(?:bg-|rounded|border-s-4|border-rule|ps-4|text-)/.test(name)).sort(), ['border-rule', 'border-s-4', 'ps-4', 'text-foreground'])
  assert.ok(classOf(html, 'ul').includes('marker:text-muted-foreground'))
  assert.ok(classOf(html, 'code').includes('text-xs'), 'inline code is about 0.875em of the body')
  assert.match(html, /<div role="separator" class="h-1"><\/div>/)
})

// lobe-ui style.css :266-306: an outlined, rounded table with a filled header row and roomy cells.
test('a table is outlined and rounded, with a filled header', () => {
  const html = renderToStaticMarkup(<AgentMarkdown text={SAMPLE} />)
  const region = /role="region"[^>]*class="([^"]*)"/.exec(html)?.[1].split(' ') ?? []
  assert.ok(['w-fit', 'max-w-full', 'overflow-hidden', 'rounded-md', 'border', 'border-rule'].every(name => region.includes(name)), region.join(' '))
  assert.ok(classOf(html, 'thead').includes('bg-muted'))
  for (const cell of ['th', 'td']) for (const name of ['px-4', 'py-3', 'min-w-30']) assert.ok(classOf(html, cell).includes(name), cell + ' ' + name)
})
