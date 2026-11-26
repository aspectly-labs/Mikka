/**
 * Oxlint JS plugin enforcing Mikka's anti-hardcoding gates (Issue #3342):
 *   - mikka/no-raw-process-env (G1)
 *   - mikka/no-plan-name-branching (G3)
 *   - mikka/no-hardcoded-model-ids (G4)
 *   - mikka/no-hardcoded-hosts (G5)
 *
 * Each rule supports an optional ratchet baseline at
 * `scripts/baselines/<rule-name>.json`. When the baseline file is absent,
 * zero tolerance applies (0 allowed). When present, only listed files up to
 * their recorded max count are suppressed; any new file or any count increase
 * fails immediately.
 */
import fs from 'node:fs'
import path from 'node:path'

export const PLUGIN_NAME = 'mikka'
export const BASELINE_DIR = 'scripts/baselines'

export const PLAN_IDENTIFIERS = Object.freeze([
  'plan',
  'entitlementPlan',
  'billingPlan',
  'workspacePlan',
  'currentPlan',
  'orgPlan',
  'planId',
  'planName',
])
export const PLAN_IDENTIFIER_PATTERN = /(?:^|_)(?:plan|entitlementPlan|billingPlan|workspacePlan|currentPlan|orgPlan|planId|planName)$/i
export const PLAN_NAME_LITERALS = Object.freeze(['free', 'pro', 'enterprise', 'starter', 'max'])
export const EDITION_IDENTIFIER_PATTERN = /(?:^|_)(?:edition|workspaceEdition)$/i
export const PLAN_EDITION_LITERALS = Object.freeze(['team_free', 'team_pro', 'enterprise'])

