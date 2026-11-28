#!/usr/bin/env node
/**
 * Mikka Semantic Anti-Hardcoding Lint Engine (Issue #3342).
 *
 * Fast, deterministic, zero-network architectural linter built on the
 * TypeScript compiler AST (`typescript`). Complements mechanical Oxlint gates
 * G1-G6 by catching higher-level semantic anti-hardcoding patterns:
 *
 *   - no-hardcoded-business-policy
 *   - no-mode-flags
 *   - no-provider-or-plan-special-casing
 *   - no-constant-stub-tests
 *
 * Usage:
 *   node scripts/semantic-lint/index.mjs [--mode=warn|error] [--json] [--root <dir>] [--rule <name>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

import noHardcodedBusinessPolicyRule from './rules/no-hardcoded-business-policy.mjs'
import noModeFlagsRule from './rules/no-mode-flags.mjs'
import noProviderOrPlanSpecialCasingRule from './rules/no-provider-or-plan-special-casing.mjs'
import noConstantStubTestsRule from './rules/no-constant-stub-tests.mjs'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURES_ROOT = path.resolve(REPO_ROOT, 'scripts/semantic-lint/fixtures')

export const RULES = Object.freeze([
  noHardcodedBusinessPolicyRule,
  noModeFlagsRule,
  noProviderOrPlanSpecialCasingRule,
  noConstantStubTestsRule,
])

export const RULE_MAP = Object.freeze(Object.fromEntries(RULES.map(rule => [rule.name, rule])))

export const DEFAULT_SCAN_ROOTS = Object.freeze([
  'app',
  'apps/api',
  'apps/desktop',
  'apps/eve',
  'apps/frontend/src',
  'cloudflare',
  'lib',
  'packages',
  'services',
  'tests',
  'workflows',
])

export const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs'])

export const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  '.output',
  '.hosted-ui',
  '.git',
  '.nitro',
  '.cache',
  'coverage',
])

export const EXCLUDED_REL_PREFIXES = Object.freeze([
  'apps/api/generated',
  'scripts/semantic-lint/fixtures',
])

const VALID_ALLOW_DIRECTIVE_RE =
  /^\/\/\s*semantic-lint-allow:\s*([a-z][a-z0-9-]*)(?:\s+(?:—|–|--|-)\s+|\s*(?:—|–|--|:)\s+)(\S.*)$/
const ANY_ALLOW_DIRECTIVE_RE = /^\/\/\s*semantic-lint-allow\b(?::\s*([a-z][a-z0-9-]*))?/

const globRegexCache = new Map()

/**
 * Convert a posix glob pattern into a RegExp matching normalized repo-relative paths.
 * Supports `**\/`, `\/**`, `**`, `*`, and `?`.
 */
export function globToRegExp(glob) {
  const cached = globRegexCache.get(glob)
  if (cached) return cached

  let source = '^'
  let i = 0
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?'
      i += 3
      continue
    }
    if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      source += '/.*'
      i += 3
      continue
    }
    if (glob.startsWith('**', i)) {
      source += '.*'
      i += 2
      continue
    }
    const ch = glob[i]
    if (ch === '*') {
      source += '[^/]*'
    } else if (ch === '?') {
      source += '[^/]'
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      source += `\\${ch}`
    } else {
      source += ch
    }
    i += 1
  }
  source += '$'

  const regex = new RegExp(source)
  globRegexCache.set(glob, regex)
  return regex
}

/**
 * Normalize a file path into a posix path relative to `rootDir`.
 */
