// Keep the cause, give a sub-code, give user copy for every surfaced code
// (mikka-hosted-ui/docs/design/decisions/2026-11-05-0330-error-causes.md). Two checks:
//
// 1. error-cause/copy: every code in the registry of user-reachable codes
//    (packages/protocol/src/user-error-codes.ts) and every one of its details
//    has a line in messages/zh-CN.json and messages/en.json under
//    `RunErrors.<code>.default` / `RunErrors.<code>.<detail>`, and RunErrors has
//    nothing the registry does not list. A coded error thrown with a literal
//    registered code names a detail from that code's set.
// 2. error-cause/dropped: a `catch` block that throws a new error must hand the
//    caught error on, as `{ cause: error }` or as an argument to a helper
//    (`unavailable("lease_refused", error)`). A deliberate drop says why in a
//    `// error-cause: <reason>` comment on the throw's line or the line above
//    (for example: the cause quotes a response body that may hold a secret).
//    The drops that existed when the guard landed are counted per file in
//    droppedCauseAllowlist; that list only shrinks, as the polling allowlist does.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { officialCoreFiles, readUi, uiExists, unverifiable } from './official-ui-tree.mjs'

export const errorCauseMessage = '保留原因：catch 里抛出的新错误要带 `{ cause: error }`（或把 error 传给 helper），给出 detail 子码，并为用户能看到的错误码在 messages/*.json 写文案；见 mikka-hosted-ui/docs/design/decisions/2026-11-05-0330-error-causes.md。确实要丢弃原因时在同一行或上一行写 `// error-cause: <原因>`。'

export const registryFile = 'packages/protocol/src/user-error-codes.ts'
export const catalogues = ['messages/zh-CN.json', 'messages/en.json']
export const errorCauseRoots = ['lib/', 'app/', 'packages/daemon/src/', 'packages/protocol/src/', 'workflows/']

