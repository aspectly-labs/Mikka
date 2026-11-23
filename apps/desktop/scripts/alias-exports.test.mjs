import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { desktopAliases } from '../../frontend/scripts/application-plugin.mjs'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
const renderer = join(repository, 'apps/desktop/src/renderer')

/** The value names a module exports (types are erased, so a missing one breaks nothing at build time). */
function valueExports(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const names = new Set()
  const exported = node => ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export
  for (const node of source.statements) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && exported(node)) names.add(node.name.text)
    else if (ts.isVariableStatement(node) && exported(node)) for (const item of node.declarationList.declarations) { if (ts.isIdentifier(item.name)) names.add(item.name.text) }
    else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause))
      for (const item of node.exportClause.elements) if (!item.isTypeOnly) names.add(item.name.text)
    else if (ts.isExportAssignment(node)) names.add('default')
  }
  return names
}

/** Names only web code imports, which the desktop renderer never bundles. Each needs its reason. */
const WEB_ONLY = new Map([
  // The cloud sign-in client: imported by apps/frontend/src/web/platform.tsx and lib/web-connection/browser.ts only.
  ['@/lib/auth-client', ['cloudAuthClient']],
])

const webFile = specifier => ['.ts', '.tsx', '/index.ts', '/index.tsx'].map(ext => join(repository, specifier.slice(2) + ext)).find(existsSync)

test('each desktop alias exports every value name of the web module it replaces', () => {
  const pairs = [...desktopAliases].filter(([specifier]) => specifier.startsWith('@/'))
  assert.ok(pairs.some(([specifier]) => specifier === '@/lib/platform/client-config'), 'the client config alias is covered')
  for (const [specifier, target] of pairs) {
    const web = webFile(specifier)
    assert.ok(web, `${specifier} resolves to a web module`)
    const desktop = valueExports(join(renderer, target))
    const webOnly = new Set(WEB_ONLY.get(specifier) ?? [])
    const missing = [...valueExports(web)].filter(name => !desktop.has(name) && !webOnly.has(name))
    assert.deepEqual(missing, [], `apps/desktop/src/renderer/${target} lacks what ${specifier} exports; shared components importing it break the desktop build`)
  }
})
