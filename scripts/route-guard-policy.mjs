#!/usr/bin/env node
// Ratcheted API route guard policy: every new route under app/api/**/route.ts must
// wrap its exported HTTP handlers in `defineRoute(spec, handler)` from
// `@/lib/primitives/define-route` with explicit `auth`, `origin`, and `workspace`.
// Legacy unguarded routes are pinned in `scripts/route-guard-baseline.json` so the
// ceiling can only go down as routes migrate.
//
// Usage: node scripts/route-guard-policy.mjs                  check; exits 1 on violations
//        node scripts/route-guard-policy.mjs --base <ref>     also enforce diff-aware migration against <ref>
//        node scripts/route-guard-policy.mjs --json           print scan + audit JSON
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { trustedPolicyBase } from './external-client-mock-policy.mjs'

export const BASELINE_PATH = 'scripts/route-guard-baseline.json'
export const DEFINE_ROUTE_MODULE = 'lib/primitives/define-route'
export const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
export const VALID_AUTH = new Set([
  'public',
  'session',
  'mobile-or-session',
  'human-session-only',
  'cron-secret',
  'webhook-signature',
])
export const VALID_ORIGIN = new Set([
  'any',
  'same-origin-or-desktop',
  'native-mobile-allowed',
])
export const VALID_WORKSPACE = new Set([
  'none',
  'member',
  'admin',
  'pat-scoped',
])
const NON_SESSION_AUTH = new Set(['public', 'cron-secret', 'webhook-signature'])
const TRANSPARENT_WRAPPERS = new Set(['withRequestLog', 'freshSessionRoute', 'cronJob'])

function isExported(node) {
  return Boolean(node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
}

function bindingNames(node) {
  if (ts.isIdentifier(node)) return [node.text]
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    return node.elements.flatMap(element => (ts.isBindingElement(element) ? bindingNames(element.name) : []))
  }
  return []
}

function normalizeModuleTarget(file, specifier) {
  if (specifier.startsWith('@/')) {
    return specifier.slice(2).replace(/\.[cm]?[jt]sx?$/, '')
  }
  if (specifier.startsWith('.')) {
    return posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.[cm]?[jt]sx?$/, '')
  }
  return specifier
}

function unwrapExpression(node) {
  let current = node
  while (current) {
    if (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isNonNullExpression(current)
    ) {
      current = current.expression
      continue
    }
    break
  }
  return current
}

function propertyNameText(name) {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function stringLiteralValue(node) {
  const unwrapped = unwrapExpression(node)
  if (!unwrapped) return null
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text
  return null
}

function lineNumber(tree, node) {
  return tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
}

function resolveObjectLiteral(node, declarations, seen = new Set()) {
  const unwrapped = unwrapExpression(node)
  if (!unwrapped) return null
  if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped
  if (ts.isIdentifier(unwrapped) && !seen.has(unwrapped.text)) {
    const next = new Set(seen)
    next.add(unwrapped.text)
    return resolveObjectLiteral(declarations.get(unwrapped.text), declarations, next)
  }
  return null
}

function validateDefineRouteSpec(file, tree, callNode, declarations) {
  const errors = []
  const line = lineNumber(tree, callNode)
  const specArg = callNode.arguments[0]
  const specObj = resolveObjectLiteral(specArg, declarations)
  if (!specObj) {
    errors.push(`${file}:${line} defineRoute spec must be a static object literal with explicit auth, origin, and workspace`)
    return errors
  }

  const props = new Map()
  for (const prop of specObj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = propertyNameText(prop.name)
      if (key) props.set(key, prop.initializer)
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      props.set(prop.name.text, prop.name)
    } else if (ts.isMethodDeclaration(prop)) {
      const key = propertyNameText(prop.name)
      if (key) props.set(key, prop)
    }
  }

  const auth = stringLiteralValue(props.get('auth'))
  const origin = stringLiteralValue(props.get('origin'))
  const workspace = stringLiteralValue(props.get('workspace'))

  if (!auth || !VALID_AUTH.has(auth)) {
    errors.push(`${file}:${line} defineRoute spec requires explicit valid literal \`auth\` (${[...VALID_AUTH].join(' | ')})`)
  }
  if (!origin || !VALID_ORIGIN.has(origin)) {
    errors.push(`${file}:${line} defineRoute spec requires explicit valid literal \`origin\` (${[...VALID_ORIGIN].join(' | ')})`)
  }
  if (!workspace || !VALID_WORKSPACE.has(workspace)) {
    errors.push(`${file}:${line} defineRoute spec requires explicit valid literal \`workspace\` (${[...VALID_WORKSPACE].join(' | ')})`)
  }
  if (auth && NON_SESSION_AUTH.has(auth) && workspace && workspace !== 'none') {
    errors.push(`${file}:${line} defineRoute auth "${auth}" must use workspace: "none" (got "${workspace}")`)
  }
  if (auth === 'webhook-signature' && !props.has('verifyWebhook')) {
    errors.push(`${file}:${line} defineRoute auth "webhook-signature" must provide \`verifyWebhook\``)
  }

  return errors
}