export function normalizeRepoPath(filePath, rootDir = REPO_ROOT) {
  const resolvedRoot = path.resolve(rootDir)
  const resolvedFile = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(resolvedRoot, filePath)
  return path.relative(resolvedRoot, resolvedFile).split(path.sep).join('/').replace(/^\.\//, '')
}

/**
 * Returns true if `relPath` matches any glob pattern in `patterns`.
 */
export function isAllowedPath(relPath, patterns) {
  if (!relPath || !patterns?.length) return false
  const normalized = relPath.split(path.sep).join('/').replace(/^\.\//, '')
  return patterns.some(pattern => globToRegExp(pattern).test(normalized))
}

function getScriptKind(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.tsx') return ts.ScriptKind.TSX
  if (ext === '.ts' || ext === '.mts') return ts.ScriptKind.TS
  if (ext === '.js' || ext === '.mjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function computeLineStarts(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function offsetToLineColumn(lineStarts, offset) {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lineStarts[mid] <= offset) lo = mid + 1
    else hi = mid - 1
  }
  const lineIndex = Math.max(0, hi)
  return {
    line: lineIndex + 1,
    column: offset - lineStarts[lineIndex] + 1,
  }
}

/**
 * Extract valid and malformed `// semantic-lint-allow:` comments using the
 * TypeScript lexer so string literals containing directive text are ignored.
 *
 * Valid syntax:
 *   // semantic-lint-allow: <rule-name> — <reason>
 *   (also accepts --, –, -, or : as separator; reason must have >= 3 meaningful chars)
 */
function collectSingleLineCommentsFromAst(source, filePath = 'file.ts') {
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    false,
    getScriptKind(filePath),
  )
  const seen = new Set()
  const comments = []

  const recordRanges = ranges => {
    if (!ranges) return
    for (const range of ranges) {
      if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue
      if (seen.has(range.pos)) continue
      seen.add(range.pos)
      comments.push({
        pos: range.pos,
        text: source.slice(range.pos, range.end).trim(),
      })
    }
  }

  const visit = node => {
    recordRanges(ts.getLeadingCommentRanges(source, node.pos))
    recordRanges(ts.getTrailingCommentRanges(source, node.end))
    for (const child of node.getChildren(sf)) {
      visit(child)
    }
  }
  visit(sf)
  comments.sort((a, b) => a.pos - b.pos)
  return comments
}

export function parseAllowDirectives(source, knownRules = new Set(Object.keys(RULE_MAP)), filePath = 'file.ts') {
  const allowedByLine = new Map()
  const invalidDirectives = []

  if (!source.includes('semantic-lint-allow')) {
    return { allowedByLine, invalidDirectives }
  }

  const lineStarts = computeLineStarts(source)
  const comments = collectSingleLineCommentsFromAst(source, filePath)

  for (const { pos, text } of comments) {
    if (!ANY_ALLOW_DIRECTIVE_RE.test(text)) continue

    const { line, column } = offsetToLineColumn(lineStarts, pos)
    const validMatch = VALID_ALLOW_DIRECTIVE_RE.exec(text)

    if (validMatch) {
      const ruleName = validMatch[1]
      const reason = validMatch[2].trim()
      const meaningfulReason = reason.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '')
      if (!knownRules.has(ruleName)) {
        invalidDirectives.push({
          line,
          column,
          ruleName: null,
          message: `Unknown rule "${ruleName}" in semantic-lint-allow directive; valid rules are: ${[...knownRules].join(', ')}.`,
        })
        continue
      }
      if (meaningfulReason.length < 3) {
        invalidDirectives.push({
          line,
          column,
          ruleName,
          message: `Bare or trivial semantic-lint-allow directive for "${ruleName}" is forbidden; provide an explicit justification reason (e.g. "// semantic-lint-allow: ${ruleName} — <reason>").`,
        })
        continue
      }
      let set = allowedByLine.get(line)
      if (!set) {
        set = new Set()
        allowedByLine.set(line, set)
      }
      set.add(ruleName)
    } else {
      const candidateMatch = ANY_ALLOW_DIRECTIVE_RE.exec(text)
      const candidateRule = candidateMatch?.[1] && knownRules.has(candidateMatch[1]) ? candidateMatch[1] : null
      invalidDirectives.push({
        line,
        column,
        ruleName: candidateRule,
        message: candidateRule
          ? `Bare semantic-lint-allow directive for "${candidateRule}" is forbidden; include an explicit reason after "—" (e.g. "// semantic-lint-allow: ${candidateRule} — <reason>").`
          : 'Malformed semantic-lint-allow directive; use "// semantic-lint-allow: <rule-name> — <reason>" with an explicit justification.',
      })
    }
  }

  return { allowedByLine, invalidDirectives }
}

