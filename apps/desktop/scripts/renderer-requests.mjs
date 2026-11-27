// The API routes the desktop renderer requests, read from its source without
// running it. bundled-routes.test.ts checks every one against the main process's
// allowlist (src/main/bundled-policy.ts), and the official UI's CI runs the same
// check against its own commit.
//
// The scan walks the renderer's module graph the way the desktop build resolves
// it (apps/frontend/scripts/application-plugin.mjs): from the frontend entry,
// through `mikka:*`, `@/`, `@hosted/` and relative imports, with the desktop
// aliases applied. In each module it records:
//
// - a request whose URL is written at the call: `fetch('/api/x')`,
//   `fetch(withBasePath(\`/api/x/${id}\`))`, or a request helper called with the
//   URL, wherever that helper is defined (`readJson(url)`, an imported
//   `fetchSettingsData(url)`, `send(url, 'PATCH', body)`);
// - a call to a helper that builds the URL itself from its parameters
//   (`settingsRead('issue-states')` becomes `/api/settings/issue-states`);
// - every other `/api/…` literal in the module (a SWR key, a path returned by a
//   `…Path()` function), as a GET unless its call says otherwise. Links and
//   browser hand-offs are left out: they never reach the main process.
//
// It is still a lower bound: a URL assembled at run time from values the source
// does not name cannot be read. The fixture end-to-end capture covers those.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const SERVER_FILE = /^(?:app\/api\/|app\/actions\/|lib\/server-runtime\/|lib\/intl\/i18n-server(?:\.ts|$)|lib\/server-only\.ts$|lib\/(?:auth|db|session)\.ts$|lib\/db\/|lib\/desktop-rpc\/(?:registry|schemas|handler|bootstrap|authentication|session(?:-cache(?:-context)?)?)\.ts$)/
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js']
const METHODS = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD)$/
/** Calls that leave the renderer instead of requesting: links and external browser hand-offs. */
const NAVIGATIONS = new Set(['assign', 'replace', 'open', 'openExternal', 'navigate', 'push', 'pushState', 'replaceState'])
/** Literal holes are written as this character; `*` in the report. */
export const HOLE = '\u0000'

const slash = value => value.split(sep).join('/')

/**
 * Where the desktop build takes each module from. `overlay` is the official UI
 * checkout (`.hosted-ui`), `aliases` the desktop replacements from
 * application-plugin.mjs (specifier → file under apps/desktop/src/renderer), and
 * `overlayAliases` its replacements inside the checkout.
 */
function resolver(repository, overlay, aliases, overlayAliases) {
  const renderer = join(repository, 'apps/desktop/src/renderer')
  const file = candidate => {
    for (const extension of EXTENSIONS) {
      const path = `${candidate}${extension}`
      if (existsSync(path) && statSync(path).isFile()) return path
    }
    return null
  }
  return (specifier, importer) => {
    if (specifier === 'mikka:application') return join(overlay, 'core/renderer/index.tsx')
    if (specifier === 'mikka:platform') return join(overlay, 'core/renderer/platform.tsx')
    if (specifier === 'mikka:frontend-runtime') return join(overlay, 'core/renderer/installed-startup.ts')
    if (specifier.startsWith('mikka:')) return null
    const alias = aliases.get(specifier)
    if (alias && importer !== join(renderer, alias)) return join(renderer, alias)
    const overlayAlias = overlayAliases.get(specifier)
    if (overlayAlias && importer !== join(overlay, overlayAlias)) return join(overlay, overlayAlias)
    let candidate
    if (specifier.startsWith('@hosted/')) candidate = join(overlay, specifier.slice('@hosted/'.length))
    else if (specifier.startsWith('@/')) candidate = join(repository, specifier.slice(2))
    else if (specifier.startsWith('.')) candidate = resolve(dirname(importer), specifier)
    else return null
    const found = file(candidate)
    if (!found) return null
    // The build swaps the official UI's feature hook for the desktop's own.
    if (found === join(overlay, 'web/hooks/use-feature-availability.ts') && importer !== join(renderer, 'feature-availability.ts')) return join(renderer, 'feature-availability.ts')
    return found
  }
}

