import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
const rootDirectory = fileURLToPath(new URL('../../..', import.meta.url))
const exported = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
const names = node => ts.isIdentifier(node) ? [node.text] : node.elements.flatMap(element => ts.isBindingElement(element) ? names(element.name) : [])
const hash = value => createHash('sha256').update(value).digest('hex')
const unwrapExpression = node => node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) ? unwrapExpression(node.expression) : node

/**
 * The `defineRoute(spec, …)` call that defines a method, through wrappers such
 * as `freshSessionRoute(…)` and the module constants they wrap
 * (`export const POST = freshSessionRoute(POSTBody)`).
 */
function defineRouteCall(node, declarations, seen = new Set()) {
  let found
  const visit = child => {
    if (found) return
    if (ts.isCallExpression(child)) {
      const callee = child.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (name === 'defineRoute') { found = child; return }
    }
    if (ts.isIdentifier(child) && declarations.has(child.text) && !seen.has(child.text)) {
      seen.add(child.text)
      found = defineRouteCall(declarations.get(child.text), declarations, seen)
      return
    }
    if (ts.isArrowFunction(child) || ts.isFunctionExpression(child)) return
    ts.forEachChild(child, visit)
  }
  if (node) visit(node)
  return found
}

/** A route spec's own property, through identifiers and spreads (the last one written wins). */
function specProperty(spec, property, declarations, depth = 0) {
  spec = unwrapExpression(spec)
  if (!spec || depth > 4) return undefined
  if (ts.isIdentifier(spec)) return specProperty(declarations.get(spec.text), property, declarations, depth + 1)
  if (!ts.isObjectLiteralExpression(spec)) return undefined
  let value
  for (const element of spec.properties) {
    if (ts.isSpreadAssignment(element)) {
      const spread = specProperty(element.expression, property, declarations, depth + 1)
      if (spread !== undefined) value = spread
      continue
    }
    const name = element.name && (ts.isIdentifier(element.name) || ts.isStringLiteral(element.name)) ? element.name.text : undefined
    if (name !== property) continue
    if (!ts.isPropertyAssignment(element)) throw new Error('API_ROUTE_SPEC_INVALID')
    value = unwrapExpression(element.initializer)
  }
  return value
}

/**
 * A method's desktop declaration, read from the spec of the `defineRoute` call
 * that defines it: `true`, a list of sub-path templates (catch-all routes), or
 * undefined. Only literals count, so a value the generator cannot read fails the
 * build instead of silently allowing or denying a route. A cron or webhook
 * route is never a desktop route.
 */
function methodDesktop(initializer, declarations) {
  const call = defineRouteCall(unwrapExpression(initializer), declarations)
  if (!call) return undefined
  const value = specProperty(call.arguments[0], 'desktop', declarations)
  if (value === undefined) return undefined
  const auth = specProperty(call.arguments[0], 'auth', declarations)
  if (!auth || !ts.isStringLiteralLike(auth) || ['cron-secret', 'webhook-signature'].includes(auth.text)) throw new Error(`API_ROUTE_DESKTOP_INVALID: ${auth ? auth.getText() : 'no auth'} is not a session route`)
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true
  if (ts.isArrayLiteralExpression(value) && value.elements.length && value.elements.every(element => ts.isStringLiteralLike(element))) return value.elements.map(element => element.text)
  throw new Error('API_ROUTE_DESKTOP_INVALID')
}