function isLineSuppressed(allowedByLine, line, ruleName) {
  return Boolean(
    allowedByLine.get(line)?.has(ruleName)
    || allowedByLine.get(line - 1)?.has(ruleName),
  )
}

function isExcludedRelPath(relPath) {
  for (const prefix of EXCLUDED_REL_PREFIXES) {
    if (relPath === prefix || relPath.startsWith(`${prefix}/`)) return true
  }
  return false
}

function isPathInside(targetPath, basePath) {
  const rel = path.relative(basePath, targetPath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/**
 * Discover candidate `.ts`, `.tsx`, `.mts`, `.js`, `.mjs` files to scan.
 * When scanning `REPO_ROOT` (the default), restricts traversal to
 * `DEFAULT_SCAN_ROOTS`. When `--root <path>` points to a subdirectory or file
 * inside the repository (outside `scripts/semantic-lint/fixtures`), keeps
 * repository-relative policy paths so architectural allowlists remain intact.
 * For external directories and fixture trees, computes paths relative to the
 * supplied target directory (or parent directory for a single external file).
 */
export function collectTargetFiles(rootDir = REPO_ROOT, options = {}) {
  const resolvedRoot = path.resolve(rootDir)
  const useDefaultRoots = options.useDefaultRoots ?? (resolvedRoot === REPO_ROOT)
  const scanRoots = options.scanRoots ?? DEFAULT_SCAN_ROOTS
  const files = []

  const walk = (absDir, pathBaseDir, ignoreMissingDir) => {
    let entries
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch (error) {
      if (ignoreMissingDir && error && error.code === 'ENOENT') return
      throw new Error(`Failed to read directory ${absDir}`, { cause: error })
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const absChild = path.join(absDir, entry.name)
      const relChild = normalizeRepoPath(absChild, pathBaseDir)
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
        if (isExcludedRelPath(relChild)) continue
        walk(absChild, pathBaseDir, false)
      } else if (entry.isFile()) {
        if (isExcludedRelPath(relChild)) continue
        const ext = path.extname(entry.name).toLowerCase()
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue
        files.push({ absPath: absChild, relPath: relChild })
      }
    }
  }

  if (useDefaultRoots) {
    for (const relRoot of scanRoots) {
      walk(path.join(resolvedRoot, relRoot), resolvedRoot, true)
    }
  } else {
    let stat
    try {
      stat = fs.statSync(resolvedRoot)
    } catch (error) {
      throw new Error(`Failed to stat target ${resolvedRoot}`, { cause: error })
    }
    const useRepoPolicyBase =
      isPathInside(resolvedRoot, REPO_ROOT) && !isPathInside(resolvedRoot, FIXTURES_ROOT)
    const pathBaseDir = useRepoPolicyBase
      ? REPO_ROOT
      : stat.isFile()
        ? path.dirname(resolvedRoot)
        : resolvedRoot

    if (stat.isFile()) {
      const ext = path.extname(resolvedRoot).toLowerCase()
      if (SUPPORTED_EXTENSIONS.has(ext)) {
        files.push({
          absPath: resolvedRoot,
          relPath: normalizeRepoPath(resolvedRoot, pathBaseDir),
        })
      }
    } else {
      walk(resolvedRoot, pathBaseDir, false)
    }
  }

  return files
}

/**
 * Run the semantic lint engine programmatically and return a structured report.
 */
export function runSemanticLint(options = {}) {
  const mode = options.mode ?? 'error'
  if (mode !== 'warn' && mode !== 'error') {
    throw new Error(`Invalid --mode "${mode}": expected "warn" or "error".`)
  }

  const rootDir = path.resolve(options.root ?? REPO_ROOT)
  const requestedRules = options.rules?.length ? options.rules : RULES.map(rule => rule.name)
  const activeRules = []
  for (const name of requestedRules) {
    const rule = RULE_MAP[name]
    if (!rule) {
      throw new Error(`Unknown rule "${name}". Available rules: ${Object.keys(RULE_MAP).join(', ')}`)
    }
    if (!activeRules.includes(rule)) activeRules.push(rule)
  }

  const activeRuleNames = new Set(activeRules.map(rule => rule.name))
  const startedAt = performance.now()
  const candidates = collectTargetFiles(rootDir, {
    useDefaultRoots: options.useDefaultRoots,
    scanRoots: options.scanRoots,
  })

  const findings = []
  const byRule = Object.fromEntries(activeRules.map(rule => [rule.name, 0]))
  let filesScanned = 0

  for (const { absPath, relPath } of candidates) {
    const applicableRules = activeRules.filter(rule => {
      if (typeof rule.matchesFile === 'function' && !rule.matchesFile(relPath)) return false
      if (isAllowedPath(relPath, rule.allowlist)) return false
      return true
    })

    if (applicableRules.length === 0) continue

    let source
    try {
      source = fs.readFileSync(absPath, 'utf8')
    } catch (error) {
      throw new Error(`Failed to read source file ${absPath}`, { cause: error })
    }
    filesScanned += 1

    const { allowedByLine, invalidDirectives } = parseAllowDirectives(source, undefined, relPath)

    for (const bad of invalidDirectives) {
      const targetRule = bad.ruleName ?? activeRules[0]?.name ?? 'semantic-lint-directive'
      if (bad.ruleName && !activeRuleNames.has(bad.ruleName)) continue
      findings.push({
        rule: targetRule,
        file: relPath,
        line: bad.line,
        column: bad.column,
        message: bad.message,
      })
      byRule[targetRule] = (byRule[targetRule] ?? 0) + 1
    }

    const rulesToRun = applicableRules.filter(
      rule => typeof rule.mightMatch !== 'function' || rule.mightMatch(source),
    )
    if (rulesToRun.length === 0) continue

    let cachedSourceFile = null
    const getSourceFile = () => {
      if (!cachedSourceFile) {
        cachedSourceFile = ts.createSourceFile(
          relPath,
          source,
          ts.ScriptTarget.Latest,
          false,
          getScriptKind(absPath),
        )
      }
      return cachedSourceFile
    }

    for (const rule of rulesToRun) {
      const report = (nodeOrPos, message) => {
        const sf = getSourceFile()
        const pos = typeof nodeOrPos === 'number'
          ? nodeOrPos
          : typeof nodeOrPos?.getStart === 'function'
            ? nodeOrPos.getStart(sf)
            : 0
        const { line: zeroLine, character: zeroCol } = sf.getLineAndCharacterOfPosition(pos)
        const line = zeroLine + 1
        const column = zeroCol + 1

        if (isLineSuppressed(allowedByLine, line, rule.name)) return

        findings.push({
          rule: rule.name,
          file: relPath,
          line,
          column,
          message,
        })
        byRule[rule.name] = (byRule[rule.name] ?? 0) + 1
      }

      rule.check({
        filePath: absPath,
        relPath,
        source,
        ts,
        getSourceFile,
        report,
      })
    }
  }

  findings.sort((a, b) =>
    a.file.localeCompare(b.file)
    || a.line - b.line
    || a.column - b.column
    || a.rule.localeCompare(b.rule),
  )

  return {
    mode,
    filesScanned,
    totalFindings: findings.length,
    byRule,
    findings,
    durationMs: Math.round(performance.now() - startedAt),
  }
}

export function formatHumanReport(report) {
  const lines = []
  if (report.totalFindings === 0) {
    lines.push(
      `semantic-lint (${report.mode}): 0 findings across ${report.filesScanned} files (${report.durationMs}ms)`,
    )
    return lines.join('\n')
  }

  for (const finding of report.findings) {
    lines.push(`${finding.file}:${finding.line}:${finding.column} [${finding.rule}] ${finding.message}`)
  }

  const summary = Object.entries(report.byRule)
    .filter(([, count]) => count > 0)
    .map(([rule, count]) => `${rule}=${count}`)
    .join(', ')

  lines.push('')
  lines.push(
    `semantic-lint (${report.mode}): ${report.totalFindings} finding(s) across ${report.filesScanned} files (${summary}; ${report.durationMs}ms)`,
  )
  return lines.join('\n')
}

export function parseArgs(argv) {
  const opts = {
    mode: 'error',
    json: false,
    root: null,
    rules: [],
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else if (arg === '--json') {
      opts.json = true
    } else if (arg.startsWith('--mode=')) {
      opts.mode = arg.slice('--mode='.length)
    } else if (arg === '--mode') {
      const next = argv[i + 1]
      if (!next) throw new Error('--mode requires a value ("warn" or "error").')
      opts.mode = next
      i += 1
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length)
      if (!value) throw new Error('--root requires a directory path.')
      opts.root = value
    } else if (arg === '--root') {
      const next = argv[i + 1]
      if (!next) throw new Error('--root requires a directory path.')
      opts.root = next
      i += 1
    } else if (arg.startsWith('--rule=')) {
      const value = arg.slice('--rule='.length)
      for (const part of value.split(',').map(s => s.trim()).filter(Boolean)) {
        opts.rules.push(part)
      }
    } else if (arg === '--rule') {
      const next = argv[i + 1]
      if (!next) throw new Error('--rule requires a rule name.')
      for (const part of next.split(',').map(s => s.trim()).filter(Boolean)) {
        opts.rules.push(part)
      }
      i += 1
    } else {
      throw new Error(`Unknown CLI argument: "${arg}". Run with --help for usage.`)
    }
  }

  if (opts.mode !== 'warn' && opts.mode !== 'error') {
    throw new Error(`Invalid --mode "${opts.mode}": expected "warn" or "error".`)
  }

  return opts
}

