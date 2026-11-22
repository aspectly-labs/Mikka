// What an opened tool call shows (Alex, 2026-11-22), as Claude Code, Codex and LobeHub show it: a file read is the
// file's code, a search its matches, an edit its diff, any other tool its inputs as a short list and its output as
// text, or as JSON only when it is structured. The raw input and output stay one click away under 原始数据. Pure, so
// the rows and tests read a call the same way.

export type ToolDetailKind = 'read' | 'search' | 'shell' | 'edit' | 'web' | 'delegate' | 'todo' | 'other'

type DiffLine = { type: 'added' | 'removed'; content: string }

export type ToolDetailView =
  | { type: 'file'; path?: string; language?: string; code: string }
  | { type: 'matches'; query?: string; lines: string[] }
  | { type: 'diff'; file: string; language?: string; lines: DiffLine[] }
  | { type: 'generic'; fields: { key: string; value: string }[]; output?: { text: string; json: boolean } }

/** A file's language from its extension, as the code block names them; none for an unknown one. */
const EXTENSIONS: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', md: 'markdown', mdx: 'markdown', css: 'css', scss: 'scss', html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql', xml: 'xml', graphql: 'graphql',
  dockerfile: 'docker',
}

export function languageOf(path: string | undefined): string | undefined {
  if (!path) return undefined
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile') return 'docker'
  const dot = name.lastIndexOf('.')
  return dot > 0 ? EXTENSIONS[name.slice(dot + 1)] : undefined
}

function parsed(text: string | undefined): unknown {
  if (!text) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

const string = (value: unknown) => typeof value === 'string' ? value : undefined

/**
 * A tool's output as text: an MCP / AI SDK `{type: 'text', value}` or `{content: [{type: 'text', text}]}` envelope is
 * its text; anything else is the stored output.
 */
export function outputText(output: string | undefined): string | undefined {
  if (output === undefined) return undefined
  const value = parsed(output)
  if (typeof value === 'string') return value
  const top = record(value)
  if (top?.type === 'text' && typeof top.value === 'string') return top.value
  if (Array.isArray(top?.content)) {
    const texts = top.content.map(item => record(item)?.type === 'text' ? string(record(item)?.text) : undefined)
    if (texts.length && texts.every(text => text !== undefined)) return texts.join('\n')
  }
  return output
}

/** Claude Code's Read numbers each line (`     1→code`, or a tab); the file reads without them. */
function withoutLineNumbers(code: string): string {
  const lines = code.replace(/\n$/, '').split('\n')
  const numbered = /^\s*\d+(?:→|\t)/
  return lines.length && lines.every(line => !line || numbered.test(line)) ? lines.map(line => line.replace(numbered, '')).join('\n') : code
}

const FIELD_MAX = 200

/** One input field in a line: a string as it is, anything else as compact JSON, cut where a line ends. */
function fieldValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > FIELD_MAX ? `${line.slice(0, FIELD_MAX - 1)}…` : line
}

function splitLines(text: string) {
  return text.replace(/\r?\n$/, '').split(/\r?\n/)
}

/** An edit's old and new text, from Claude Code's Edit / MultiEdit or a `{old_string, new_string}` call. */
function editLines(input: Record<string, unknown>): DiffLine[] | null {
  const pairs = Array.isArray(input.edits) ? input.edits.map(record).filter(Boolean) as Record<string, unknown>[] : [input]
  const lines: DiffLine[] = []
  for (const pair of pairs) {
    const before = string(pair.old_string) ?? string(pair.old_str) ?? string(pair.oldText)
    const after = string(pair.new_string) ?? string(pair.new_str) ?? string(pair.newText)
    if (before === undefined || after === undefined) return null
    if (before) lines.push(...splitLines(before).map(content => ({ type: 'removed' as const, content })))
    if (after) lines.push(...splitLines(after).map(content => ({ type: 'added' as const, content })))
  }
  return lines.length ? lines : null
}

/**
 * The readable view of a call: `kind` is what it did (lib/issue-run-conversation.ts `threadStepKind`), `target` the
 * path, query or URL it acted on, `input` and `output` as stored (JSON or text, possibly a cut preview).
 */
export function toolDetailView({ kind, target, input, output }: { kind?: ToolDetailKind; target?: string; input?: string; output?: string }): ToolDetailView | null {
  const args = record(parsed(input))
  const path = target ?? string(args?.file_path) ?? string(args?.path)
  const text = outputText(output)
  if (kind === 'read' && text !== undefined && text.trim()) return { type: 'file', path, language: languageOf(path), code: withoutLineNumbers(text) }
  if (kind === 'search' && text !== undefined) {
    const lines = splitLines(text).filter(line => line.trim())
    return { type: 'matches', ...(target ? { query: target } : {}), lines }
  }
  if (kind === 'edit' && args) {
    const lines = editLines(args)
    const file = path ?? ''
    if (lines && file) return { type: 'diff', file, language: languageOf(file), lines }
    const content = string(args.content) ?? string(args.contents)
    if (content !== undefined) return { type: 'file', path, language: languageOf(path), code: content }
  }
  const fields = args ? Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => ({ key, value: fieldValue(value) })) : []
  // An input that is not a JSON object (a cut preview, a bare string) is its own one line.
  if (!args && input?.trim()) fields.push({ key: '', value: fieldValue(input) })
  if (!fields.length && (text === undefined || !text.trim())) return null
  if (text === undefined || !text.trim()) return { type: 'generic', fields }
  const structured = parsed(text)
  const json = structured !== undefined && typeof structured === 'object' && structured !== null
  return { type: 'generic', fields, output: json ? { text: JSON.stringify(structured, null, 2), json: true } : { text, json: false } }
}