export async function inspectRoute(root, file, visiting = new Set()) {
  const absolute = resolve(root, file)
  if (!absolute.startsWith(`${resolve(root)}${sep}`) || visiting.has(absolute)) throw new Error('API_ROUTE_SOURCE_INVALID')
  const source = await readFile(absolute, 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const exports = new Map(), declarations = new Map(), referencedDesktop = new Map()
  const seen = new Set(visiting).add(absolute)
  for (const statement of parsed.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      for (const name of names(declaration.name)) {
        declarations.set(name, declaration.initializer)
        if (exported(statement)) exports.set(name, declaration.initializer)
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && exported(statement)) exports.set(statement.name.text, undefined)
  }
  for (const statement of parsed.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
    const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined
    let referenced
    if (specifier) {
      if (!specifier.startsWith('.') && !specifier.startsWith('@/')) throw new Error('API_ROUTE_REEXPORT_UNRESOLVED')
      const path = specifier.startsWith('@/') ? resolve(root, specifier.slice(2)) : resolve(dirname(absolute), specifier)
      referenced = await inspectRoute(root, `${relative(root, path).replace(/\\/g, '/')}${/\.[cm]?[jt]sx?$/.test(path) ? '' : '.ts'}`, seen)
    }
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue
        const original = element.propertyName?.text ?? element.name.text
        exports.set(element.name.text, referenced ? referenced.values.get(original) : declarations.get(original))
        if (referenced) referencedDesktop.set(element.name.text, referenced.desktop[original])
      }
    } else if (!statement.exportClause && referenced) {
      for (const entry of referenced.values) exports.set(...entry)
      for (const name of referenced.values.keys()) referencedDesktop.set(name, referenced.desktop[name])
    }
  }
  let maxDuration
  if (exports.has('maxDuration')) {
    const value = exports.get('maxDuration')
    const numeric = typeof value === 'number' ? value : value && ts.isNumericLiteral(value) ? Number(value.text) : NaN
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 800) throw new Error('API_ROUTE_DURATION_INVALID')
    maxDuration = numeric
    exports.set('maxDuration', numeric)
  }
  const desktop = {}
  for (const [name, value] of exports) {
    if (!methods.has(name)) continue
    const declared = referencedDesktop.has(name) ? referencedDesktop.get(name) : methodDesktop(value, declarations)
    if (declared !== undefined) desktop[name] = declared
  }
  return { methods: [...exports.keys()].filter(name => methods.has(name)).sort(), maxDuration, sourceHash: hash(source), values: exports, desktop }
}

async function routeFiles(root) {
  const found = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === 'route.ts') found.push(relative(root, path).replace(/\\/g, '/'))
    }
  }
  await visit(join(root, 'app'))
  return found.sort()
}

const CATCH_ALL = /^\[\[?\.\.\.[^\]]+\]\]?$/
const PARAMETER = /^\[[A-Za-z][A-Za-z0-9_]*\]$/
const LITERAL = /^[A-Za-z0-9._~-]+$/

/**
 * Checks a route's desktop declarations against its template: a catch-all
 * route names the exact sub-paths the desktop may reach below its prefix; any
 * other route allows its whole template with `true`.
 */
export function validateDesktop(template, desktop) {
  const parts = template.split('/')
  const catchAll = parts.findIndex(segment => CATCH_ALL.test(segment))
  if (Object.keys(desktop).length && !template.startsWith('/api/')) throw new Error(`API_ROUTE_DESKTOP_INVALID: ${template} is not an API route`)
  for (const [method, value] of Object.entries(desktop)) {
    if (catchAll === -1) {
      if (value !== true) throw new Error(`API_ROUTE_DESKTOP_INVALID: ${method} ${template} takes desktop: true`)
      continue
    }
    if (!Array.isArray(value)) throw new Error(`API_ROUTE_DESKTOP_INVALID: ${method} ${template} is a catch-all; list its desktop sub-paths`)
    const prefix = parts.slice(0, catchAll)
    for (const path of value) {
      const segments = path.split('/')
      const valid = segments.length > prefix.length && prefix.every((segment, index) => segments[index] === segment)
        && segments.slice(prefix.length).every(segment => LITERAL.test(segment) || PARAMETER.test(segment))
      if (!valid) throw new Error(`API_ROUTE_DESKTOP_INVALID: ${method} ${path} is not below ${template}`)
    }
  }
}