function moduleSpecifiers(ast) {
  const found = []
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) && !(ts.isExportDeclaration(node) && node.isTypeOnly)) found.push(node.moduleSpecifier.text)
    }
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) found.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}

const parse = (path, source) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

/**
 * Every module the desktop renderer bundles, as repository-relative paths,
 * parsed once. Server modules are left out: the build refuses them.
 */
export function rendererModules(repository, { overlay = join(repository, '.hosted-ui'), aliases, overlayAliases }) {
  const resolveModule = resolver(repository, overlay, aliases, overlayAliases)
  const entries = [join(repository, 'apps/frontend/src/index.ts'), ...[...aliases.values()].map(name => join(repository, 'apps/desktop/src/renderer', name))]
  const modules = new Map()
  const pending = [...new Set(entries)]
  while (pending.length) {
    const path = pending.pop()
    const name = slash(relative(repository, path))
    if (modules.has(name) || SERVER_FILE.test(name) || !/\.[cm]?[jt]sx?$/.test(path) || path.includes(`${sep}node_modules${sep}`)) continue
    const source = readFileSync(path, 'utf8')
    const ast = parse(path, source)
    const imports = new Map()
    modules.set(name, { name, path, source, ast, imports })
    for (const specifier of moduleSpecifiers(ast)) {
      const target = resolveModule(specifier, path)
      if (!target) continue
      imports.set(specifier, slash(relative(repository, target)))
      pending.push(target)
    }
  }
  return modules
}

/** `withBasePath`, assertions and parentheses unwrapped down to the URL expression. */
function unwrap(node) {
  if (!node) return null
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return unwrap(node.expression)
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withBasePath') return unwrap(node.arguments[0])
  return node
}

/** The module's top-level and block-level `const x = …` initializers, by name (first one wins). */
function constants(ast) {
  const values = new Map()
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const && !values.has(node.name.text)) values.set(node.name.text, node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return values
}

/** A query-string suffix such as `params.size ? \`?${params}\` : ''`: never part of the route. */
function queryOnly(node, values, depth = 0) {
  node = unwrap(node)
  if (!node || depth > 4) return false
  if (ts.isIdentifier(node)) return values.has(node.text) && queryOnly(values.get(node.text), values, depth + 1)
  if (ts.isStringLiteralLike(node)) return node.text === '' || node.text.startsWith('?')
  if (ts.isTemplateExpression(node)) return node.head.text.startsWith('?')
  if (ts.isConditionalExpression(node)) return queryOnly(node.whenTrue, values, depth + 1) && queryOnly(node.whenFalse, values, depth + 1)
  return false
}

/**
 * The paths a URL expression names, with `${…}` holes written as HOLE: both
 * branches of a conditional, a constant's value. `bind` substitutes a helper's
 * literal arguments for its parameters; a hole that only adds a query string is
 * dropped.
 */
function pathsOf(node, values, bind = new Map(), depth = 0) {
  node = unwrap(node)
  if (!node || depth > 4) return []
  if (ts.isIdentifier(node)) {
    if (bind.has(node.text)) return [bind.get(node.text)]
    return values.has(node.text) ? pathsOf(values.get(node.text), values, bind, depth + 1) : []
  }
  if (ts.isConditionalExpression(node)) return [...pathsOf(node.whenTrue, values, bind, depth + 1), ...pathsOf(node.whenFalse, values, bind, depth + 1)]
  if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return [...pathsOf(node.left, values, bind, depth + 1), ...pathsOf(node.right, values, bind, depth + 1)]
  if (ts.isStringLiteralLike(node)) return [node.text]
  // `'/api/workspaces/' + encodeURIComponent(id) + '/x'`: a piece that is not a literal is a hole.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const piece = operand => {
      const found = pathsOf(operand, values, bind, depth + 1)
      return found.length ? found : [queryOnly(operand, values) ? '' : HOLE]
    }
    return piece(node.left).flatMap(left => piece(node.right).map(right => left + right))
  }
  if (!ts.isTemplateExpression(node)) return []
  let text = node.head.text
  for (const span of node.templateSpans) {
    const expression = unwrap(span.expression)
    if (expression && ts.isIdentifier(expression) && bind.has(expression.text)) text += bind.get(expression.text)
    else if (!queryOnly(span.expression, values)) text += HOLE
    text += span.literal.text
  }
  return [text]
}

