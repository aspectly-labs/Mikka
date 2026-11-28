import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = process.cwd()
const LOCALES = ['zh-CN', 'en']
const MESSAGES_DIR = path.join(ROOT, 'messages')
const CJK = /[㐀-䶿一-鿿豈-﫿]/
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']

export function flattenMessages(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) flattenMessages(child, next, out)
    else out.set(next, child)
  }
  return out
}

export function extractPlaceholders(value) {
  return new Set([...String(value).matchAll(/\{\s*([A-Za-z0-9_]+)\s*[,}]/g)].map(match => match[1]))
}

export function compareMessages(messages) {
  const [first, ...rest] = LOCALES
  const reference = flattenMessages(messages[first])
  const problems = []
  for (const locale of rest) {
    const current = flattenMessages(messages[locale])
    for (const key of reference.keys()) {
      if (!current.has(key)) problems.push(`${locale}: missing key "${key}"`)
    }
    for (const key of current.keys()) {
      if (!reference.has(key)) problems.push(`${locale}: extra key "${key}"`)
    }
  }
  for (const locale of LOCALES) {
    const flat = flattenMessages(messages[locale])
    for (const [key, value] of flat) {
      if (typeof value !== 'string' || !value.trim()) problems.push(`${locale}: "${key}" must be a non-empty string`)
      else if (value.includes('\uFFFD')) problems.push(`${locale}: "${key}" contains a Unicode replacement character`)
    }
  }
  const english = flattenMessages(messages.en)
  const chinese = flattenMessages(messages['zh-CN'])
  for (const key of english.keys()) {
    if (!chinese.has(key)) continue
    const a = extractPlaceholders(english.get(key))
    const b = extractPlaceholders(chinese.get(key))
    for (const name of a) if (!b.has(name)) problems.push(`zh-CN: "${key}" is missing placeholder {${name}}`)
    for (const name of b) if (!a.has(name)) problems.push(`en: "${key}" is missing placeholder {${name}}`)
  }
  return problems
}