function findDefineRouteCall(node, defineRouteNames, declarations, seen = new Set()) {
  const unwrapped = unwrapExpression(node)
  if (!unwrapped) return null
  if (ts.isIdentifier(unwrapped) && !seen.has(unwrapped.text)) {
    const next = new Set(seen)
    next.add(unwrapped.text)
    return findDefineRouteCall(declarations.get(unwrapped.text), defineRouteNames, declarations, next)
  }
  if (ts.isCallExpression(unwrapped)) {
    const callee = unwrapExpression(unwrapped.expression)
    if (ts.isIdentifier(callee) && defineRouteNames.has(callee.text)) {
      return unwrapped
    }
    if (ts.isIdentifier(callee) && TRANSPARENT_WRAPPERS.has(callee.text)) {
      for (const arg of unwrapped.arguments) {
        const nested = findDefineRouteCall(arg, defineRouteNames, declarations, seen)
        if (nested) return nested
      }
    }
  }
  return null
}

/**
 * Statically inspects one `app/api/.../route.ts` file.
 * A route is `guarded` only when every exported HTTP method handler is wrapped in
 * `defineRoute(...)` imported from `@/lib/primitives/define-route` with a valid spec.
 */
export function inspectApiRouteSource(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const defineRouteNames = new Set()
  const declarations = new Map()
  const exportedMethods = new Map()

  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      const moduleSpecifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''
      if (normalizeModuleTarget(file, moduleSpecifier) === DEFINE_ROUTE_MODULE) {
        const bindings = statement.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (element.isTypeOnly) continue
            const imported = (element.propertyName ?? element.name).text
            if (imported === 'defineRoute') defineRouteNames.add(element.name.text)
          }
        }
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          declarations.set(name, declaration.initializer)
          if (isExported(statement) && HTTP_METHODS.has(name)) {
            exportedMethods.set(name, declaration.initializer ?? null)
          }
        }
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement) && HTTP_METHODS.has(statement.name.text)) {
      exportedMethods.set(statement.name.text, statement)
    }
  }

  for (const statement of tree.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue
        const exportedName = element.name.text
        if (!HTTP_METHODS.has(exportedName)) continue
        if (statement.moduleSpecifier) {
          exportedMethods.set(exportedName, null)
        } else {
          const localName = element.propertyName?.text ?? exportedName
          exportedMethods.set(exportedName, declarations.get(localName) ?? null)
        }
      }
    }
  }

  const methods = [...exportedMethods.keys()].sort()
  const guardedMethods = []
  const unguardedMethods = []
  const specErrors = []

  for (const method of methods) {
    const initializer = exportedMethods.get(method)
    const call = defineRouteNames.size
      ? findDefineRouteCall(initializer, defineRouteNames, declarations)
      : null
    if (!call) {
      unguardedMethods.push(method)
      continue
    }
    const errors = validateDefineRouteSpec(file, tree, call, declarations)
    if (errors.length) {
      specErrors.push(...errors)
    } else {
      guardedMethods.push(method)
    }
  }

  const status = specErrors.length > 0
    ? 'invalid'
    : methods.length > 0 && unguardedMethods.length === 0
      ? 'guarded'
      : 'unguarded'

  return { file, status, methods, guardedMethods, unguardedMethods, specErrors }
}