/** The HTTP method a request declares — `fetch(url, { method })` or `send(url, 'POST', body)` — defaulting to GET. */
function methodOf(call, bind = new Map()) {
  for (const init of call.arguments.slice(1)) {
    if (ts.isStringLiteralLike(init) && METHODS.test(init.text)) return init.text
    if (ts.isIdentifier(init) && bind.has(init.text) && METHODS.test(bind.get(init.text))) return bind.get(init.text)
    if (!ts.isObjectLiteralExpression(init)) continue
    for (const property of init.properties) {
      const named = (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ts.isIdentifier(property.name) && property.name.text === 'method'
      if (!named) continue
      const value = ts.isPropertyAssignment(property) ? property.initializer : property.name
      if (ts.isStringLiteralLike(value)) return value.text.toUpperCase()
      if (ts.isIdentifier(value) && bind.has(value.text)) return bind.get(value.text).toUpperCase()
    }
  }
  return null
}

/** Links, `location` writes and external-browser hand-offs leave the renderer: the main process never sees them. */
function navigates(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isJsxAttribute(at) || ts.isJsxOpeningElement(at) || ts.isJsxSelfClosingElement(at)) return true
    if (ts.isPropertyAccessExpression(at) && at.name.text === 'href') return true
    if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(at.left) && ['href', 'location', 'src', 'action'].includes(at.left.name.text)) return true
    if (ts.isPropertyAssignment(at) && ts.isIdentifier(at.name) && ['href', 'src', 'action'].includes(at.name.text)) return true
    if (ts.isCallExpression(at)) {
      const callee = at.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (NAVIGATIONS.has(name)) return true
    }
    if (ts.isStatement(at) || ts.isFunctionLike(at)) return false
  }
  return false
}

const calleeName = call => ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ''

/** Function-like declarations of a module, by local name. */
function functions(ast) {
  const found = new Map()
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name) found.set(node.name.text, node)
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) found.set(node.name.text, node.initializer)
    else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && !found.has(node.name.text)) found.set(node.name.text, node)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}

const parameterNames = fn => fn.parameters.map(parameter => (ts.isIdentifier(parameter.name) ? parameter.name.text : null))

/** Local import bindings: local name → [resolved module, exported name]. */
function importBindings(module) {
  const bindings = new Map()
  for (const statement of module.ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const target = module.imports.get(statement.moduleSpecifier.text)
    const named = statement.importClause?.namedBindings
    if (!target || !named || !ts.isNamedImports(named)) continue
    for (const element of named.elements) bindings.set(element.name.text, [target, (element.propertyName ?? element.name).text])
  }
  return bindings
}