export function extractActionErrorCodes(source) {
  const match = source.match(/ACTION_ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s*as const/)
  if (!match) return null
  return [...match[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map(item => item[1])
}

/**
 * A bot never owns or runs a thread: an Agent runs it and the bot only
 * dispatches it (Alex, 2026-11-02). Copy says 「<Bot> 派出的线程」,
 * never 「<Bot> 的线程」 or 「所属 Bot」, nor "a bot's threads"; and an
 * Agent never dispatches, so 「{agent} 派出」 fails too.
 */
const THREAD_OWNER = {
  'zh-CN': [/所属\s*Bot/i, /(?:Bot|Coordinator|\{(?:agent|bot|botName)\})\s*的线程/i, /它们的线程/, /\{agent\}\s*派出/],
  en: [/\bbots?(?:['’]s?)?\s+threads?\b/i, /\{(?:agent|bot|botName)\}(?:['’]s)?\s+threads?\b/, /\bbots?\b[^.]*\btheir threads\b/i, /\{agent\}\s+dispatched|dispatched by \{agent\}/i],
}

export function findThreadOwnership(messages) {
  const problems = []
  for (const [locale, patterns] of Object.entries(THREAD_OWNER)) {
    for (const [key, value] of flattenMessages(messages[locale] ?? {})) {
      if (typeof value === 'string' && patterns.some(pattern => pattern.test(value))) problems.push(`${locale}: "${key}" says a bot owns a thread ("${value}"); say 「<Bot> 派出的线程」 / "threads a bot dispatched"`)
    }
  }
  return problems
}

/**
 * A thread is 线程 in Chinese (Alex, 2026-11-15; docs/design/glossary.md). 执行线程 and
 * 运行链 have no other meaning in the UI, so they never appear. Nor does 对话: a thread, a
 * Bot chat and the directory are all 线程 (Alex, 2026-11-15); only 对话框 (a dialog box)
 * keeps the characters. 会话 (sign-in sessions) is reviewed by hand.
 */
export function findBannedThreadWords(messages) {
  const problems = []
  for (const [key, value] of flattenMessages(messages['zh-CN'] ?? {})) {
    if (typeof value !== 'string') continue
    if (/执行线程|运行链/.test(value)) problems.push(`zh-CN: "${key}" says 执行线程 or 运行链 ("${value}"); a thread is 线程`)
    if (/对话(?!框)/.test(value)) problems.push(`zh-CN: "${key}" says 对话 ("${value}"); a thread or chat is 线程 (对话框 only for a dialog box)`)
  }
  return problems
}

/**
 * G2 (no-business-literals-in-i18n): pricing, exchange rates, billing rates,
 * and machine SKU specs belong in server data / runtime config, never hardcoded
 * in translation catalogs. Parameterize copy via ICU placeholders instead.
 */
export const I18N_BUSINESS_LITERALS_BASELINE_PATH = 'scripts/baselines/i18n-business-literals.json'

export const BUSINESS_LITERAL_RULES = Object.freeze([
  { category: 'currency amount', pattern: /(?:US\$|\$|¥|€|£)\s*\d+(?:[.,]\d+)?/i },
  { category: 'currency amount', pattern: /\b\d+(?:[.,]\d+)?\s*(?:(?:USD|CNY|EUR|GBP)\b|美元|人民币|元(?!素))/i },
  { category: 'hardcoded rate', pattern: /\b\d+(?:\.\d+)?\s*\/\s*(?:(?:hr|hour|wk|week|mo|month|yr|year)\b|小时|周|月|年)/i },
  { category: 'hardcoded rate', pattern: /(?:US\$|\$|¥|€|£)\s*\d+(?:[.,]\d+)?[^,，。<>]*\/\s*(?:(?:hr|hour|wk|week|mo|month|yr|year)\b|小时|周|月|年)/i },
  { category: 'machine SKU spec', pattern: /\b\d+(?:\.\d+)?\s*(?:vCPU|GiB)\b/i },
  { category: 'credit conversion rate', pattern: /\b\d+(?:[.,]\d+)?\s*(?:(?:credits|points)\b|额度|点数)\s*=\s*/i },
])

function normalizeBusinessLiteralsBaseline(raw, sourceLabel = I18N_BUSINESS_LITERALS_BASELINE_PATH) {
  const allowed = new Set()
  if (raw == null) return { allowed, error: null }
  if (raw instanceof Set) {
    for (const entry of raw) if (typeof entry === 'string' && entry.trim()) allowed.add(entry)
    return { allowed, error: null }
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry.trim()) {
        return { allowed: new Set(), error: `${sourceLabel}: baseline array entries must be non-empty "locale:key" strings` }
      }
      allowed.add(entry)
    }
    return { allowed, error: null }
  }
  if (typeof raw !== 'object') {
    return { allowed: new Set(), error: `${sourceLabel}: baseline must be an array or JSON object` }
  }
  if (Array.isArray(raw.keys)) return normalizeBusinessLiteralsBaseline(raw.keys, sourceLabel)
  if (Array.isArray(raw.entries)) return normalizeBusinessLiteralsBaseline(raw.entries, sourceLabel)

  const target = raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files) ? raw.files : raw
  for (const [key, value] of Object.entries(target)) {
    if (key === 'version' || key === 'rule' || key === 'description' || key === '$schema') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== 'string' || !item.trim()) {
          return { allowed: new Set(), error: `${sourceLabel}: locale "${key}" baseline array must contain non-empty key strings` }
        }
        allowed.add(`${key}:${item}`)
      }
    } else if (value && typeof value === 'object') {
      for (const [nestedKey, nestedCount] of Object.entries(value)) {
        if (nestedCount === true || (Number.isInteger(nestedCount) && nestedCount > 0)) {
          allowed.add(`${key}:${nestedKey}`)
        } else if (nestedCount !== false && nestedCount !== 0) {
          return { allowed: new Set(), error: `${sourceLabel}: invalid baseline count for "${key}:${nestedKey}"` }
        }
      }
    } else if (value === true || (Number.isInteger(value) && value > 0)) {
      allowed.add(key)
    } else if (value !== false && value !== 0) {
      return { allowed: new Set(), error: `${sourceLabel}: invalid baseline entry for "${key}"` }
    }
  }
  return { allowed, error: null }
}