/** Lists all `app/api/.../route.ts` files (tracked and untracked, excluding gitignored paths). */
export function apiRouteFiles(root = process.cwd()) {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).split('\0')
  return [...new Set(files)]
    .filter(file => /^app\/api\/(?:.+\/)?route\.ts$/.test(file) && existsSync(resolve(root, file)))
    .sort()
}

export function scanApiRoutes(root = process.cwd()) {
  const files = apiRouteFiles(root)
  const results = files.map(file => inspectApiRouteSource(file, readFileSync(resolve(root, file), 'utf8')))
  return {
    total: results.length,
    guarded: results.filter(entry => entry.status === 'guarded'),
    unguarded: results.filter(entry => entry.status === 'unguarded'),
    invalid: results.filter(entry => entry.status === 'invalid'),
    results,
  }
}

function validateBaselineSchema(baseline, label) {
  const problems = []
  if (!baseline || typeof baseline !== 'object') {
    return [`${label}: must be a JSON object`]
  }
  if (baseline.version !== 1) {
    problems.push(`${label}: expected version 1`)
  }
  if (!Number.isInteger(baseline.maxUnguardedRoutes) || baseline.maxUnguardedRoutes < 0) {
    problems.push(`${label}: maxUnguardedRoutes must be a non-negative integer`)
  }
  if (!Array.isArray(baseline.legacyRoutes)) {
    problems.push(`${label}: legacyRoutes must be an array`)
    return problems
  }
  const seen = new Set()
  for (let i = 0; i < baseline.legacyRoutes.length; i++) {
    const entry = baseline.legacyRoutes[i]
    if (typeof entry !== 'string' || !/^app\/api\/(?:.+\/)?route\.ts$/.test(entry)) {
      problems.push(`${label}: invalid legacyRoutes entry ${JSON.stringify(entry)}`)
      continue
    }
    if (seen.has(entry)) problems.push(`${label}: duplicate legacyRoutes entry ${entry}`)
    seen.add(entry)
    if (i > 0 && baseline.legacyRoutes[i - 1] > entry) {
      problems.push(`${label}: legacyRoutes must be sorted (${baseline.legacyRoutes[i - 1]} > ${entry})`)
    }
  }
  if (
    Number.isInteger(baseline.maxUnguardedRoutes)
    && baseline.maxUnguardedRoutes !== baseline.legacyRoutes.length
  ) {
    problems.push(
      `${label}: maxUnguardedRoutes (${baseline.maxUnguardedRoutes}) must equal legacyRoutes.length (${baseline.legacyRoutes.length})`,
    )
  }
  if (baseline.exemptRoutes !== undefined) {
    if (!baseline.exemptRoutes || typeof baseline.exemptRoutes !== 'object' || Array.isArray(baseline.exemptRoutes)) {
      problems.push(`${label}: exemptRoutes must be an object mapping legacy route paths to { reason }`)
    } else {
      for (const [file, entry] of Object.entries(baseline.exemptRoutes)) {
        if (!seen.has(file)) {
          problems.push(`${label}: exemptRoutes entry ${file} must also be an existing legacyRoutes entry`)
        }
        const reason = typeof entry === 'object' && entry !== null ? entry.reason : ''
        if (typeof reason !== 'string' || reason.trim().length < 20) {
          problems.push(`${label}: exemptRoutes entry ${file} requires a reason of at least 20 characters`)
        }
      }
    }
  }
  return problems
}

