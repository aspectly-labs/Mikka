/**
 * Dependency-free historical OpenUI fallback (decision 2026-11-25-remove-openui).
 *
 * New replies are always plain Markdown + native Mikka citations (`[[issue:…]]`,
 * `[[run:…]]`, Markdown links). Older rows stored in `coordinator_messages` or
 * `agent_turns` may still contain historical OpenUI Lang (`root = Stack([...])`).
 * This module parses that historical syntax without any `@openuidev/*` runtime
 * dependency and projects it into readable Markdown or plain text — never
 * executing JSX, actions or live controls, and never leaking raw DSL syntax.
 */

type LegacyValue = string | number | boolean | null | LegacyValue[] | { [key: string]: LegacyValue } | LegacyComponent
interface LegacyComponent { kind: 'component'; name: string; props: Record<string, LegacyValue>; args: LegacyValue[] }

/** Known historical OpenUI component positional signatures (for safe text extraction). */
const SIGNATURES: Record<string, readonly string[]> = {
  Stack: ['children', 'direction', 'gap', 'align', 'justify', 'wrap'],
  BeResponse: ['children'],
  Card: ['children', 'variant', 'direction', 'gap', 'align', 'justify'],
  TextContent: ['text', 'size'],
  InlineText: ['parts'],
  BeCard: ['title', 'children', 'description'],
  BeCardGrid: ['children'],
  BeImageCard: ['title', 'query', 'description', 'tags', 'prompt'],
  BeImage: ['query', 'alt', 'caption'],
  BeQuestions: ['context', 'questions'],
  BeApproval: ['title', 'description', 'context'],
  BeFollowUps: ['items'],
  BeButton: ['label', 'prompt', 'variant'],
  BeStat: ['label', 'value', 'unit', 'precision'],
  BeAlert: ['title', 'description', 'variant'],
  BeTodoList: ['title', 'items', 'mode'],
  BeTable: ['columns', 'rows'],
  BeTabs: ['items'],
  BeCollapsible: ['title', 'children', 'defaultOpen'],
  BeCodeBlock: ['code', 'language', 'title', 'highlightLines'],
  CodeBlock: ['language', 'code'],
  BeFileTree: ['paths'],
  BeFileDiff: ['path', 'diff', 'language'],
  BeCitations: ['items'],
  AgentIcon: ['name', 'label'],
  Tag: ['text', 'icon', 'size', 'variant'],
  Steps: ['children'],
  StepsItem: ['title', 'details'],
  Separator: ['orientation'],
  TaskChip: ['id'],
  RunChip: ['id'],
  SourceChip: ['url', 'label'],
  ComputerCard: ['botId', 'runId', 'task', 'status', 'botName', 'threadName'],
  BarChart: ['labels', 'series', 'horizontal', 'unit'],
  LineChart: ['labels', 'series', 'unit'],
  AreaChart: ['labels', 'series', 'unit'],
  DonutChart: ['items', 'unit', 'totalLabel'],
  RadialChart: ['label', 'value', 'max', 'unit'],
  Form: ['name', 'buttons', 'fields'],
  FormControl: ['label', 'input', 'hint'],
  Buttons: ['buttons'],
  Button: ['label', 'action', 'variant'],
  EditableTable: ['name', 'columns', 'rows'],
  // Retired historical component names from early replies.
  ShadcnCard: ['title', 'children', 'description'],
  ShadcnBadge: ['text', 'variant'],
  ShadcnAlert: ['title', 'description', 'variant'],
  ShadcnAccordion: ['items', 'multiple'],
  ShadcnTabs: ['items'],
  ShadcnTable: ['columns', 'rows'],
  ShadcnButton: ['label', 'prompt', 'variant'],
  ShadcnProgress: ['label', 'value'],
  ReuiBadge: ['text', 'variant'],
  ReuiAlert: ['title', 'description', 'variant'],
  ReuiFrame: ['title', 'children', 'description'],
  BeBadge: ['text', 'status'],
  BeTimeline: ['events'],
}

const KNOWN_COMPONENTS = new Set(Object.keys(SIGNATURES))
const CHARTS = new Set(['BarChart', 'LineChart', 'AreaChart', 'DonutChart', 'RadialChart'])
const OMITTED_KEYS = new Set(['action', 'prompt', 'context', 'variant', 'className', 'size', 'botId', 'runId', 'id', 'precision', 'query', 'icon', 'direction', 'gap', 'align', 'justify', 'wrap', 'multiple', 'allowCustom', 'defaultOpen', 'orientation', 'horizontal', 'highlightLines', 'mode', 'status', 'name'])