export function loadBusinessLiteralsBaseline(baselinePath = path.join(ROOT, I18N_BUSINESS_LITERALS_BASELINE_PATH)) {
  if (!fs.existsSync(baselinePath)) return { exists: false, allowed: new Set(), error: null }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  } catch (error) {
    return { exists: true, allowed: new Set(), error: `Invalid baseline JSON at ${baselinePath}: ${error.message}` }
  }
  const normalized = normalizeBusinessLiteralsBaseline(parsed, baselinePath)
  return { exists: true, ...normalized }
}

export function findBusinessLiteralsInMessages(messages, options = {}) {
  const problems = []
  let allowed = new Set()

  if (options.baseline !== undefined) {
    const normalized = normalizeBusinessLiteralsBaseline(options.baseline)
    if (normalized.error) problems.push(normalized.error)
    else allowed = normalized.allowed
  } else if (options.baselinePath) {
    const loaded = loadBusinessLiteralsBaseline(options.baselinePath)
    if (loaded.error) problems.push(loaded.error)
    else allowed = loaded.allowed
  }

  for (const [locale, catalog] of Object.entries(messages ?? {})) {
    if (!catalog || typeof catalog !== 'object') continue
    for (const [key, value] of flattenMessages(catalog)) {
      if (typeof value !== 'string') continue
      const categories = []
      for (const rule of BUSINESS_LITERAL_RULES) {
        if (rule.pattern.test(value) && !categories.includes(rule.category)) {
          categories.push(rule.category)
        }
      }
      if (!categories.length) continue
      const entryId = `${locale}:${key}`
      if (allowed.has(entryId)) continue
      problems.push(
        `${locale}: "${key}" contains hardcoded business literal (${categories.join(', ')}) in "${value}"; parameterize via ICU placeholders and supply values from runtime config or server data`,
      )
    }
  }
  return problems
}

export function checkErrorCodes(codes, messages) {
  const problems = []
  for (const locale of LOCALES) {
    const errors = messages[locale]?.Errors
    if (!errors) {
      problems.push(`${locale}: missing "Errors" namespace`)
      continue
    }
    for (const code of codes) {
      if (typeof errors[code] !== 'string' || !errors[code].trim()) problems.push(`${locale}: Errors.${code} is missing`)
    }
  }
  return problems
}