export function auditApiRoutes(scan, baseline, previous = baseline, options = {}) {
  const problems = validateBaselineSchema(baseline, BASELINE_PATH)
  if (problems.length) return problems

  // Ratchet against trusted base: baseline ceiling and legacy list may only shrink.
  if (previous && previous !== baseline) {
    const prevSet = new Set(previous.legacyRoutes ?? [])
    if (
      Number.isInteger(previous.maxUnguardedRoutes)
      && baseline.maxUnguardedRoutes > previous.maxUnguardedRoutes
    ) {
      problems.push(
        `${BASELINE_PATH}: maxUnguardedRoutes increased from ${previous.maxUnguardedRoutes} to ${baseline.maxUnguardedRoutes}; the route-guard baseline may only shrink`,
      )
    }
    for (const file of baseline.legacyRoutes) {
      if (!prevSet.has(file)) {
        problems.push(
          `${BASELINE_PATH}: cannot add ${file} to legacyRoutes; new API routes must use defineRoute(...) from @/lib/primitives/define-route`,
        )
      }
    }
  }

  const legacySet = new Set(baseline.legacyRoutes)
  const exemptSet = new Set(Object.keys(baseline.exemptRoutes ?? {}))
  const byFile = new Map(scan.results.map(entry => [entry.file, entry]))

  for (const entry of scan.invalid) {
    problems.push(...entry.specErrors)
  }

  for (const entry of scan.unguarded) {
    if (!legacySet.has(entry.file)) {
      const methods = entry.unguardedMethods.length ? entry.unguardedMethods.join(', ') : 'no HTTP methods'
      problems.push(
        `${entry.file}: unguarded API route (${methods}) is not in ${BASELINE_PATH}; wrap exported handlers in defineRoute(...) from @/lib/primitives/define-route`,
      )
    }
  }

  // Diff-aware Boy Scout rule: modifying any existing legacy unguarded route requires
  // migrating it onto `defineRoute(...)` (unless explicitly exempted with a documented reason).
  const modifiedRoutes = options.modifiedRoutes ?? []
  for (const file of modifiedRoutes) {
    const entry = byFile.get(file)
    if (!entry || entry.status !== 'unguarded') continue
    if (!legacySet.has(file) || exemptSet.has(file)) continue
    const methods = entry.unguardedMethods.length ? entry.unguardedMethods.join(', ') : 'no HTTP methods'
    problems.push(
      `${file}: modified legacy unguarded API route (${methods}) must be migrated to defineRoute(...) from @/lib/primitives/define-route (or documented under exemptRoutes in ${BASELINE_PATH})`,
    )
  }

  const totalNonGuarded = scan.unguarded.length + scan.invalid.length
  if (totalNonGuarded > baseline.maxUnguardedRoutes) {
    problems.push(
      `unguarded API route count (${totalNonGuarded}) exceeds ratchet ceiling maxUnguardedRoutes (${baseline.maxUnguardedRoutes})`,
    )
  }

  // Enforce strict downward ratchet: migrated or removed legacy routes must leave the baseline.
  for (const file of baseline.legacyRoutes) {
    const entry = byFile.get(file)
    if (!entry) {
      problems.push(
        `${BASELINE_PATH}: stale entry ${file} no longer exists; remove it and lower maxUnguardedRoutes`,
      )
    } else if (entry.status === 'guarded') {
      problems.push(
        `${BASELINE_PATH}: stale entry ${file} is now guarded with defineRoute; remove it and lower maxUnguardedRoutes`,
      )
    }
  }

  return problems
}

export function modifiedApiRoutes(root = process.cwd(), base) {
  if (!base) return []
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  let diffBase = base
  try {
    const common = git('merge-base', 'HEAD', base).trim()
    if (common) diffBase = common
  } catch {}
  const changed = new Set()
  try {
    for (const file of git('diff', '--name-only', '--diff-filter=ACMR', '-z', diffBase, '--', 'app/api').split('\0')) {
      if (file) changed.add(file)
    }
  } catch {}
  try {
    for (const file of git('ls-files', '--others', '--exclude-standard', '-z', '--', 'app/api').split('\0')) {
      if (file) changed.add(file)
    }
  } catch {}
  return [...changed]
    .filter(file => /^app\/api\/(?:.+\/)?route\.ts$/.test(file) && existsSync(resolve(root, file)))
    .sort()
}

