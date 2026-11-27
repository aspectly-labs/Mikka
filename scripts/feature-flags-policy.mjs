// Feature-flag rule as code (mikka-hosted-ui/docs/design/decisions/2026-11-27-0330-staged-rollout-release-flags.md).
//
// 1. Every release flag in `releaseFlags` (lib/feature-flags.ts) has an owner,
//    a description, an `added` date, an optional `fullAt` date (set at 100%) and
//    a `removeBy` date, all UTC (`added`/`fullAt` may be tomorrow in UTC). `removeBy` is at most 60 days after `added` and 14 days
//    after `fullAt`; the day after `removeBy` CI fails, and from 7 days before
//    it docs:check prints a warning so the owner acts first.
// 2. Every flag key a flag read names, as a string literal or a same-file string
//    constant, is declared as a flag in a registry (FLAG_REGISTRIES). This is a
//    backstop: Mikka's typed wrappers (postHogFlag, serverFlagEnabled,
//    productionFlagDefault, the official UI's hooks) take only `FlagKey`
//    (lib/feature-flags.ts), so `pnpm typecheck` catches keys this scan cannot
//    see in them: keys built in template strings with substitutions, and
//    wrappers reached through computed callees. The SDK's own methods take any
//    string; rule 3 keeps them inside their owners instead.
// 3. The PostHog SDK's own flag reads (DIRECT_FLAG_METHODS, including bulk
//    reads such as `getAllFlags()`) are used only in the wrappers that own
//    them (DIRECT_FLAG_OWNERS), and no shipped code casts `as FlagKey`: both
//    would let a plain string past the type.
//
// Runs in `pnpm docs:check` (scripts/docs-check.mjs) for this repository and,
// with --overlay-only, in mikka-hosted-ui's Phase 1 CI for its checkout. Test
// files (by path or name) are not shipped code and are not scanned.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/**
 * Where flags are declared, and how: `key`/`flag` take that property of each
 * entry, `names` the entry names, `values` the entry values, `value` the
 * constant itself. Keep in step with `FlagKey` in lib/feature-flags.ts.
 */
export const FLAG_REGISTRIES = {
  'lib/feature-flags.ts': { upcomingFeatures: 'key', gatedFeatures: 'key', releaseFlags: 'names', proactiveFeatures: 'values', killSwitches: 'values' },
  'lib/deployment-switches.ts': { DEPLOYMENT_SWITCHES: 'flag', PERSON_SWITCHES: 'flag' },
  'lib/runtime-config/schema.ts': { RUNTIME_CONFIG_DEFINITIONS: 'flag' },
  'lib/linear-sync/flags.ts': { LINEAR_SYNC_FLAG: 'value' },
  'lib/subscription-routes.ts': { SUBSCRIPTION_ROUTE_FLAGS: 'values' },
}

/** Functions whose first argument is a PostHog flag key. */
export const FLAG_READERS = new Set([
  'postHogFlag', 'serverFlagEnabled', 'productionFlagDefault', 'getFeatureFlag', 'getFeatureFlagPayload', 'isFeatureEnabled',
  'useFeatureFlagEnabled', 'useFeatureFlagPayload', 'useFeatureFlagVariantKey',
])

/**
 * PostHog SDK flag reads. They take any string (or hand over every flag), so
 * outside the wrappers that own them they would bypass FlagKey; elsewhere a
 * call fails. `reloadFeatureFlags()` reads nothing and stays allowed.
 */
export const DIRECT_FLAG_METHODS = new Set([
  'getFeatureFlag', 'getFeatureFlagPayload', 'getFeatureFlagResult', 'isFeatureEnabled', 'getAllFlags', 'getAllFlagsAndPayloads',
  'evaluateFlags', 'onFeatureFlags', 'useFeatureFlagEnabled', 'useFeatureFlagPayload', 'useFeatureFlagResult', 'useFeatureFlagVariantKey',
  'useActiveFeatureFlags', 'PostHogFeature',
])