function resolveImport(specifier, fromFile) {
  let base
  if (specifier.startsWith('@/')) base = path.join(ROOT, specifier.slice(2))
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier)
  else return null
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${base}${extension}`
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

function collectEntryPoints() {
  const entries = []
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^(page|layout|not-found|global-not-found|route|error|template)\.(ts|tsx)$/.test(entry.name)) entries.push(full)
    }
  }
  walk(path.join(ROOT, 'app'))
  return entries
}

export function collectReachableFiles(entries = collectEntryPoints()) {
  const seen = new Set()
  const stack = [...entries]
  while (stack.length) {
    const file = stack.pop()
    if (!file || seen.has(file)) continue
    seen.add(file)
    if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveImport(node.moduleSpecifier.text, file)
        if (resolved) stack.push(resolved)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return [...seen].filter(file => file.startsWith(path.join(ROOT, 'app')) || file.startsWith(path.join(ROOT, 'components')) || file.startsWith(path.join(ROOT, 'lib')))
}

function hasIgnoreComment(source, line) {
  const lines = source.split('\n')
  const current = lines[line - 1] ?? ''
  if (current.includes('i18n-ignore')) return true
  return lines.slice(Math.max(0, line - 2), line - 1).some(value => value.includes('i18n-ignore'))
}

function isConsoleCall(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current)) {
      const expression = current.expression
      if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'console') return true
    }
  }
  return false
}

function isModuleSpecifier(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true
  }
  return false
}

export function findHardcodedText(file, source) {
  if (source.slice(0, 400).includes('i18n-ignore-file')) return []
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const problems = []
  const seen = new Set()
  const report = (node, text) => {
    if (!CJK.test(text)) return
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    if (hasIgnoreComment(source, line + 1)) return
    const key = `${line}:${character}:${text}`
    if (seen.has(key)) return
    seen.add(key)
    problems.push(`${path.relative(ROOT, file)}:${line + 1}:${character + 1} hardcoded text "${text.trim().slice(0, 60)}"`)
  }
  const visit = node => {
    if (ts.isJsxText(node)) report(node, node.text)
    else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      report(node, node.initializer.text)
      return
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isModuleSpecifier(node) && !isConsoleCall(node)) report(node, node.text)
    } else if (ts.isTemplateExpression(node)) {
      report(node, node.getText(sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return problems
}

function unwrapAwait(node) {
  return ts.isAwaitExpression(node) ? node.expression : node
}

function namespaceOfCall(node) {
  if (!ts.isCallExpression(node)) return null
  const callee = node.expression
  if (!ts.isIdentifier(callee) || (callee.text !== 'useTranslations' && callee.text !== 'getTranslations')) return null
  const [argument] = node.arguments
  if (!argument) return ''
  if (ts.isStringLiteral(argument)) return argument.text
  if (ts.isObjectLiteralExpression(argument)) {
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
      if (property.name.text !== 'namespace') continue
      const value = unwrapAwait(property.initializer)
      if (ts.isStringLiteral(value)) return value.text
    }
  }
  return null
}

/**
 * Finds literal `t('key')` calls whose resolved key is absent from the reference
 * catalog. A missing key renders as the raw key in the UI, which the CJK scan
 * cannot see in English locales.
 */
export function findMissingTranslationKeys(file, source, reference) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const namespaces = new Map()
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const namespace = namespaceOfCall(unwrapAwait(node.initializer))
      if (namespace !== null) {
        if (!namespaces.has(node.name.text)) namespaces.set(node.name.text, new Set())
        namespaces.get(node.name.text).add(namespace)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const problems = []
  const reported = new Set()
  const check = node => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const found = namespaces.get(node.expression.text)
      // The same variable name bound to two namespaces is ambiguous; skip it.
      if (found.size === 1) {
        const [namespace] = found
        const key = namespace ? `${namespace}.${node.arguments[0].text}` : node.arguments[0].text
        if (!reference.has(key) && !reported.has(key)) {
          reported.add(key)
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          problems.push(`${path.relative(ROOT, file)}:${line + 1} missing translation key "${key}"`)
        }
      }
    }
    ts.forEachChild(node, check)
  }
  check(sourceFile)
  return problems
}

export function checkRepository() {
  const messages = {}
  const problems = []
  for (const locale of LOCALES) {
    const file = path.join(MESSAGES_DIR, `${locale}.json`)
    if (!fs.existsSync(file)) {
      problems.push(`messages/${locale}.json is missing`)
      continue
    }
    try {
      messages[locale] = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      problems.push(`messages/${locale}.json is invalid JSON: ${error.message}`)
    }
  }
  if (problems.length) return problems
  problems.push(...compareMessages(messages))
  problems.push(...findThreadOwnership(messages))
  problems.push(...findBannedThreadWords(messages))
  const businessBaselineFile = path.join(ROOT, I18N_BUSINESS_LITERALS_BASELINE_PATH)
  problems.push(...findBusinessLiteralsInMessages(messages, fs.existsSync(businessBaselineFile) ? { baselinePath: businessBaselineFile } : {}))
  const codeFile = path.join(ROOT, 'lib/action-result.ts')
  if (fs.existsSync(codeFile)) {
    const codes = extractActionErrorCodes(fs.readFileSync(codeFile, 'utf8'))
    if (!codes) problems.push('lib/action-result.ts does not define ACTION_ERROR_CODES')
    else problems.push(...checkErrorCodes(codes, messages))
  }
  const reference = flattenMessages(messages[LOCALES[0]])
  for (const file of collectReachableFiles()) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    problems.push(...findHardcodedText(file, source))
    problems.push(...findMissingTranslationKeys(file, source, reference))
  }
  // The active iOS app lives in private mikka-hosted-ui (mobile-next/) and enforces its own i18n checks there.
  return problems
}

function main() {
  const problems = checkRepository()
  if (problems.length) {
    console.error(`i18n check failed with ${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('i18n check passed: messages aligned, placeholders match, no hardcoded CJK in reachable UI.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