/** The registry of user-reachable codes and their details, read from its source (it has no imports). */
export function parseRegistry(source) {
  const start = source.indexOf('USER_ERROR_CODES = {')
  if (start < 0) throw new Error(`${registryFile}: USER_ERROR_CODES not found`)
  const registry = {}
  for (const match of source.slice(start).matchAll(/^\s*([a-z][a-z0-9_]*):\s*\[([^\]]*)\]/gm)) {
    registry[match[1]] = [...match[2].matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map(item => item[1])
  }
  return registry
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length

/** Copy findings: a registered code or detail without words in a catalogue, or words for nothing registered. */
export function auditErrorCopy(registry, catalogueData) {
  const found = []
  for (const [file, data] of Object.entries(catalogueData)) {
    const run = data?.RunErrors ?? {}
    for (const [code, details] of Object.entries(registry)) {
      for (const key of ['default', ...details]) {
        const text = run[code]?.[key]
        if (typeof text !== 'string' || !text.trim()) found.push({ file, line: 1, column: 1, rule: 'error-cause/copy', message: `RunErrors.${code}.${key} 缺少文案。${errorCauseMessage}` })
      }
    }
    for (const [code, entries] of Object.entries(run)) {
      if (!Object.hasOwn(registry, code)) { found.push({ file, line: 1, column: 1, rule: 'error-cause/copy', message: `RunErrors.${code} 不在 ${registryFile} 里；删除文案或登记这个错误码。` }); continue }
      for (const key of Object.keys(entries ?? {})) if (key !== 'default' && !registry[code].includes(key))
        found.push({ file, line: 1, column: 1, rule: 'error-cause/copy', message: `RunErrors.${code}.${key} 不是 ${code} 的 detail；删除文案或登记这个 detail。` })
    }
  }
  return found
}

/** A literal `new CodedError("<registered code>", { detail: "<x>" })` must name a registered detail. */
export function auditCodedLiterals(file, source, registry) {
  const found = []
  for (const match of source.matchAll(/new\s+CodedError\(\s*["']([a-z][a-z0-9_]*)["']\s*,\s*\{[^}]*?\bdetail:\s*["']([a-z][a-z0-9_]*)["']/g)) {
    const [, code, detail] = match
    if (Object.hasOwn(registry, code) && !registry[code].includes(detail))
      found.push({ file, line: lineOf(source, match.index), column: 1, rule: 'error-cause/copy', message: `${code} 没有登记 detail「${detail}」（${registryFile}）。${errorCauseMessage}` })
  }
  return found
}

function balanced(source, open, opening, closing) {
  for (let depth = 0, i = open; i < source.length; i++) {
    if (source[i] === opening) depth++
    else if (source[i] === closing && --depth === 0) return source.slice(open, i + 1)
  }
  return source.slice(open)
}

/** Every throw of a new error inside a catch block that hands nothing of the caught error on. */
export function findDroppedCauses(file, source) {
  const found = []
  const lines = source.split('\n')
  const blocks = [...source.matchAll(/\bcatch\s*(?:\(\s*([A-Za-z_$][\w$]*)?[^)]*\))?\s*\{/g)].map(match => {
    const open = match.index + match[0].length - 1
    return { open, end: open + balanced(source, open, '{', '}').length, name: match[1] }
  })
  if (!blocks.length) return found
  for (const thrown of source.matchAll(/\bthrow\s+(?:new\s+)?[A-Za-z_$][\w$.]*\s*\(/g)) {
    // The innermost catch around this throw decides which error it must hand on.
    const block = blocks.filter(b => b.open < thrown.index && thrown.index < b.end).sort((a, b) => b.open - a.open)[0]
    if (!block) continue
    const args = balanced(source, thrown.index + thrown[0].length - 1, '(', ')')
    if (/\bcause\b/.test(args)) continue
    if (block.name && new RegExp(`(?<![\\w$.])${block.name.replace(/\$/g, '\\$')}(?![\\w$])`).test(args)) continue
    const line = lineOf(source, thrown.index)
    if (/\/\/\s*error-cause:\s*\S/.test(lines[line - 1]) || /\/\/\s*error-cause:\s*\S/.test(lines[line - 2] ?? '')) continue
    found.push({ file, line, column: thrown.index - source.lastIndexOf('\n', thrown.index - 1), rule: 'error-cause/dropped', message: errorCauseMessage })
  }
  return found
}

/**
 * Empty and locked at 0 since the 2026-11-21 burn-down (#1330): every
 * catch-bound throw now hands the caught error on as `{ cause }`, or carries
 * an `// error-cause:` justification where a provider body or crypto failure
 * must never escape. Do not add entries here.
 */
export const droppedCauseAllowlist = Object.freeze({})

export function auditDroppedCauses(file, source, allowlist = droppedCauseAllowlist) {
  const found = findDroppedCauses(file, source)
  const allowed = allowlist[file] ?? 0
  if (found.length <= allowed) return []
  return found.map(d => ({ ...d, message: allowed ? `${d.message}（allowlist 只允许这个文件 ${allowed} 处，现在 ${found.length} 处）` : d.message }))
}

export function errorCauseFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .concat(officialCoreFiles())
    .filter(file => errorCauseRoots.some(root => file.startsWith(root))
      && /\.(?:[cm]?[jt]sx?)$/.test(file)
      && !/(?:^|\/)(?:node_modules|\.next|dist|out|build|__tests__|tests?|e2e|fakes)\//.test(file)
      && !/\.(?:test|spec|fixture|stories|node-test)\.[cm]?[jt]sx?$/.test(file)
      && !file.endsWith('.d.ts')
      && uiExists(file))
}

export function readRegistry() {
  return parseRegistry(readFileSync(registryFile, 'utf8'))
}

export function auditRepository() {
  // A checkout without the registry (the UI policy's own fixture repository) has no codes to check.
  const registry = existsSync(registryFile) ? readRegistry() : {}
  const found = existsSync(registryFile) ? auditErrorCopy(registry, Object.fromEntries(catalogues.map(file => [file, JSON.parse(readFileSync(file, 'utf8'))]))) : []
  if (Object.keys(droppedCauseAllowlist).length > 0) {
    found.push({ file: 'scripts/error-cause-policy.mjs', line: 108, column: 1, rule: 'error-cause/allowlist-locked', message: 'droppedCauseAllowlist is permanently locked at 0 entries; pass { cause } or add an // error-cause: justification instead.' })
  }
  for (const file of errorCauseFiles()) {
    const source = readUi(file)
    found.push(...auditCodedLiterals(file, source, registry), ...auditDroppedCauses(file, source))
  }
  return found
}

/** Allowlist entries that no longer match the code: a fixed drop, or a count to lower. */
export function staleAllowlistEntries(allowlist = droppedCauseAllowlist) {
  return Object.entries(allowlist).flatMap(([file, hits]) => {
    if (unverifiable(file)) return []
    if (!uiExists(file)) return [`${file}: file no longer exists; delete its droppedCauseAllowlist entry`]
    const found = findDroppedCauses(file, readUi(file)).length
    if (found === 0) return [`${file}: no dropped cause left; delete its droppedCauseAllowlist entry`]
    if (found < hits) return [`${file}: ${found} dropped causes, allowlist says ${hits}; lower it`]
    return []
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = auditRepository()
  for (const d of found) console.error(`${d.file}:${d.line}:${d.column} error [${d.rule}] ${d.message}`)
  if (process.argv.includes('--counts')) {
    const counts = {}
    for (const file of errorCauseFiles()) { const n = findDroppedCauses(file, readUi(file)).length; if (n) counts[file] = n }
    console.log(JSON.stringify(counts, null, 2))
  }
  process.exitCode = found.length ? 1 : 0
}