const COMPONENT_LIST_PATTERN = [...KNOWN_COMPONENTS].join('|')
const ROOT_ASSIGNMENT = new RegExp(`(?:^|\\n)[ \\t]*root[ \\t]*=[ \\t]*(?:${COMPONENT_LIST_PATTERN})[ \\t]*\\(`)
const TOP_LEVEL_CALL = new RegExp(`^\\s*(?:${COMPONENT_LIST_PATTERN})\\s*\\(\\s*[^\\s)]`)

const isComponent = (value: LegacyValue | undefined): value is LegacyComponent =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as LegacyComponent).kind === 'component')

const str = (value: LegacyValue | undefined): string => typeof value === 'string' ? value : ''
const arr = (value: LegacyValue | undefined): LegacyValue[] => Array.isArray(value) ? value : []
const obj = (value: LegacyValue | undefined): Record<string, LegacyValue> =>
  value && typeof value === 'object' && !Array.isArray(value) && !isComponent(value) ? value as Record<string, LegacyValue> : {}

const fence = (code: string) => '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(match => match[0].length + 1)))

function withoutFences(source: string): string {
  return source.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g, '$1')
}

const EXPLICIT_OPENUI_FENCE_LANGS = new Set(['openui', 'openui-lang', 'openui_lang'])

function unfenceWholeReply(text: string): { lang: string; body: string } | null {
  const trimmed = text.trim()
  const open = /^(```|~~~)([^\n]*)\n/.exec(trimmed)
  if (!open) return null
  const marker = open[1]!
  const lang = open[2]!.trim().toLowerCase()
  const rest = trimmed.slice(open[0].length).trimEnd()
  if (!rest.endsWith(marker)) return null
  const inner = rest.slice(0, -marker.length)
  if (/(^|\n)[ \t]*(```|~~~)/.test(inner)) return null
  return { lang, body: inner.replace(/\n$/, '') }
}

function normalizeEscapes(source: string): string {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?/g, token => {
    if (!token.startsWith('"')) return token
    let result = '"'
    for (let index = 1; index < token.length; index++) {
      const character = token[index]!
      if (character === '\\') {
        const next = token[index + 1]
        if (next === undefined) {
          result += character
        } else if (/^["\\/bfnrt]$/.test(next) || (next === 'u' && /^[\da-f]{4}/i.test(token.slice(index + 2)))) {
          result += character + next
          index++
        } else {
          result += '\\\\'
        }
      } else if (character.charCodeAt(0) < 32) {
        result += JSON.stringify(character).slice(1, -1)
      } else {
        result += character
      }
    }
    return result
  })
}