const specificity = path => path.split('/').map(segment => segment.startsWith('[[...') ? '3' : segment.startsWith('[...') ? '2' : segment.startsWith('[') ? '1' : `0${segment}`).join('/')
export async function generateRoutes(root = rootDirectory) {
  const inputs = (await routeFiles(root)).map(source => ({ source, template: '/' + source.slice(4, -'/route.ts'.length).split('/').filter(segment => !/^\(.*\)$/.test(segment)).join('/') }))
  inputs.push({ source: 'apps/api/routes/browser-rpc.ts', template: '/api/rpc' }, { source: 'apps/api/routes/oauth-consent.ts', template: '/api/frontend/oauth-consent' })
  const routes = []
  for (const input of inputs) {
    const { methods, maxDuration, sourceHash, desktop } = await inspectRoute(root, input.source)
    if (!methods.length || !/^\/(?:api|v1|\.well-known|w)(?:\/|$)/.test(input.template)) throw new Error('API_ROUTE_DECLARATION_INVALID')
    validateDesktop(input.template, desktop)
    routes.push({ path: `/mikka${input.template}`, template: input.template, source: input.source, methods, ...(maxDuration ? { maxDuration } : {}), sourceHash, desktop })
  }
  routes.sort((left, right) => specificity(left.path).localeCompare(specificity(right.path)))
  if (new Set(routes.map(route => route.path)).size !== routes.length) throw new Error('API_ROUTE_DUPLICATE')
  const directory = join(root, 'apps/api/generated')
  await mkdir(directory, { recursive: true })
  // The desktop main process forwards only the methods a route declares for it
  // (apps/desktop/src/main/bundled-policy.ts). Every /api route is listed, in the
  // server's matching order, so a path resolves to the route that would serve it.
  const desktop = routes.filter(route => route.template.startsWith('/api/')).map(route => ({ template: route.template, ...(Object.keys(route.desktop).length ? { desktop: Object.fromEntries(Object.entries(route.desktop).sort(([left], [right]) => left.localeCompare(right))) } : {}) }))
  for (const route of routes) delete route.desktop
  return { directory, routes, files: [
    ['routes.json', `${JSON.stringify({ version: 1, basePath: '/mikka', routes }, null, 2)}\n`],
    ['desktop-routes.json', `${JSON.stringify({ version: 1, routes: desktop }, null, 2)}\n`],
    ['routes.ts', `// Generated by apps/api/scripts/generate-routes.mjs; declarations only.\nimport type { ApiRoute } from '../src/routes'\nexport const routes: ApiRoute[] = [\n${routes.map(route => `  { ...${JSON.stringify(route)}, load: () => import(${JSON.stringify('../../../' + route.source.replace(/\.ts$/, ''))}) },`).join('\n')}\n]\n`],
  ] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { directory, routes, files } = await generateRoutes()
  const summary = JSON.stringify({ routes: routes.length, methods: routes.reduce((count, route) => count + route.methods.length, 0) })
  // `--check` compares instead of writing. Without this it rewrote the tracked
  // files on every run, so a caller that asserted a clean tree afterwards
  // failed while the route map was silently correct
  // (.github/workflows/workspace-governance-acceptance.yml).
  if (process.argv.includes('--check')) {
    const stale = []
    for (const [name, expected] of files) {
      const actual = await readFile(join(directory, name), 'utf8').catch(() => null)
      if (actual !== expected) stale.push(`apps/api/generated/${name}`)
    }
    if (stale.length) {
      console.error(`generate-routes: stale (${summary}): ${stale.join(', ')}. Run \`node apps/api/scripts/generate-routes.mjs\` and commit.`)
      process.exit(1)
    }
    console.log(`generate-routes: up to date (${summary})`)
  } else {
    for (const [name, contents] of files) await writeFile(join(directory, name), contents)
    console.log(summary)
  }
}