function printHelp() {
  console.log([
    'Usage: node scripts/semantic-lint/index.mjs [options]',
    '',
    'Options:',
    '  --mode=warn|error   Enforcement mode (default: error). warn prints findings and exits 0.',
    '  --json              Output structured JSON report { mode, filesScanned, totalFindings, byRule, findings }.',
    '  --root <dir>        Scan an alternate root directory instead of the repository.',
    '  --rule <name>       Run only the specified rule(s) (repeatable or comma-separated).',
    '  -h, --help          Show this help message.',
    '',
    `Available rules: ${RULES.map(rule => rule.name).join(', ')}`,
  ].join('\n'))
}

function main(argv = process.argv.slice(2)) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    console.error(`semantic-lint: ${error.message}`)
    process.exitCode = 2
    return
  }

  if (opts.help) {
    printHelp()
    process.exitCode = 0
    return
  }

  let report
  try {
    report = runSemanticLint({
      mode: opts.mode,
      root: opts.root ?? REPO_ROOT,
      rules: opts.rules.length ? opts.rules : undefined,
    })
  } catch (error) {
    console.error(`semantic-lint: ${error.message}`)
    process.exitCode = 2
    return
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatHumanReport(report))
  }

  process.exitCode = report.mode === 'error' && report.totalFindings > 0 ? 1 : 0
}

const isDirectExecution =
  typeof process.argv[1] === 'string'
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectExecution) {
  main()
}