/** Where the SDK's flag methods may be called, and why. */
export const DIRECT_FLAG_OWNERS = {
  'lib/analytics/posthog.ts': 'the browser wrapper; postHogFlag takes a FlagKey',
  'lib/posthog-server.ts': 'the server wrapper; serverFlagEnabled takes a FlagKey',
  'packages/protocol/src/analytics-client.ts': 'reads only FeatureFlag (packages/protocol/src/flags.ts), its own closed list',
}

export const MAX_RELEASE_DAYS = 60
export const MAX_DAYS_AFTER_FULL = 14
export const WARN_DAYS = 7

const FLAG_KEY = /^mikka-[a-z0-9]+(?:-[a-z0-9]+)*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
const SOURCE = /\.(?:[cm]?[jt]sx?)$/
const SKIPPED_DIR = /(?:^|\/)(?:\.[^/]+|node_modules|\.next|\.artifacts|dist|dist-[a-z0-9-]+|out|build|coverage|__tests__|__mocks__|tests?|e2e)\//
const TEST_FILE = /(?:\.|-)(?:test|spec|node-test|fixture|stories)\.[cm]?[jt]sx?$|\.test-d\.ts$/
const QUICK = /postHogFlag|serverFlagEnabled|productionFlagDefault|FeatureFlag|isFeatureEnabled|getAllFlags|evaluateFlags|PostHogFeature|useActiveFeatureFlags|FlagKey|flags\[/
const POLICY_FILES = new Set(['scripts/feature-flags-policy.mjs'])

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

/** Top-level `const NAME = …` initializers of a file, by name (unwrapped). */
function constants(tree) {
  const found = new Map()
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) found.set(declaration.name.text, unwrap(declaration.initializer))
    }
  }
  return found
}

/** The `releaseFlags` entries as written, in order (values undefined when not a string literal). */
export function releaseFlagEntries(source = readFileSync('lib/feature-flags.ts', 'utf8')) {
  const registry = constants(parse('lib/feature-flags.ts', source)).get('releaseFlags')
  if (!registry || !ts.isObjectLiteralExpression(registry)) return undefined
  return registry.properties.map(property => {
    const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined
    const fields = {}
    if (value && ts.isObjectLiteralExpression(value)) {
      for (const field of value.properties) {
        if (ts.isPropertyAssignment(field)) fields[nameOf(field.name)] = textOf(unwrap(field.initializer))
      }
    }
    return { key: property.name ? nameOf(property.name) : undefined, owner: fields.owner, description: fields.description, added: fields.added, fullAt: fields.fullAt, removeBy: fields.removeBy }
  })
}