export function resolveRatchetBase(root = process.cwd(), env = process.env, explicitBase = '') {
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const hasCommit = ref => {
    try {
      git('rev-parse', '--verify', `${ref}^{commit}`)
      return true
    } catch {
      return false
    }
  }
  if (explicitBase) {
    if (!hasCommit(explicitBase)) {
      return { base: '', missingRequiredBase: true, reason: `cannot resolve --base ref "${explicitBase}"` }
    }
    return { base: git('rev-parse', '--verify', `${explicitBase}^{commit}`), missingRequiredBase: false }
  }
  const eventName = env.GITHUB_EVENT_NAME ?? ''
  let eventBase = ''
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
      if (eventName === 'pull_request') eventBase = event.pull_request?.base?.sha ?? ''
      else if (eventName === 'merge_group') eventBase = event.merge_group?.base_sha ?? ''
      else if (eventName === 'push' && event.before && !/^0+$/.test(event.before)) eventBase = event.before
    } catch {}
  }

  const requiresEventBase = eventName === 'pull_request' || eventName === 'merge_group'
  if (eventBase) {
    if (!hasCommit(eventBase)) {
      try {
        execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', eventBase], {
          cwd: root,
          stdio: 'ignore',
        })
      } catch {}
    }
    if (hasCommit(eventBase)) return { base: eventBase, missingRequiredBase: false }
  }

  const fallback = trustedPolicyBase(root)
  if (fallback && hasCommit(fallback)) return { base: fallback, missingRequiredBase: false }
  return {
    base: '',
    missingRequiredBase: requiresEventBase,
    reason: requiresEventBase
      ? `cannot resolve trusted base commit for ${eventName} event; failing closed so the route-guard ratchet cannot be bypassed`
      : '',
  }
}

export function parseBaseArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') return argv[i + 1] ?? ''
    if (argv[i].startsWith('--base=')) return argv[i].slice('--base='.length)
  }
  return ''
}

export function runRouteGuardPolicy(root = process.cwd(), env = process.env, options = {}) {
  const baseline = JSON.parse(readFileSync(resolve(root, BASELINE_PATH), 'utf8'))
  const scan = scanApiRoutes(root)
  const explicitBase = options.baseRef ?? ''
  const { base, missingRequiredBase, reason } = resolveRatchetBase(root, env, explicitBase)
  if (missingRequiredBase) {
    return {
      scan,
      baseline,
      modified: [],
      problems: [`${BASELINE_PATH}: ${reason}`],
    }
  }
  const existsInBase = base
    && execFileSync('git', ['ls-tree', '--name-only', base, '--', BASELINE_PATH], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  const previous = existsInBase
    ? JSON.parse(
        execFileSync('git', ['show', `${base}:${BASELINE_PATH}`], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      )
    : baseline
  const modified = base ? modifiedApiRoutes(root, base) : []
  const problems = auditApiRoutes(scan, baseline, previous, { modifiedRoutes: modified })
  return { scan, baseline, modified, problems }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const baseRef = parseBaseArg(process.argv.slice(2))
  if (process.argv.includes('--json')) {
    const scan = scanApiRoutes()
    const baseline = existsSync(resolve(process.cwd(), BASELINE_PATH))
      ? JSON.parse(readFileSync(resolve(process.cwd(), BASELINE_PATH), 'utf8'))
      : null
    const { base } = resolveRatchetBase(process.cwd(), process.env, baseRef)
    const modified = base ? modifiedApiRoutes(process.cwd(), base) : []
    const problems = baseline ? auditApiRoutes(scan, baseline, baseline, { modifiedRoutes: modified }) : []
    process.stdout.write(
      JSON.stringify(
        {
          total: scan.total,
          guarded: scan.guarded.map(entry => ({ file: entry.file, methods: entry.methods })),
          unguarded: scan.unguarded.map(entry => ({ file: entry.file, methods: entry.unguardedMethods })),
          invalid: scan.invalid.map(entry => ({ file: entry.file, errors: entry.specErrors })),
          modified,
          maxUnguardedRoutes: scan.unguarded.length,
          problems,
        },
        null,
        2,
      ) + '\n',
    )
    process.exit(0)
  }

  const { scan, baseline, modified, problems } = runRouteGuardPolicy(process.cwd(), process.env, { baseRef })
  if (problems.length) {
    process.stderr.write(
      `[route-guard-policy] ${problems.length} problem(s):\n${problems.map(problem => `- ${problem}`).join('\n')}\n`,
    )
    process.exit(1)
  }
  const diffNote = modified.length ? `, ${modified.length} modified route(s) verified guarded` : ''
  process.stdout.write(
    `[route-guard-policy] ok: ${scan.guarded.length} guarded, ${scan.unguarded.length} legacy unguarded (ceiling ${baseline.maxUnguardedRoutes}${diffNote})\n`,
  )
}