export const HARDCODED_MODEL_ID_PATTERN = /(?:^|[\s/.,:'"`([])(?:claude-|gpt-|gemini-)[a-z0-9._:-]+/i
export const HARDCODED_MODEL_ID_REGEX_PATTERN = /(?:^|[\s/.,:'"`([^|?)]|\\b)(?:claude-|gpt-|gemini-)[a-z0-9._:-]+/i
export const HARDCODED_HOST_PATTERN =
  /127\.0\.0\.1|localhost|product\.internal|\[::1\]|(?:^|[\s/=,;'"`(@])(?:::1)(?=$|[\s/=,;'"`)?#])/i
export const HARDCODED_HOST_REGEX_PATTERN =
  /127\\?\.0\\?\.0\\?\.1|localhost|product\\?\.internal|\\\[::1\\\]|(?:^|[\s/=,;'"`(@^|?)])(?:::1)(?=$|[\s/=,;'"`)?#$|(])/i

export const RULE_ALLOWLISTS = Object.freeze({
  'no-raw-process-env': Object.freeze([
    'lib/env/**',
    'scripts/**',
    'tests/**',
    '**/test/**',
    '**/tests/**',
    '**/fixtures/**',
    '**/*.test.*',
    '**/*.db.test.*',
    '**/*.spec.*',
    '**/*.fixture.*',
    '**/*.bench.*',
    '**/testing/**',
    'cloudflare/api/start.mjs',
    'services/credential-broker/server.mjs',
    'playwright*.config.*',
    'next.config.*',
    'drizzle.config.*',
  ]),
  'no-plan-name-branching': Object.freeze([
    'lib/governance/policy.ts',
    'lib/governance/capabilities.ts',
    'lib/governance/provisioning.ts',
    'lib/enterprise/provisioning.ts',
    'lib/billing/catalog.ts',
    'lib/billing/resource-plan.ts',
    'lib/billing/subscription-webhook.ts',
    'scripts/**',
    'tests/**',
    '**/*.test.*',
    '**/*.db.test.*',
    '**/*.spec.*',
  ]),
  'no-hardcoded-model-ids': Object.freeze([
    'lib/model-catalog.ts',
    'lib/model-catalog-metadata.ts',
    'lib/model-catalog-server.ts',
    'lib/model-catalog-snapshot.json',
    'lib/model-display-name.ts',
    'scripts/**',
    'tests/**',
    '**/test/**',
    '**/tests/**',
    '**/fixtures/**',
    '**/*.test.*',
    '**/*.db.test.*',
    '**/*.spec.*',
    '**/*.fixture.*',
    '**/*.bench.*',
    '**/testing/**',
  ]),
  'no-hardcoded-hosts': Object.freeze([
    'lib/env/**',
    'scripts/**',
    'tests/**',
    '**/test/**',
    '**/tests/**',
    '**/fixtures/**',
    '**/*.test.*',
    '**/*.db.test.*',
    '**/*.spec.*',
    '**/*.fixture.*',
    '**/*.bench.*',
    '**/testing/**',
    'apps/desktop/scripts/**',
    'apps/api/scripts/**',
    'cloudflare/api/ops-alert-forwarder.mjs',
    'playwright*.config.*',
  ]),
})

const GLOBAL_PROCESS_ROOTS = new Set(['globalThis', 'global'])
const PROCESS_IMPORT_SOURCES = new Set(['process', 'node:process'])
const PLAN_LITERAL_SET = new Set(PLAN_NAME_LITERALS)
const PLAN_EDITION_LITERAL_SET = new Set(PLAN_EDITION_LITERALS)
const EQUALITY_OPERATORS = new Set(['===', '!==', '==', '!='])
const STRING_NORMALIZATION_METHODS = new Set([
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
])

const RULE_OPTIONS_SCHEMA = [
  {
    type: 'object',
    properties: {
      baselinePath: { type: 'string' },
      rootDir: { type: 'string' },
    },
    additionalProperties: false,
  },
]

const globRegexCache = new Map()
const baselineCache = new Map()

/**
 * Convert a posix glob pattern into a RegExp matching normalized repo-relative paths.
 * Supports `**\/`, `\/**\/`, `\/**`, `**`, `*`, and `?`.
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
 * Normalize a linted file path into a posix repo-relative path.
 */
export function normalizeRepoPath(filename, rootDir = process.cwd()) {
  if (!filename || filename === '<input>' || filename === '<text>') return ''
  const resolvedRoot = path.resolve(rootDir)
  const resolvedFile = path.isAbsolute(filename) ? path.normalize(filename) : path.resolve(resolvedRoot, filename)
  const rel = path.relative(resolvedRoot, resolvedFile).split(path.sep).join('/')
  return rel.replace(/^\.\//, '')
}

/**
 * Returns true if `relPath` matches any allowlist glob pattern.
 */
export function isAllowedPath(relPath, patterns) {
  if (!relPath) return false
  const normalized = relPath.split(path.sep).join('/').replace(/^\.\//, '')
  return patterns.some(pattern => globToRegExp(pattern).test(normalized))
}

export function clearBaselineCache() {
  baselineCache.clear()
}

/**
 * Load an optional ratchet baseline file.
 * Supports either flat `{ "path/to/file.ts": maxCount }` or wrapped `{ "files": { "path/to/file.ts": maxCount } }`.
 */
export function loadBaselineMap(baselinePath) {
  let stat
  try {
    stat = fs.statSync(baselinePath)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      baselineCache.delete(baselinePath)
      return { exists: false, counts: {}, error: null }
    }
    return { exists: true, counts: {}, error: `Failed to stat baseline ${baselinePath}: ${error.message}` }
  }

  const cached = baselineCache.get(baselinePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.result
  }

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  } catch (error) {
    const result = { exists: true, counts: {}, error: `Invalid baseline JSON at ${baselinePath}: ${error.message}` }
    baselineCache.set(baselinePath, { mtimeMs: stat.mtimeMs, size: stat.size, result })
    return result
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const result = { exists: true, counts: {}, error: `Baseline at ${baselinePath} must be a JSON object` }
    baselineCache.set(baselinePath, { mtimeMs: stat.mtimeMs, size: stat.size, result })
    return result
  }

  const rawMap = parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)
    ? parsed.files
    : parsed

  const counts = Object.create(null)
  for (const [key, value] of Object.entries(rawMap)) {
    if (key === 'version' || key === 'rule' || key === 'description' || key === '$schema') continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      const result = {
        exists: true,
        counts: {},
        error: `Baseline at ${baselinePath} has invalid non-integer count for "${key}"`,
      }
      baselineCache.set(baselinePath, { mtimeMs: stat.mtimeMs, size: stat.size, result })
      return result
    }
    const normalizedKey = key.split(path.sep).join('/').replace(/^\.\//, '')
    counts[normalizedKey] = value
  }

  const result = { exists: true, counts, error: null }
  baselineCache.set(baselinePath, { mtimeMs: stat.mtimeMs, size: stat.size, result })
  return result
}

export function getBaselineLimit(ruleName, relPath, options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : process.cwd()
  const baselinePath = options.baselinePath
    ? path.resolve(rootDir, options.baselinePath)
    : path.join(rootDir, BASELINE_DIR, `${ruleName}.json`)
  const loaded = loadBaselineMap(baselinePath)
  if (loaded.error) return { allowedCount: 0, error: loaded.error, exists: loaded.exists, baselinePath }
  if (!loaded.exists) return { allowedCount: 0, error: null, exists: false, baselinePath }
  const normalized = relPath.split(path.sep).join('/').replace(/^\.\//, '')
  const allowedCount = Object.hasOwn(loaded.counts, normalized) ? loaded.counts[normalized] : 0
  return { allowedCount, error: null, exists: true, baselinePath }
}

function unwrapExpr(node) {
  let current = node
  while (current) {
    if (
      current.type === 'ParenthesizedExpression'
      || current.type === 'TSAsExpression'
      || current.type === 'TSSatisfiesExpression'
      || current.type === 'TSNonNullExpression'
      || current.type === 'TSTypeAssertion'
      || current.type === 'ChainExpression'
    ) {
      current = current.expression
      continue
    }
    if (
      current.type === 'CallExpression'
      && (current.arguments?.length ?? 0) === 1
      && current.arguments[0]?.type !== 'SpreadElement'
    ) {
      const callee = unwrapExpr(current.callee)
      if (
        callee?.type === 'MemberExpression'
        && getStaticPropertyName(callee) === 'freeze'
      ) {
        const obj = unwrapExpr(callee.object)
        if (obj?.type === 'Identifier' && obj.name === 'Object') {
          current = current.arguments[0]
          continue
        }
      }
    }
    break
  }
  return current
}

function getStaticStringValue(node) {
  const expr = unwrapExpr(node)
  if (!expr) return null
  if (expr.type === 'Literal' && typeof expr.value === 'string') return expr.value
  if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0 && expr.quasis.length === 1) {
    return expr.quasis[0].value.cooked ?? expr.quasis[0].value.raw
  }
  return null
}

function getStaticPropertyName(node) {
  if (!node || node.type !== 'MemberExpression') return null
  if (!node.computed) {
    return node.property?.type === 'Identifier' ? node.property.name : null
  }
  return getStaticStringValue(node.property)
}

function getObjectPropertyKeyName(prop) {
  if (!prop || prop.type !== 'Property') return null
  if (!prop.computed) {
    if (prop.key?.type === 'Identifier') return prop.key.name
    return getStaticStringValue(prop.key)
  }
  return getStaticStringValue(prop.key)
}

function isProcessObject(node) {
  const obj = unwrapExpr(node)
  if (!obj) return false
  if (obj.type === 'Identifier' && obj.name === 'process') return true
  if (obj.type === 'MemberExpression' && getStaticPropertyName(obj) === 'process') {
    const root = unwrapExpr(obj.object)
    return root?.type === 'Identifier' && GLOBAL_PROCESS_ROOTS.has(root.name)
  }
  return false
}

function isProcessEnvMember(node) {
  if (!node || node.type !== 'MemberExpression') return false
  if (getStaticPropertyName(node) !== 'env') return false
  return isProcessObject(node.object)
}

function unwrapNormalizedStringExpr(node) {
  let current = unwrapExpr(node)
  while (current) {
    if (current.type === 'CallExpression' && (current.arguments?.length ?? 0) === 0) {
      const callee = unwrapExpr(current.callee)
      if (callee?.type === 'MemberExpression') {
        const method = getStaticPropertyName(callee)
        if (method && STRING_NORMALIZATION_METHODS.has(method)) {
          current = unwrapExpr(callee.object)
          continue
        }
      }
    }
    break
  }
  return current
}

function matchesIdentifierPattern(node, pattern) {
  const expr = unwrapNormalizedStringExpr(node)
  if (!expr) return false
  if (expr.type === 'Identifier') return pattern.test(expr.name)
  if (expr.type === 'MemberExpression') {
    const prop = getStaticPropertyName(expr)
    return prop !== null && pattern.test(prop)
  }
  if (expr.type === 'LogicalExpression' && (expr.operator === '??' || expr.operator === '||')) {
    return matchesIdentifierPattern(expr.left, pattern)
  }
  return false
}

function isPlanReference(node) {
  return matchesIdentifierPattern(node, PLAN_IDENTIFIER_PATTERN)
}

function isEditionReference(node) {
  return matchesIdentifierPattern(node, EDITION_IDENTIFIER_PATTERN)
}

function getLiteralInSet(node, set) {
  const value = getStaticStringValue(node)
  if (value !== null && set.has(value)) return value
  return null
}

function getPlanNameLiteral(node) {
  return getLiteralInSet(node, PLAN_LITERAL_SET)
}

function getPlanEditionLiteral(node) {
  return getLiteralInSet(node, PLAN_EDITION_LITERAL_SET)
}

function arrayContainsLiteralInSet(node, set) {
  const expr = unwrapExpr(node)
  if (!expr || expr.type !== 'ArrayExpression') return false
  return expr.elements.some(el => el && el.type !== 'SpreadElement' && getLiteralInSet(el, set) !== null)
}

function arrayHasOnlyLiteralsInSet(node, set) {
  const expr = unwrapExpr(node)
  if (!expr || expr.type !== 'ArrayExpression' || expr.elements.length === 0) return false
  return expr.elements.every(el => el && el.type !== 'SpreadElement' && getLiteralInSet(el, set) !== null)
}

function isLiteralSetExpression(node, set) {
  const expr = unwrapExpr(node)
  if (!expr || expr.type !== 'NewExpression') return false
  const callee = unwrapExpr(expr.callee)
  if (!callee || callee.type !== 'Identifier' || callee.name !== 'Set') return false
  return expr.arguments.length >= 1 && arrayContainsLiteralInSet(expr.arguments[0], set)
}

function isObjectWithMinKeys(node, set, minKeys = 2) {
  const expr = unwrapExpr(node)
  if (!expr || expr.type !== 'ObjectExpression') return false
  const matched = new Set()
  for (const prop of expr.properties ?? []) {
    const key = getObjectPropertyKeyName(prop)
    if (key !== null && set.has(key)) matched.add(key)
  }
  return matched.size >= minKeys
}

function createModuleSpecifierTracker() {
  const specifiers = new WeakSet()
  const markSource = node => {
    if (node?.source) specifiers.add(node.source)
  }
  return {
    specifiers,
    visitors: {
      ImportDeclaration: markSource,
      ExportNamedDeclaration: markSource,
      ExportAllDeclaration: markSource,
      ImportExpression: markSource,
      CallExpression(node) {
        const callee = unwrapExpr(node.callee)
        if (callee?.type === 'Identifier' && callee.name === 'require' && node.arguments?.[0]) {
          specifiers.add(node.arguments[0])
        }
      },
    },
  }
}

function createRatchetedRule({ ruleName, allowlist, meta, createVisitors }) {
  return {
    meta: {
      type: 'problem',
      schema: RULE_OPTIONS_SCHEMA,
      ...meta,
    },
    create(context) {
      const option = context.options?.[0] ?? {}
      const baseCwd = context.cwd ?? process.cwd()
      const rootDir = option.rootDir ? path.resolve(baseCwd, option.rootDir) : baseCwd
      const rawFilename = context.filename ?? (typeof context.getFilename === 'function' ? context.getFilename() : '')
      const relPath = normalizeRepoPath(rawFilename, rootDir)

      if (isAllowedPath(relPath, allowlist)) {
        return {}
      }

      const baseline = getBaselineLimit(ruleName, relPath, {
        rootDir,
        baselinePath: option.baselinePath,
      })

      const violations = []
      const record = (node, message) => {
        violations.push({ node, message })
      }

      const innerVisitors = createVisitors(record, context)
      let programNode = null

      return {
        ...innerVisitors,
        Program(node) {
          programNode = node
          if (typeof innerVisitors.Program === 'function') innerVisitors.Program(node)
        },
        'Program:exit'(node) {
          if (typeof innerVisitors['Program:exit'] === 'function') innerVisitors['Program:exit'](node)
          if (baseline.error) {
            context.report({ node: programNode ?? node, message: baseline.error })
            return
          }
          if (violations.length <= baseline.allowedCount) return
          for (const violation of violations) {
            const suffix = baseline.allowedCount > 0
              ? ` (${violations.length} found in ${relPath}, exceeding baseline max ${baseline.allowedCount})`
              : ''
            context.report({ node: violation.node, message: `${violation.message}${suffix}` })
          }
        },
      }
    },
  }
}

const noRawProcessEnvRule = createRatchetedRule({
  ruleName: 'no-raw-process-env',
  allowlist: RULE_ALLOWLISTS['no-raw-process-env'],
  meta: {
    docs: {
      description: 'Disallow direct process.env, globalThis/global.process.env, destructuring env from process, or importing env from process/node:process outside lib/env/**.',
    },
  },
  createVisitors(record) {
    return {
      MemberExpression(node) {
        if (isProcessEnvMember(node)) {
          record(
            node,
            'Direct process.env access is disallowed outside lib/env/**; read typed configuration through lib/env/** instead.',
          )
        }
      },
      VariableDeclarator(node) {
        if (node.id?.type !== 'ObjectPattern' || !node.init) return
        if (!isProcessObject(node.init)) return
        for (const prop of node.id.properties ?? []) {
          if (getObjectPropertyKeyName(prop) === 'env') {
            record(
              prop,
              'Destructuring env from process is disallowed outside lib/env/**; read typed configuration through lib/env/** instead.',
            )
          }
        }
      },
      ImportDeclaration(node) {
        if (node.importKind === 'type') return
        const source = getStaticStringValue(node.source)
        if (!source || !PROCESS_IMPORT_SOURCES.has(source)) return
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue
          const importedName = specifier.imported?.type === 'Identifier'
            ? specifier.imported.name
            : getStaticStringValue(specifier.imported)
          if (importedName === 'env') {
            record(
              specifier,
              `Importing "env" from "${source}" is disallowed outside lib/env/**; read typed configuration through lib/env/** instead.`,
            )
          }
        }
      },
    }
  },
})

const noPlanNameBranchingRule = createRatchetedRule({
  ruleName: 'no-plan-name-branching',
  allowlist: RULE_ALLOWLISTS['no-plan-name-branching'],
  meta: {
    docs: {
      description: 'Disallow branching on plan name or plan-derived edition strings outside governance/billing policy modules.',
    },
  },
  createVisitors(record) {
    const planArrayVars = new Set()
    const planSetVars = new Set()
    const planObjectVars = new Set()
    const editionArrayVars = new Set()
    const editionSetVars = new Set()
    const editionObjectVars = new Set()
    const deferredIdentifierChecks = []

    return {
      VariableDeclarator(node) {
        if (node.id?.type !== 'Identifier' || !node.init) return
        if (arrayHasOnlyLiteralsInSet(node.init, PLAN_LITERAL_SET)) planArrayVars.add(node.id.name)
        if (isLiteralSetExpression(node.init, PLAN_LITERAL_SET)) planSetVars.add(node.id.name)
        if (isObjectWithMinKeys(node.init, PLAN_LITERAL_SET, 2)) planObjectVars.add(node.id.name)

        if (arrayHasOnlyLiteralsInSet(node.init, PLAN_EDITION_LITERAL_SET)) editionArrayVars.add(node.id.name)
        if (isLiteralSetExpression(node.init, PLAN_EDITION_LITERAL_SET)) editionSetVars.add(node.id.name)
        if (isObjectWithMinKeys(node.init, PLAN_EDITION_LITERAL_SET, 2)) editionObjectVars.add(node.id.name)
      },
      BinaryExpression(node) {
        if (!EQUALITY_OPERATORS.has(node.operator)) return
        const leftIsPlan = isPlanReference(node.left)
        const rightIsPlan = isPlanReference(node.right)
        const matchedPlanLiteral = leftIsPlan
          ? getPlanNameLiteral(node.right)
          : rightIsPlan
            ? getPlanNameLiteral(node.left)
            : null
        if (matchedPlanLiteral !== null) {
          record(
            node,
            `Do not branch on plan name literal "${matchedPlanLiteral}"; check explicit workspace capabilities from lib/governance/capabilities.ts instead.`,
          )
          return
        }

        const leftIsEdition = isEditionReference(node.left)
        const rightIsEdition = isEditionReference(node.right)
        const matchedEditionLiteral = leftIsEdition
          ? getPlanEditionLiteral(node.right)
          : rightIsEdition
            ? getPlanEditionLiteral(node.left)
            : null
        if (matchedEditionLiteral !== null) {
          record(
            node,
            `Do not branch on plan-derived edition literal "${matchedEditionLiteral}"; check explicit workspace capabilities from lib/governance/capabilities.ts instead.`,
          )
        }
      },
      CallExpression(node) {
        const callee = unwrapExpr(node.callee)
        if (!callee || callee.type !== 'MemberExpression') return
        if (!node.arguments?.length) return
        const arg = node.arguments[0]
        const method = getStaticPropertyName(callee)
        const target = unwrapExpr(callee.object)

        if (isPlanReference(arg)) {
          if (method === 'includes') {
            if (arrayContainsLiteralInSet(target, PLAN_LITERAL_SET)) {
              record(
                node,
                'Do not branch on plan name arrays with .includes(); check explicit workspace capabilities from lib/governance/capabilities.ts instead.',
              )
            } else if (target?.type === 'Identifier') {
              deferredIdentifierChecks.push({
                kind: 'planArray',
                name: target.name,
                node,
                message: 'Do not branch on plan name arrays with .includes(); check explicit workspace capabilities from lib/governance/capabilities.ts instead.',
              })
            }
          } else if (method === 'has') {
            if (isLiteralSetExpression(target, PLAN_LITERAL_SET)) {
              record(
                node,
                'Do not branch on plan name sets with .has(); check explicit workspace capabilities from lib/governance/capabilities.ts instead.',
              )
            } else if (target?.type === 'Identifier') {
              deferredIdentifierChecks.push({
                kind: 'planSet',
                name: target.name,
                node,
                message: 'Do not branch on plan name sets with .has(); check explicit workspace capabilities from lib/governance/capabilities.ts instead.',
              })
            }
          }
          return
        }

        if (isEditionReference(arg)) {
          if (method === 'includes') {
            if (arrayContainsLiteralInSet(target, PLAN_EDITION_LITERAL_SET)) {
              record(
                node,
                'Do not branch on plan-derived edition arrays with .includes(); check explicit workspace capabilities from lib/governance/capabilities.ts instead.',
              )
            } else if (target?.type === 'Identifier') {
              deferredIdentifierChecks.push({
                kind: 'editionArray',
                name: target.name,
                node,
                message: 'Do not branch on plan-derived edition arrays with .includes(); check explicit workspace capabilities from lib/governance/capabilities.ts instead.',
              })
            }
          } else if (method === 'has') {
            if (isLiteralSetExpression(target, PLAN_EDITION_LITERAL_SET)) {
              record(
                node,
                'Do not branch on plan-derived edition sets with .has(); check explicit workspace capabilities from lib/governance/capabilities.ts instead.',
              )
            } else if (target?.type === 'Identifier') {
              deferredIdentifierChecks.push({
                kind: 'editionSet',
                name: target.name,
                node,
                message: 'Do not branch on plan-derived edition sets with .has(); check explicit workspace capabilities from lib/governance/capabilities.ts instead.',
              })
            }
          }
        }
      },
      SwitchStatement(node) {
        if (isPlanReference(node.discriminant)) {
          for (const switchCase of node.cases ?? []) {
            const literal = switchCase.test ? getPlanNameLiteral(switchCase.test) : null
            if (literal !== null) {
              record(
                switchCase,
                `Do not switch on plan name literal "${literal}"; check explicit workspace capabilities from lib/governance/capabilities.ts instead.`,
              )
            }
          }
          return
        }

        if (isEditionReference(node.discriminant)) {
          for (const switchCase of node.cases ?? []) {
            const literal = switchCase.test ? getPlanEditionLiteral(switchCase.test) : null
            if (literal !== null) {
              record(
                switchCase,
                `Do not switch on plan-derived edition literal "${literal}"; check explicit workspace capabilities from lib/governance/capabilities.ts instead.`,
              )
            }
          }
        }
      },
      MemberExpression(node) {
        if (!node.computed) return
        const target = unwrapExpr(node.object)
        if (isPlanReference(node.property)) {
          if (isObjectWithMinKeys(target, PLAN_LITERAL_SET, 2)) {
            record(
              node,
              'Do not branch via plan-keyed object lookup; read explicit limits or capabilities from lib/governance/capabilities.ts instead.',
            )
          } else if (target?.type === 'Identifier') {
            deferredIdentifierChecks.push({
              kind: 'planObject',
              name: target.name,
              node,
              message: 'Do not branch via plan-keyed object lookup; read explicit limits or capabilities from lib/governance/capabilities.ts instead.',
            })
          }
          return
        }

        if (isEditionReference(node.property)) {
          if (isObjectWithMinKeys(target, PLAN_EDITION_LITERAL_SET, 2)) {
            record(
              node,
              'Do not branch via plan-derived edition object lookup; read explicit limits or capabilities from lib/governance/capabilities.ts instead.',
            )
          } else if (target?.type === 'Identifier') {
            deferredIdentifierChecks.push({
              kind: 'editionObject',
              name: target.name,
              node,
              message: 'Do not branch via plan-derived edition object lookup; read explicit limits or capabilities from lib/governance/capabilities.ts instead.',
            })
          }
        }
      },
      'Program:exit'() {
        for (const check of deferredIdentifierChecks) {
          const matched = (check.kind === 'planArray' && planArrayVars.has(check.name))
            || (check.kind === 'planSet' && planSetVars.has(check.name))
            || (check.kind === 'planObject' && planObjectVars.has(check.name))
            || (check.kind === 'editionArray' && editionArrayVars.has(check.name))
            || (check.kind === 'editionSet' && editionSetVars.has(check.name))
            || (check.kind === 'editionObject' && editionObjectVars.has(check.name))
          if (matched) record(check.node, check.message)
        }
      },
    }
  },
})

const noHardcodedModelIdsRule = createRatchetedRule({
  ruleName: 'no-hardcoded-model-ids',
  allowlist: RULE_ALLOWLISTS['no-hardcoded-model-ids'],
  meta: {
    docs: {
      description: 'Disallow hardcoded upstream model IDs (claude-*, gpt-*, gemini-*) in strings, templates, and regexes outside the model catalog.',
    },
  },
  createVisitors(record) {
    const tracker = createModuleSpecifierTracker()
    return {
      ...tracker.visitors,
      Literal(node) {
        if (node.regex) {
          if (HARDCODED_MODEL_ID_REGEX_PATTERN.test(node.regex.pattern)) {
            record(
              node,
              `Hardcoded model ID regex /${node.regex.pattern}/${node.regex.flags ?? ''} is disallowed outside the model catalog; use semantic aliases or lib/model-catalog*.ts instead.`,
            )
          }
          return
        }
        if (typeof node.value !== 'string') return
        if (tracker.specifiers.has(node)) return
        if (HARDCODED_MODEL_ID_PATTERN.test(node.value)) {
          record(
            node,
            `Hardcoded model ID "${node.value}" is disallowed outside the model catalog; use semantic aliases or lib/model-catalog*.ts instead.`,
          )
        }
      },
      TemplateElement(node) {
        const text = node.value?.cooked ?? node.value?.raw ?? ''
        if (HARDCODED_MODEL_ID_PATTERN.test(text)) {
          record(
            node,
            `Hardcoded model ID in template literal ("${text.trim()}") is disallowed outside the model catalog; use semantic aliases or lib/model-catalog*.ts instead.`,
          )
        }
      },
    }
  },
})

const noHardcodedHostsRule = createRatchetedRule({
  ruleName: 'no-hardcoded-hosts',
  allowlist: RULE_ALLOWLISTS['no-hardcoded-hosts'],
  meta: {
    docs: {
      description: 'Disallow hardcoded 127.0.0.1, ::1, [::1], localhost, or product.internal literals outside lib/env/**.',
    },
  },
  createVisitors(record) {
    const tracker = createModuleSpecifierTracker()
    return {
      ...tracker.visitors,
      Literal(node) {
        if (node.regex) {
          if (HARDCODED_HOST_REGEX_PATTERN.test(node.regex.pattern)) {
            record(
              node,
              `Hardcoded host regex /${node.regex.pattern}/${node.regex.flags ?? ''} is disallowed outside lib/env/**; centralize host helpers in lib/env/** instead.`,
            )
          }
          return
        }
        if (typeof node.value !== 'string') return
        if (tracker.specifiers.has(node)) return
        if (HARDCODED_HOST_PATTERN.test(node.value)) {
          record(
            node,
            `Hardcoded host literal "${node.value}" is disallowed outside lib/env/**; resolve hosts through lib/env/** instead.`,
          )
        }
      },
      TemplateElement(node) {
        const text = node.value?.cooked ?? node.value?.raw ?? ''
        if (HARDCODED_HOST_PATTERN.test(text)) {
          record(
            node,
            `Hardcoded host in template literal ("${text.trim()}") is disallowed outside lib/env/**; resolve hosts through lib/env/** instead.`,
          )
        }
      },
    }
  },
})

export const rules = {
  'no-raw-process-env': noRawProcessEnvRule,
  'no-plan-name-branching': noPlanNameBranchingRule,
  'no-hardcoded-model-ids': noHardcodedModelIdsRule,
  'no-hardcoded-hosts': noHardcodedHostsRule,
}

const plugin = {
  meta: { name: PLUGIN_NAME },
  rules,
}

export default plugin