/** Names a module re-exports from another: exported name → [module, name there]. */
function reexports(module) {
  const found = new Map()
  for (const statement of module.ast.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const target = module.imports.get(statement.moduleSpecifier.text)
    if (!target || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue
    for (const element of statement.exportClause.elements) found.set(element.name.text, [target, (element.propertyName ?? element.name).text])
  }
  return found
}

/**
 * The API requests a renderer makes: path (holes as HOLE, no query string) →
 * { methods, files }. A path seen only as a bare literal carries GET.
 */
export function rendererRequests(modules) {
  const info = new Map()
  for (const module of modules.values()) {
    info.set(module.name, { module, values: constants(module.ast), functions: functions(module.ast), bindings: importBindings(module), reexports: reexports(module) })
  }
  /** A function's declaration, following imports and re-exports. */
  const lookup = (moduleName, name, depth = 0) => {
    const entry = info.get(moduleName)
    if (!entry || depth > 8) return null
    if (entry.functions.has(name)) return { entry, fn: entry.functions.get(name) }
    const next = entry.bindings.get(name) ?? entry.reexports.get(name)
    return next ? lookup(next[0], next[1], depth + 1) : null
  }
  // A request helper reaches `fetch` itself or through another helper; found to a fixed point.
  const helpers = new Map()
  const key = (entry, fn) => `${entry.module.name}:${fn.pos}`
  const isRequest = (entry, call) => {
    const name = calleeName(call)
    if (name === 'fetch' && (ts.isIdentifier(call.expression) || (ts.isPropertyAccessExpression(call.expression) && ['window', 'globalThis', 'self'].includes(call.expression.expression.getText())))) return true
    if (!ts.isIdentifier(call.expression)) return false
    const found = lookup(entry.module.name, name)
    return Boolean(found && helpers.has(key(found.entry, found.fn)))
  }
  for (let changed = true, pass = 0; changed && pass < 8; pass++) {
    changed = false
    for (const entry of info.values()) {
      for (const fn of entry.functions.values()) {
        const id = key(entry, fn)
        if (helpers.has(id) || !fn.body) continue
        let calls = null
        const visit = node => {
          if (calls) return
          if (ts.isCallExpression(node) && isRequest(entry, node)) calls = node
          else ts.forEachChild(node, visit)
        }
        visit(fn.body)
        if (calls) { helpers.set(id, { entry, fn, call: calls }); changed = true }
      }
    }
  }

  const sites = new Map()
  const record = (path, method, file) => {
    if (!path?.startsWith('/api/') && !path?.startsWith('/mikka/api/')) return
    const route = path.replace(/^\/mikka/, '').split(/[?#]/, 1)[0]
    const site = sites.get(route) ?? { path: route, methods: new Set(), files: new Set(), bare: true }
    if (method) { site.methods.add(method); site.bare = false }
    site.files.add(file)
    sites.set(route, site)
  }
  const consumed = new Set()
  /** The literal a request names, through the constants it is read from, is that request's, not a bare GET. */
  const consume = (node, values, depth = 0) => {
    node = unwrap(node)
    if (!node || depth > 4) return
    if (ts.isIdentifier(node)) { if (values.has(node.text)) consume(values.get(node.text), values, depth + 1) }
    else if (ts.isConditionalExpression(node)) { consume(node.whenTrue, values, depth + 1); consume(node.whenFalse, values, depth + 1) }
    else consumed.add(node)
  }
  for (const entry of info.values()) {
    const file = entry.module.name
    const visit = node => {
      if (ts.isCallExpression(node) && !navigates(node)) {
        const url = node.arguments[0]
        if (url && isRequest(entry, node)) {
          const paths = pathsOf(url, entry.values).filter(path => path.includes('/api/'))
          for (const path of paths) record(path, methodOf(node) ?? 'GET', file)
          if (paths.length) consume(url, entry.values)
        }
        // A helper that builds its URL from its parameters, called with literals.
        const found = ts.isIdentifier(node.expression) ? lookup(file, node.expression.text) : null
        const helper = found && helpers.get(key(found.entry, found.fn))
        if (helper) {
          const names = parameterNames(helper.fn)
          const bind = new Map()
          names.forEach((name, index) => {
            const argument = unwrap(node.arguments[index])
            if (name && argument && ts.isStringLiteralLike(argument)) bind.set(name, argument.text)
          })
          const marked = new Map([...bind.keys()].map(name => [name, '\u0001']))
          const usesParameter = bind.size > 0 && pathsOf(helper.call.arguments[0], helper.entry.values, marked).some(path => path.includes('\u0001'))
          if (usesParameter) {
            for (const path of pathsOf(helper.call.arguments[0], helper.entry.values, bind)) {
              if (path.includes('/api/')) record(path, methodOf(helper.call, bind) ?? methodOf(node) ?? 'GET', file)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(entry.module.ast)
  }
  // Every other `/api/…` literal: a SWR key, a path a `…Path()` helper returns.
  for (const entry of info.values()) {
    const file = entry.module.name
    const visit = node => {
      if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && !consumed.has(node)) {
        const text = ts.isTemplateExpression(node) ? pathsOf(node, entry.values)[0] : node.text
        if ((text?.startsWith('/api/') || text?.startsWith('/mikka/api/')) && !navigates(node) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent) && !(ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword)) {
          record(text, null, file)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(entry.module.ast)
  }
  for (const site of sites.values()) if (!site.methods.size) site.methods.add('GET')
  return sites
}
