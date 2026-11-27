// Feature-flag rule as code (docs/design/decisions/2026-11-27-0330-staged-rollout-release-flags.md).
//
// 1. Every release flag in `releaseFlags` (lib/feature-flags.ts) has an owner, a
//    description and a `removeBy` date (YYYY-MM-DD) that has not passed. At 100%
//    the flag and its dead branch are deleted; a flag past its date fails CI.
// 2. Every flag key a flag read names, as a string literal or a same-file string
//    constant, is declared in a flag registry (FLAG_REGISTRIES). A read through a
//    registry export (`gatedFeatures.memory.key`, `killSwitches.computerTab`) or a
//    parameter is the registry's own key and needs no check.
//
// Runs in `pnpm docs:check` (scripts/docs-check.mjs). Tests are not shipped code
// and are not scanned; their fixtures may name any key.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/** The files that declare flag keys. Every flag-shaped literal in them is declared. */
export const FLAG_REGISTRIES = [
  'lib/feature-flags.ts',
  'lib/deployment-switches.ts',
  'lib/runtime-config/schema.ts',
  'lib/linear-sync/flags.ts',
  'lib/subscription-routes.ts',
]

/** Functions whose first argument is a PostHog flag key. */
export const FLAG_READERS = new Set([
  'postHogFlag', 'serverFlagEnabled', 'getFeatureFlag', 'getFeatureFlagPayload', 'isFeatureEnabled',
  'useFeatureFlagEnabled', 'useFeatureFlagPayload', 'useFeatureFlagVariantKey',
])

const FLAG_KEY = /^mikka-[a-z0-9]+(?:-[a-z0-9]+)*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const SOURCE = /\.(?:[cm]?[jt]sx?)$/
const SKIPPED_DIR = /(?:^|\/)(?:node_modules|\.next|dist|out|build|__tests__|tests?|e2e)\//
const TEST_FILE = /\.(?:test|spec|node-test|fixture|stories)\.[cm]?[jt]sx?$/
const QUICK = /postHogFlag|serverFlagEnabled|getFeatureFlag|isFeatureEnabled|useFeatureFlag|flags\[/
const POLICY_FILES = new Set(['scripts/feature-flags-policy.mjs', 'scripts/feature-flags-policy.test.mjs'])

const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
  /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS)

function unwrap(node) {
  while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression
  return node
}

const textOf = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
const nameOf = name => ts.isIdentifier(name) ? name.text : textOf(name)

function visit(node, each) {
  each(node)
  ts.forEachChild(node, child => visit(child, each))
}

/** The `releaseFlags` entries as written, in order: `{ key, owner, removeBy, description }` (values undefined when not a literal). */
export function releaseFlagEntries(source = readFileSync('lib/feature-flags.ts', 'utf8')) {
  const file = parse('lib/feature-flags.ts', source)
  let registry
  visit(file, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'releaseFlags') registry = unwrap(node.initializer)
  })
  if (!registry || !ts.isObjectLiteralExpression(registry)) return undefined
  return registry.properties.map(property => {
    const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined
    const fields = {}
    if (value && ts.isObjectLiteralExpression(value)) {
      for (const field of value.properties) {
        if (ts.isPropertyAssignment(field)) fields[nameOf(field.name)] = textOf(unwrap(field.initializer))
      }
    }
    return { key: property.name ? nameOf(property.name) : undefined, owner: fields.owner, removeBy: fields.removeBy, description: fields.description }
  })
}

const validDate = value => DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