function splitLegacySource(text: string): { prose: string; source: string; parsed?: LegacyValue | null } | null {
  const unfenced = unfenceWholeReply(text)
  if (unfenced !== null) {
    const explicitOpenUI = EXPLICIT_OPENUI_FENCE_LANGS.has(unfenced.lang)
    // A typed code fence (e.g. ```python, ```ts) is ordinary Markdown code, never historical OpenUI.
    if (unfenced.lang !== '' && !explicitOpenUI) return null
    const body = unfenced.body
    let extracted: { prose: string; source: string } | null = null
    if (ROOT_ASSIGNMENT.test(body)) {
      const match = /(^|\n)[ \t]*root[ \t]*=/.exec(body)
      if (!match) return null
      const at = match.index + match[1]!.length
      extracted = { prose: body.slice(0, at).trim(), source: normalizeEscapes(body.slice(at)) }
    } else if (TOP_LEVEL_CALL.test(body)) {
      extracted = { prose: '', source: normalizeEscapes(`root = ${body.trimStart()}`) }
    } else if (explicitOpenUI && /(?:^|\n)[ \t]*root[ \t]*=[ \t]*[A-Z]\w*[ \t]*\(/.test(body)) {
      const match = /(^|\n)[ \t]*root[ \t]*=/.exec(body)
      if (!match) return null
      const at = match.index + match[1]!.length
      extracted = { prose: body.slice(0, at).trim(), source: normalizeEscapes(body.slice(at)) }
    }
    if (!extracted) return null
    const parsed = parseProgram(extracted.source)
    if (!explicitOpenUI && (!parsed || (isComponent(parsed) && !KNOWN_COMPONENTS.has(parsed.name)))) {
      return null
    }
    return { ...extracted, parsed }
  }

  const uncode = withoutFences(text)
  if (ROOT_ASSIGNMENT.test(uncode)) {
    const match = /(^|\n)[ \t]*root[ \t]*=/.exec(text)
    if (!match) return null
    const at = match.index + match[1]!.length
    const before = text.slice(0, at)
    if ((before.match(/(^|\n)[ \t]*(```|~~~)/g) ?? []).length % 2) return null
    return { prose: before.trim(), source: normalizeEscapes(text.slice(at)) }
  }
  if (TOP_LEVEL_CALL.test(text)) {
    return { prose: '', source: normalizeEscapes(`root = ${text.trimStart()}`) }
  }
  return null
}

class Reader {
  i = 0
  constructor(readonly text: string) {}

  space() {
    while (this.i < this.text.length) {
      const c = this.text[this.i]
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') this.i++
      else if (c === '/' && this.text[this.i + 1] === '/') {
        while (this.i < this.text.length && this.text[this.i] !== '\n') this.i++
      } else break
    }
  }

  peek() { this.space(); return this.text[this.i] }

  expect(c: string) {
    if (this.peek() !== c) throw new Error(`expected ${c} at ${this.i}`)
    this.i++
  }

  identifier(): string | null {
    this.space()
    const match = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.i))
    if (!match) return null
    this.i += match[0].length
    return match[0]
  }

  string(): string {
    const quote = this.text[this.i++]
    let out = ''
    while (this.i < this.text.length) {
      const c = this.text[this.i++]!
      if (c === quote) return out
      if (c !== '\\') { out += c; continue }
      const e = this.text[this.i++]
      if (e === 'n') out += '\n'
      else if (e === 't') out += '\t'
      else if (e === 'r') out += '\r'
      else if (e === 'u') {
        const hex = this.text.slice(this.i, this.i + 4)
        out += /^[\da-f]{4}$/i.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : `\\u${hex}`
        this.i += 4
      } else if (e !== undefined) out += e
    }
    throw new Error('unterminated string')
  }

  list(close: string): LegacyValue[] {
    const items: LegacyValue[] = []
    while (this.peek() !== close) {
      if (this.i >= this.text.length) throw new Error(`expected ${close}`)
      items.push(this.value())
      if (this.peek() === ',') this.i++
    }
    this.i++
    return items
  }

  value(): LegacyValue {
    const c = this.peek()
    if (c === '"' || c === "'") return this.string()
    if (c === '[') { this.i++; return this.list(']') }
    if (c === '{') {
      this.i++
      const object: Record<string, LegacyValue> = {}
      while (this.peek() !== '}') {
        if (this.i >= this.text.length) throw new Error('expected }')
        const at = this.peek()
        const key = at === '"' || at === "'" ? this.string() : this.identifier()
        if (key === null) throw new Error(`expected key at ${this.i}`)
        this.expect(':')
        object[key] = this.value()
        if (this.peek() === ',') this.i++
      }
      this.i++
      return object
    }
    const number = /^-?\d+(\.\d+)?/.exec(this.text.slice(this.i))
    if (number) { this.i += number[0].length; return Number(number[0]) }
    if (c === '@') {
      this.i++
      const directive = this.identifier()
      if (directive === null) throw new Error(`expected directive after @ at ${this.i}`)
      if (this.peek() === '(') {
        this.i++
        this.list(')')
      }
      return { kind: 'component', name: '$action', props: {}, args: [] }
    }
    const name = this.identifier()
    if (name === null) throw new Error(`unexpected ${c ?? 'end'} at ${this.i}`)
    if (name === 'true' || name === 'false') return name === 'true'
    if (name === 'null' || name === 'undefined') return null
    if (this.peek() === '(') {
      this.i++
      const args = this.list(')')
      const names = SIGNATURES[name] ?? []
      const props: Record<string, LegacyValue> = {}
      args.forEach((arg, index) => { if (names[index]) props[names[index]!] = arg })
      return { kind: 'component', name, props, args }
    }
    return { kind: 'component', name: '$ref', props: { name }, args: [] }
  }
}

function resolve(value: LegacyValue, statements: Map<string, LegacyValue>, visiting = new Set<string>(), depth = 0): LegacyValue {
  if (depth > 24 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => resolve(item, statements, visiting, depth + 1))
  if (isComponent(value)) {
    if (value.name === '$ref') {
      const refName = String(value.props.name ?? '')
      if (visiting.has(refName)) throw new Error('Cyclic saved content')
      const target = statements.get(refName)
      if (target === undefined) throw new Error(`Unresolved reference: ${refName}`)
      visiting.add(refName)
      try {
        return resolve(target, statements, visiting, depth + 1)
      } finally {
        visiting.delete(refName)
      }
    }
    const props: Record<string, LegacyValue> = {}
    for (const [key, prop] of Object.entries(value.props)) props[key] = resolve(prop, statements, visiting, depth + 1)
    return { ...value, props, args: value.args.map(arg => resolve(arg, statements, visiting, depth + 1)) }
  }
  const object: Record<string, LegacyValue> = {}
  for (const [key, item] of Object.entries(value)) object[key] = resolve(item, statements, visiting, depth + 1)
  return object
}

function parseProgram(source: string): LegacyValue | null {
  try {
    const reader = new Reader(source)
    const statements = new Map<string, LegacyValue>()
    while (reader.peek() !== undefined) {
      const name = reader.identifier()
      if (!name) return null
      reader.expect('=')
      statements.set(name, reader.value())
      if (reader.peek() === ';') reader.i++
    }
    const root = statements.get('root')
    if (root === undefined) return null
    return resolve(root, statements)
  } catch {
    return null
  }
}

function inlineMarkdown(value: LegacyValue | undefined, rawChipIds: boolean): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => inlineMarkdown(item, rawChipIds)).join('')
  if (!isComponent(value)) return ''
  if (value.name === 'TaskChip') {
    const id = str(value.props.id)
    return id ? (rawChipIds ? id : `[[issue:${id}]]`) : ''
  }
  if (value.name === 'RunChip') {
    const id = str(value.props.id)
    return id ? (rawChipIds ? id : `[[run:${id}]]`) : ''
  }
  if (value.name === 'SourceChip') {
    const url = str(value.props.url)
    return url ? `[${str(value.props.label) || url}](${url})` : ''
  }
  if (value.name === 'InlineText') return inlineMarkdown(value.props.parts, rawChipIds)
  return ''
}

function renderNode(value: LegacyValue | undefined, options: { omitCharts: boolean; rawChipIds: boolean; markdownBlocks: boolean }): string[] {
  const lines: string[] = []
  const push = (text: string) => { const trimmed = text.trim(); if (trimmed) lines.push(trimmed) }

  const walk = (node: LegacyValue | undefined) => {
    if (typeof node === 'string') { push(node); return }
    if (typeof node === 'number') { if (options.markdownBlocks) push(String(node)); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node === null || node === undefined || typeof node !== 'object') return

    if (!isComponent(node)) {
      if (options.markdownBlocks) {
        for (const [key, item] of Object.entries(node)) {
          if (OMITTED_KEYS.has(key) || /^on[A-Z]/.test(key)) continue
          walk(item)
        }
      } else {
        for (const key of ['title', 'label', 'text', 'content', 'detail', 'details', 'description', 'children']) walk(obj(node)[key])
      }
      return
    }

    if (options.omitCharts && CHARTS.has(node.name)) return

    switch (node.name) {
      case 'Stack':
      case 'BeResponse':
      case 'Card':
      case 'BeCardGrid':
      case 'Steps':
        walk(node.props.children)
        return
      case 'TextContent':
        walk(node.props.text)
        return
      case 'InlineText':
        push(inlineMarkdown(node.props.parts, options.rawChipIds))
        return
      case 'TaskChip':
      case 'RunChip':
      case 'SourceChip':
        push(inlineMarkdown(node, options.rawChipIds))
        return
      case 'BeCard':
      case 'ShadcnCard':
      case 'ReuiFrame':
        walk(node.props.title)
        walk(node.props.description)
        walk(node.props.children)
        return
      case 'BeAlert':
      case 'ShadcnAlert':
      case 'ReuiAlert':
      case 'BeApproval':
        walk(node.props.title)
        walk(node.props.description)
        return
      case 'BeButton':
      case 'ShadcnButton':
      case 'Button':
        walk(node.props.label)
        return
      case 'BeQuestions':
        for (const question of arr(node.props.questions)) {
          const entry = obj(question)
          walk(entry.title)
          walk(entry.description)
          for (const option of arr(entry.options)) {
            const opt = obj(option)
            const label = str(opt.label)
            const description = str(opt.description)
            if (label) lines.push(description ? `- ${label} — ${description}` : `- ${label}`)
          }
        }
        return
      case 'BeFollowUps':
        for (const item of arr(node.props.items)) {
          const label = str(obj(item).label)
          if (label) lines.push(`- ${label}`)
        }
        return
      case 'BeTodoList':
        walk(node.props.title)
        for (const item of arr(node.props.items)) {
          const entry = obj(item)
          const title = str(entry.title)
          const detail = str(entry.detail)
          if (title) lines.push(detail ? `- ${title} — ${detail}` : `- ${title}`)
        }
        return
      case 'BeStat': {
        const label = str(node.props.label)
        const val = node.props.value
        const unit = str(node.props.unit)
        const formatted = [label, val !== undefined && val !== null ? `${val}${unit ? ` ${unit}` : ''}` : ''].filter(Boolean).join(': ')
        if (formatted) lines.push(formatted)
        return
      }
      case 'BeImageCard':
        walk(node.props.title)
        walk(node.props.description)
        return
      case 'BeImage':
        walk(node.props.caption)
        return
      case 'BeCodeBlock':
      case 'CodeBlock': {
        const title = str(node.props.title)
        const code = str(node.props.code)
        if (title) push(title)
        if (!code) return
        if (options.markdownBlocks) {
          const lang = str(node.props.language)
          const marker = fence(code)
          lines.push(`${marker}${lang}\n${code}\n${marker}`)
        } else {
          push(code.split('\n').find(line => line.trim()) ?? '')
        }
        return
      }
      case 'Form':
        walk(node.props.fields)
        return
      case 'FormControl':
        walk(node.props.label)
        walk(node.props.input)
        walk(node.props.hint)
        return
      case 'EditableTable': {
        const rawCols = arr(node.props.columns)
        const rawRows = arr(node.props.rows)
        const headers = rawCols.map(col => typeof col === 'string' ? col : (str(obj(col).header) || str(obj(col).label) || str(obj(col).key))).filter(Boolean)
        const rowArrays = rawRows.map(row => Array.isArray(row) ? row : arr(obj(row).values)).filter(row => row.length > 0)
        if (options.markdownBlocks && headers.length) {
          const cellText = (cell: LegacyValue) => renderNode(cell, options).join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ')
          const rowLine = (cells: LegacyValue[]) => `| ${cells.map(cellText).join(' | ')} |`
          lines.push([rowLine(headers), rowLine(headers.map(() => '---')), ...rowArrays.map(rowLine)].join('\n'))
        } else {
          headers.forEach(push)
          rowArrays.forEach(walk)
        }
        return
      }
      case 'Action':
      case 'Buttons':
      case '$action':
        return
      case 'BeFileDiff': {
        const path = str(node.props.path)
        const diff = str(node.props.diff)
        if (path) push(path)
        if (diff && options.markdownBlocks) {
          const marker = fence(diff)
          lines.push(`${marker}diff\n${diff}\n${marker}`)
        }
        return
      }
      case 'BeTable':
      case 'ShadcnTable': {
        const cols = arr(node.props.columns)
        const rows = arr(node.props.rows)
        if (options.markdownBlocks && cols.length) {
          const cellText = (cell: LegacyValue) => renderNode(cell, options).join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ')
          const rowLine = (cells: LegacyValue[]) => `| ${cells.map(cellText).join(' | ')} |`
          lines.push([rowLine(cols), rowLine(cols.map(() => '---')), ...rows.filter(Array.isArray).map(row => rowLine(row))].join('\n'))
        } else {
          cols.forEach(walk)
          rows.forEach(walk)
        }
        return
      }
      case 'BeTabs':
      case 'ShadcnTabs':
      case 'ShadcnAccordion':
        for (const item of arr(node.props.items)) {
          const entry = obj(item)
          walk(entry.title)
          walk(entry.content)
          walk(entry.children)
        }
        return
      case 'BeCollapsible':
        walk(node.props.title)
        walk(node.props.children)
        return
      case 'StepsItem':
        walk(node.props.title)
        walk(node.props.details)
        return
      case 'BeFileTree':
        for (const path of arr(node.props.paths)) {
          const value = str(path)
          if (value) lines.push(`- ${value}`)
        }
        return
      case 'BeCitations':
        for (const item of arr(node.props.items)) {
          const entry = obj(item)
          const title = str(entry.title)
          const url = str(entry.url)
          if (url) lines.push(`- [${title || url}](${url})`)
          else if (title) lines.push(`- ${title}`)
        }
        return
      case 'ComputerCard':
        walk(node.props.task)
        walk(node.props.botName)
        walk(node.props.threadName)
        return
      case 'Tag':
      case 'ShadcnBadge':
      case 'ReuiBadge':
      case 'BeBadge':
        walk(node.props.text)
        return
      case 'AgentIcon':
        walk(node.props.label)
        return
      case 'Separator':
        return
      default:
        for (const arg of node.args) {
          if (typeof arg === 'string' && (/^(https?:|#)/.test(arg) || /^[0-9a-f-]{36}$/i.test(arg) || /^[a-z][a-z-]*$/.test(arg))) continue
          walk(arg)
        }
    }
  }

  walk(value)
  return lines
}

/** Whether `text` is a historical OpenUI Lang reply rather than ordinary Markdown. */
export function isLegacyOpenUIReply(text: string): boolean {
  return splitLegacySource(text) !== null
}

/**
 * Extracts readable Markdown from a historical OpenUI reply, combining any
 * leading prose with the card's text, tables, code blocks, lists and citations.
 * Returns `null` when `text` is ordinary Markdown (not historical OpenUI).
 */
export function extractLegacyOpenUIMarkdown(text: string, options?: { omitCharts?: boolean }): string | null {
  const split = splitLegacySource(text)
  if (!split) return null
  const parsed = split.parsed !== undefined ? split.parsed : parseProgram(split.source)
  const body = parsed === null
    ? ''
    : renderNode(parsed, { omitCharts: options?.omitCharts ?? false, rawChipIds: false, markdownBlocks: true }).join('\n\n')
  return [split.prose, body].filter(Boolean).join('\n\n').trim()
}

/**
 * Extracts readable plain lines from a historical OpenUI reply for sidebar
 * previews and mobile push notifications. Returns `null` when `text` is not
 * historical OpenUI, or `''` when a historical OpenUI reply contains no
 * readable text (e.g. a chart-only or unparseable interactive form card).
 */
export function extractLegacyOpenUIText(text: string, options?: { omitCharts?: boolean }): string | null {
  const split = splitLegacySource(text)
  if (!split) return null
  const parsed = split.parsed !== undefined ? split.parsed : parseProgram(split.source)
  const body = parsed === null
    ? ''
    : renderNode(parsed, { omitCharts: options?.omitCharts ?? false, rawChipIds: false, markdownBlocks: false }).join('\n')
  return [split.prose, body].filter(Boolean).join('\n').trim()
}

/** Project every saved panel into read-only Markdown, never instantiating controls or live cards. */
export function legacyChatContent(response: string): { format: 'markdown' | 'source'; text: string } {
  const split = splitLegacySource(response)
  if (!split) {
    // Only an unfenced `root = SomeComponent(...)` assignment that does not match any known
    // historical component falls back to escaped source; ordinary code fences stay Markdown.
    if (/(?:^|\n)[ \t]*root[ \t]*=[ \t]*[A-Z]\w*[ \t]*\(/.test(withoutFences(response))) {
      return { format: 'source', text: response }
    }
    return { format: 'markdown', text: response }
  }
  const parsed = split.parsed !== undefined ? split.parsed : parseProgram(split.source)
  if (!parsed || (isComponent(parsed) && !KNOWN_COMPONENTS.has(parsed.name))) {
    return { format: 'source', text: response }
  }
  const body = renderNode(parsed, { omitCharts: false, rawChipIds: true, markdownBlocks: true }).join('\n\n')
  const combined = [split.prose, body].filter(Boolean).join('\n\n').trim()
  return { format: 'markdown', text: combined }
}