const validDate = value => typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
const todayUtc = () => new Date().toISOString().slice(0, 10)
const addDays = (date, count) => new Date(Date.parse(`${date}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10)

/** Problems (fail CI) and warnings (print only) for the release-flag registry. `today` is YYYY-MM-DD (UTC). */
export function releaseFlagReport({ source = readFileSync('lib/feature-flags.ts', 'utf8'), today = todayUtc() } = {}) {
  const entries = releaseFlagEntries(source)
  if (!entries) return { problems: ['lib/feature-flags.ts: `export const releaseFlags = { … }` is missing; it is the release-flag registry'], warnings: [] }
  const problems = []
  const warnings = []
  // Dates are UTC; an author ahead of UTC (UTC+8) may write tomorrow's UTC date.
  const latest = addDays(today, 1)
  for (const { key, owner, description, added, fullAt, removeBy } of entries) {
    const where = `lib/feature-flags.ts releaseFlags[${key ?? '?'}]`
    const fail = message => problems.push(`${where}: ${message}`)
    if (!key || !FLAG_KEY.test(key)) fail('key must be a literal PostHog key like mikka-new-billing')
    else if (key.endsWith('-off')) fail('a release flag is a gate (true turns the new path on); drop the -off suffix')
    if (!owner?.trim()) fail('owner must be a non-empty string literal')
    if (!description?.trim()) fail('description must be a non-empty string literal')
    const addedOk = validDate(added)
    const removeOk = validDate(removeBy)
    const fullOk = fullAt === undefined || validDate(fullAt)
    if (!addedOk) fail('added must be a YYYY-MM-DD string literal')
    if (!removeOk) fail('removeBy must be a YYYY-MM-DD string literal')
    if (!fullOk) fail('fullAt, once set, must be a YYYY-MM-DD string literal')
    if (addedOk && added > latest) fail(`added ${added} is in the future (UTC)`)
    if (addedOk && removeOk && added > removeBy) fail(`added ${added} is after removeBy ${removeBy}`)
    if (addedOk && removeOk && days(added, removeBy) > MAX_RELEASE_DAYS) fail(`removeBy ${removeBy} is more than ${MAX_RELEASE_DAYS} days after added ${added}`)
    if (fullAt !== undefined && fullOk) {
      if (fullAt > latest) fail(`fullAt ${fullAt} is in the future (UTC); set it when the flag reaches 100%`)
      if (addedOk && fullAt < added) fail(`fullAt ${fullAt} is before added ${added}`)
      if (removeOk && days(fullAt, removeBy) > MAX_DAYS_AFTER_FULL) fail(`removeBy ${removeBy} is more than ${MAX_DAYS_AFTER_FULL} days after fullAt ${fullAt}`)
    }
    if (removeOk && removeBy < today) fail(`past its removeBy date ${removeBy}; delete the flag, its entry and the dead branch (owner: ${owner ?? '?'})`)
    else if (removeOk && days(today, removeBy) <= WARN_DAYS) {
      warnings.push(`${where}: removeBy ${removeBy} is ${days(today, removeBy)} day(s) away; CI fails from the next day at 00:00 UTC (owner: ${owner ?? '?'})`)
    }
  }
  return { problems, warnings }
}

export const releaseFlagProblems = options => releaseFlagReport(options).problems
export const releaseFlagWarnings = options => releaseFlagReport(options).warnings

/** Keys declared as flags in the registries, and any registry entry that cannot be read. */
export function readRegistries(read = path => readFileSync(path, 'utf8'), registries = FLAG_REGISTRIES) {
  const keys = new Set()
  const problems = []
  const add = (path, name, node) => {
    const text = textOf(unwrap(node))
    if (text !== undefined && FLAG_KEY.test(text)) keys.add(text)
    else problems.push(`${path} ${name}: a declared flag must be a literal mikka-… key`)
  }
  for (const [path, variables] of Object.entries(registries)) {
    const found = constants(parse(path, read(path)))
    for (const [name, take] of Object.entries(variables)) {
      const node = found.get(name)
      if (!node) {
        problems.push(`${path}: flag registry ${name} is missing; update FLAG_REGISTRIES and FlagKey together`)
        continue
      }
      if (take === 'value') {
        add(path, name, node)
        continue
      }
      if (!ts.isObjectLiteralExpression(node)) {
        problems.push(`${path}: flag registry ${name} must be an object literal`)
        continue
      }
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue
        const entry = `${name}.${nameOf(property.name) ?? '?'}`
        if (take === 'names') {
          const name = nameOf(property.name)
          if (name && FLAG_KEY.test(name)) keys.add(name)
          else problems.push(`${path} ${entry}: a declared flag must be a literal mikka-… key`)
        } else if (take === 'values') add(path, entry, property.initializer)
        else {
          const value = unwrap(property.initializer)
          const field = value && ts.isObjectLiteralExpression(value)
            ? value.properties.find(item => ts.isPropertyAssignment(item) && nameOf(item.name) === take) : undefined
          if (field) add(path, entry, field.initializer)
          else problems.push(`${path} ${entry}: missing ${take}`)
        }
      }
    }
  }
  return { keys, problems }
}

export const declaredFlagKeys = (...args) => readRegistries(...args).keys

/** The flag keys a file reads by literal or same-file string constant, with their line numbers. */
export function flagKeyReads(file, source) {
  if (!QUICK.test(source)) return []
  const tree = parse(file, source)
  const strings = new Map()
  visit(tree, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isVariableDeclarationList(node.parent)
      && node.parent.flags & ts.NodeFlags.Const) {
      const text = textOf(unwrap(node.initializer))
      if (text !== undefined) strings.set(node.name.text, text)
    }
  })
  const keyOf = node => {
    node = unwrap(node)
    if (!node) return undefined
    if (ts.isIdentifier(node)) return strings.get(node.text)
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
      // A `flags` map is often CLI options; only a PostHog-shaped key here is a flag read.
      const key = name === 'flags' ? keyOf(node.argumentExpression) : undefined
      if (key !== undefined && FLAG_KEY.test(key)) add(node, key)
    }
  })
  return reads
}

const slash = value => value.split(sep).join('/')

/** A shipped source file: tests are recognised by path or name, never by their contents. */
export const isScannedSource = file => SOURCE.test(file) && !file.endsWith('.d.ts') && !SKIPPED_DIR.test(file)
  && !TEST_FILE.test(file) && !POLICY_FILES.has(file)

function gitFiles(cwd) {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean)
  } catch {
    return null
  }
}

function walkFiles(root) {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else found.push(slash(relative(root, path)))
    }
  }
  walk(root)
  return found
}

/** The official UI checkout this run scans, if one is mounted. */
export function overlayCheckout(root = '.', env = process.env) {
  const configured = env.MIKKA_UI_OVERLAY_DIR?.trim()
  const checkout = configured ? resolve(root, configured) : resolve(root, '.hosted-ui')
  return existsSync(checkout) ? checkout : null
}

/** Shipped source files of this repository and/or the mounted official UI checkout (its git-ignored files and build output skipped). */
export function flagPolicyFiles(root = '.', { own = true, overlay = true, env = process.env } = {}) {
  const files = []
  if (own) {
    for (const file of gitFiles(root) ?? []) if (isScannedSource(file)) files.push({ file, path: join(root, file) })
  }
  const checkout = overlay ? overlayCheckout(root, env) : null
  if (checkout) {
    const fromRoot = relative(resolve(root), checkout)
    const label = fromRoot && !fromRoot.startsWith('..') && !isAbsolute(fromRoot) ? slash(fromRoot) : slash(checkout)
    for (const file of gitFiles(checkout) ?? walkFiles(checkout)) {
      if (isScannedSource(file)) files.push({ file: `${label}/${file}`, path: join(checkout, file) })
    }
  }
  return files
}

/** Flag reads whose key no registry declares. */
export function undeclaredFlagKeyProblems({ files = flagPolicyFiles(), declared = declaredFlagKeys() } = {}) {
  return files.flatMap(({ file, path, source }) => flagKeyReads(file, source ?? readFileSync(path, 'utf8'))
    .filter(({ key }) => !declared.has(key))
    .map(({ key, line }) => `${file}:${line}: flag key ${key} is not declared; add it to a flag registry (lib/feature-flags.ts releaseFlags for a staged rollout)`))
}

/**
 * Uses of the SDK's flag methods outside their owners, and `as FlagKey` casts,
 * with line numbers. A use is any reference, not only a call: `posthog.m(…)`,
 * `posthog?.['m']`, `posthog.m.call(…)` / `.bind(…)`, `const { m: g } = posthog`,
 * and importing or re-exporting `m` from a `posthog-*` or `@posthog/*` package
 * (aliases too; for the `PostHogFeature` component the import is enough).
 */
export function flagBypasses(file, source) {
  if (!QUICK.test(source)) return []
  const tree = parse(file, source)
  const found = []
  const line = node => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
  const owner = Object.hasOwn(DIRECT_FLAG_OWNERS, file)
  const bypass = (node, name, how) => found.push(`${file}:${line(node)}: ${how} ${name} takes any string and bypasses FlagKey; read flags through postHogFlag (lib/analytics/posthog.ts) or serverFlagEnabled (lib/posthog-server.ts)`)
  const fromPosthog = node => {
    const declaration = ts.isImportSpecifier(node) ? node.parent.parent.parent : node.parent.parent
    const module = declaration?.moduleSpecifier
    return Boolean(module && ts.isStringLiteral(module) && (module.text.startsWith('posthog-') || module.text.startsWith('@posthog/')))
  }
  // Local names for the FlagKey type: itself and any `import type { FlagKey as K }`.
  const flagKeyNames = new Set(['FlagKey'])
  visit(tree, node => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'FlagKey') flagKeyNames.add(node.name.text)
  })
  const isFlagKeyType = type => {
    if (ts.isTypeReferenceNode(type)) {
      const name = type.typeName
      return ts.isIdentifier(name) ? flagKeyNames.has(name.text) : name.right.text === 'FlagKey'
    }
    if (ts.isImportTypeNode(type) && type.qualifier) {
      const qualifier = type.qualifier
      return (ts.isIdentifier(qualifier) ? qualifier.text : qualifier.right.text) === 'FlagKey'
    }
    return false
  }
  visit(tree, node => {
    if (!owner) {
      if (ts.isPropertyAccessExpression(node) && DIRECT_FLAG_METHODS.has(node.name.text)) bypass(node, node.name.text, 'using')
      else if (ts.isElementAccessExpression(node)) {
        const name = textOf(unwrap(node.argumentExpression))
        if (name && DIRECT_FLAG_METHODS.has(name)) bypass(node, name, 'using')
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && DIRECT_FLAG_METHODS.has(node.expression.text)) {
        bypass(node, node.expression.text, 'calling')
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ? nameOf(node.propertyName) : ts.isIdentifier(node.name) ? node.name.text : undefined
        if (key && DIRECT_FLAG_METHODS.has(key)) bypass(node, key, 'destructuring')
      } else if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && fromPosthog(node)) {
        const name = (node.propertyName ?? node.name).text
        if (DIRECT_FLAG_METHODS.has(name)) bypass(node, name, ts.isImportSpecifier(node) ? 'importing' : 're-exporting')
      }
    }
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && isFlagKeyType(node.type)) {
      found.push(`${file}:${line(node)}: \`as FlagKey\` outside a test hides an undeclared key; declare the flag in a registry instead`)
    }
  })
  return found
}

export function flagBypassProblems({ files = flagPolicyFiles() } = {}) {
  return files.flatMap(({ file, path, source }) => flagBypasses(file, source ?? readFileSync(path, 'utf8')))
}

export function featureFlagReport({ overlayOnly = false } = {}) {
  const registry = readRegistries()
  const release = overlayOnly ? { problems: [], warnings: [] } : releaseFlagReport()
  const files = flagPolicyFiles('.', { own: !overlayOnly })
  return {
    problems: [...registry.problems, ...release.problems, ...undeclaredFlagKeyProblems({ files, declared: registry.keys }), ...flagBypassProblems({ files })],
    warnings: release.warnings,
  }
}

export const featureFlagProblems = options => featureFlagReport(options).problems

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const overlayOnly = process.argv.includes('--overlay-only')
  if (overlayOnly && !overlayCheckout()) {
    console.error('feature flag policy: --overlay-only needs the official UI checkout (MIKKA_UI_OVERLAY_DIR or .hosted-ui)')
    process.exit(1)
  }
  const { problems, warnings } = featureFlagReport({ overlayOnly })
  for (const warning of warnings) console.warn(`warning: ${warning}`)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log(`feature flag policy passed${overlayOnly ? ` (${overlayCheckout()})` : ''}`)
}