/** Problems with the release-flag registry. `today` is YYYY-MM-DD (UTC). */
export function releaseFlagProblems({ source = readFileSync('lib/feature-flags.ts', 'utf8'), today = new Date().toISOString().slice(0, 10) } = {}) {
  const entries = releaseFlagEntries(source)
  if (!entries) return ['lib/feature-flags.ts: `export const releaseFlags = { … }` is missing; it is the release-flag registry']
  return entries.flatMap(({ key, owner, removeBy, description }) => {
    const where = `lib/feature-flags.ts releaseFlags[${key ?? '?'}]`
    const problems = []
    if (!key || !FLAG_KEY.test(key)) problems.push(`${where}: key must be a literal PostHog key like mikka-new-billing`)
    else if (key.endsWith('-off')) problems.push(`${where}: a release flag is a gate (true turns the new path on); drop the -off suffix`)
    if (!owner?.trim()) problems.push(`${where}: owner must be a non-empty string literal`)
    if (!description?.trim()) problems.push(`${where}: description must be a non-empty string literal`)
    if (!removeBy || !validDate(removeBy)) problems.push(`${where}: removeBy must be a YYYY-MM-DD string literal`)
    else if (removeBy < today) problems.push(`${where}: past its removeBy date ${removeBy}; delete the flag, its entry and the dead branch (owner: ${owner ?? '?'})`)
    return problems
  })
}

/** Every flag-shaped string literal in the registry files. */
export function declaredFlagKeys(read = path => readFileSync(path, 'utf8'), registries = FLAG_REGISTRIES) {
  const keys = new Set()
  for (const path of registries) {
    visit(parse(path, read(path)), node => {
      const text = textOf(node)
      if (text && FLAG_KEY.test(text)) keys.add(text)
    })
  }
  return keys
}

/** The flag keys a file reads by literal or same-file string constant, with their line numbers. */
export function flagKeyReads(file, source) {
  if (!QUICK.test(source)) return []
  const tree = parse(file, source)
  const constants = new Map()
  visit(tree, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isVariableDeclarationList(node.parent)
      && node.parent.flags & ts.NodeFlags.Const) {
      const text = textOf(unwrap(node.initializer))
      if (text !== undefined) constants.set(node.name.text, text)
    }
  })
  const keyOf = node => {
    node = unwrap(node)
    if (!node) return undefined
    if (ts.isIdentifier(node)) return constants.get(node.text)
    return textOf(node)
  }
  const reads = []
  const add = (node, key) => {
    if (key !== undefined) reads.push({ key, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
  }
  visit(tree, node => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
        : ts.isIdentifier(node.expression) ? node.expression.text : undefined
      if (callee && FLAG_READERS.has(callee) && node.arguments.length) add(node, keyOf(node.arguments[0]))
    } else if (ts.isElementAccessExpression(node)) {
      const target = unwrap(node.expression)
      const name = ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : undefined
      if (name === 'flags') add(node, keyOf(node.argumentExpression))
    }
  })
  return reads
}

const slash = value => value.split(sep).join('/')
const isTestSource = source => /\bfrom\s+['"](?:node:test|vitest|bun:test|@playwright\/test)['"]/.test(source)
const scanned = file => SOURCE.test(file) && !file.endsWith('.d.ts') && !SKIPPED_DIR.test(file) && !TEST_FILE.test(file) && !POLICY_FILES.has(file)

/** Shipped source files of this repository, plus the official UI checkout when it is mounted. */
export function flagPolicyFiles(root = '.') {
  const own = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean).filter(scanned).map(file => ({ file, path: join(root, file) }))
  const configured = process.env.MIKKA_UI_OVERLAY_DIR?.trim()
  const checkout = configured ? resolve(root, configured) : join(root, '.hosted-ui')
  if (!existsSync(checkout)) return own
  const overlay = []
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else {
        const file = slash(relative(checkout, path))
        if (scanned(file)) overlay.push({ file: `.hosted-ui/${file}`, path })
      }
    }
  }
  walk(checkout)
  return own.concat(overlay)
}

/** Flag reads whose key no registry declares. */
export function undeclaredFlagKeyProblems({ files = flagPolicyFiles(), declared = declaredFlagKeys() } = {}) {
  return files.flatMap(({ file, path, source }) => {
    const text = source ?? readFileSync(path, 'utf8')
    if (isTestSource(text)) return []
    return flagKeyReads(file, text)
      .filter(({ key }) => !declared.has(key))
      .map(({ key, line }) => `${file}:${line}: flag key ${key} is not declared; add it to a flag registry (${FLAG_REGISTRIES[0]} releaseFlags for a staged rollout)`)
  })
}

export function featureFlagProblems() {
  return [...releaseFlagProblems(), ...undeclaredFlagKeyProblems()]
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const problems = featureFlagProblems()
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log('feature flag policy passed')
}
