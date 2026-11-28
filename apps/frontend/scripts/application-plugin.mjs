import { frontendRuntimeSource } from './frontend-runtime.mjs'
import { builtinModules } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { uiOverlay, resolveOverlaySpecifier } from '../../../lib/ui-overlay.mjs'
import { actionReferences, actionSignatures, nativeOfflineView, bundledIconCatalogue, bundledSyntaxCatalogue } from '../../desktop/scripts/renderer-transforms.mjs'

export const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const repository = resolve(frontend, '../..')
const renderer = resolve(repository, 'apps/desktop/src/renderer')
const actionDirectory = resolve(repository, 'app/actions')
const slash = value => value.split(sep).join('/')
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
// A build without the official UI checkout compiles this page alone (lib/ui-overlay.mjs).
const headlessEntry = resolve(frontend, 'src/headless.ts')
const virtualAction = '\0mikka:action:'
export const desktopAliases = new Map([
  ['@/lib/auth-client', 'auth-client.ts'],
  ['@/lib/platform/open-settings', 'open-settings.ts'], ['@/lib/platform/client-config', 'client-config.ts'],
  ['@/hooks/use-feature-availability', 'feature-availability.ts'], ['@hosted/web/hooks/use-feature-availability', 'feature-availability.ts'],
  ['@/lib/live/browser-runtime', 'live-runtime.ts'], ['@/lib/computer/request', 'computer-request.ts'], ['@novnc/novnc/lib/rfb.js', 'novnc.ts'],
])

export function serverSpecifier(source) {
  // The framework specifiers are gone from the source, but a browser bundle
  // that reaches for one must fail loudly rather than pull in a real package.
  return source === 'server-only' || source.startsWith('@/lib/intl/i18n-server') || source.startsWith('node:') || builtins.has(source)
    || /^next(?:\/|$)/.test(source) || source.startsWith('next-intl')
    || source === 'better-auth' || source === 'pg' || source === 'postgres'
}

function serverFile(filename) {
  const path = slash(relative(repository, filename.split('?')[0]))
  // Match the resolved path as well as the specifier: a relative or absolute
  // import of a server module must fail even when the module's own imports
  // happen to stay browser-safe.
  return path.startsWith('app/api/') || path.startsWith('lib/server-runtime/')
    || /^lib\/intl\/i18n-server(?:\.ts|$)/.test(path)
    || path === 'lib/server-only.ts'
    || /^lib\/(?:auth|db|session)\.ts$/.test(path) || path.startsWith('lib/db/')
    || /^lib\/desktop-rpc\/(?:registry|schemas|handler|bootstrap|authentication|session(?:-cache(?:-context)?)?)\.ts$/.test(path)
    || /\/next\/dist\/(?:server|compiled\/webpack)/.test(slash(filename))
}

/** Read the literal registry without evaluating any server action or module. */
export function registryActionNames(source) {
  const file = ts.createSourceFile('registry.ts', source, ts.ScriptTarget.Latest, true)
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'functions') continue
      const value = ts.isSatisfiesExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer
      if (!value || !ts.isObjectLiteralExpression(value)) throw new Error('FRONTEND_RPC_REGISTRY_LITERAL_REQUIRED')
      return new Set(value.properties.map(property => {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) throw new Error('FRONTEND_RPC_REGISTRY_LITERAL_REQUIRED')
        return property.name.text
      }))
    }
  }
  throw new Error('FRONTEND_RPC_REGISTRY_LITERAL_REQUIRED')
}

// Reuse the already tested source transformations; this small adapter captures
// their pure file loaders, without running an esbuild application compilation.
function fileLoader(plugin) {
  let loader
  plugin.setup({ onResolve() {}, onLoad(options, load) { loader = { filter: options.filter, load } } })
  if (!loader) throw new Error('FRONTEND_SOURCE_LOADER_MISSING')
  return loader
}

// Desktop replaces these official UI modules with its own, from the checkout (lib/ui-overlay.mjs OVERLAY_APPLICATION).
export const desktopOverlayAliases = new Map([
  ['@hosted/core/components/auth-form', 'desktopAuthForm'],
])

export async function applicationPlugin(target, { deploymentId = '', overlay = uiOverlay(repository) } = {}) {
  if (!['web', 'desktop'].includes(target)) throw new Error('FRONTEND_TARGET_INVALID')
  const allowed = registryActionNames(await readFile(resolve(repository, 'lib/desktop-rpc/registry.ts'), 'utf8'))
  const actions = new Map()
  const inputs = new Set()
  const offline = fileLoader(nativeOfflineView())
  const catalogues = [fileLoader(bundledIconCatalogue()), fileLoader(bundledSyntaxCatalogue())]
  const webRpc = resolve(frontend, 'src/web/rpc.ts')
  // The official UI checkout and its `@hosted/` imports (docs/ui-overlay.md).
  const headless = !overlay.dir
  let development = false
  let inventory
  return {
    name: 'mikka-shared-application', enforce: 'pre',
    api: { inventory: () => inventory },
    configResolved(config) { development = config.command === 'serve' },
    async resolveId(source, importer, options) {
      if (source.startsWith('\0mikka:')) return source
      if (source === 'mikka:application') return headless ? headlessEntry : overlay.application.entry
      if (source === 'mikka:platform') {
        if (headless) throw new Error('FRONTEND_PLATFORM_WITHOUT_UI')
        return target === 'desktop' ? overlay.application.desktopPlatform : overlay.application.webPlatform
      }
      if (source === 'mikka:frontend-runtime' || source === 'mikka:native-offline' || source === 'mikka:native-offline.css') return `\0${source}`
      if (source === 'mikka:renderer-build') {
        if (development) return '\0mikka:renderer-build'
        return { id: `/mikka/renderer-build.js${deploymentId ? `?dpl=${encodeURIComponent(deploymentId)}` : ''}`, external: true }
      }
      if (serverSpecifier(source)) throw new Error(`FRONTEND_SERVER_IMPORT: ${source}`)
      const action = /^@\/app\/actions\/([\w-]+)$/.exec(source)
      if (action) return `${virtualAction}${action[1]}`
      // An alias target goes through the bundler's own resolver, so the file's package format (`"type": "module"`)
      // is read the same way every time. A bare path returned from here left that to whichever importer reached the
      // module first, and the CommonJS interop for React (`__toESM(…, 1)`) then differed between two builds of one
      // tree, changing chunk hashes and the renderer identity (apps/frontend/scripts/build.test.mjs).
      const bundlerResolved = path => this.resolve(path, importer, { ...options, skipSelf: true })
      const desktopAlias = target === 'desktop' ? desktopAliases.get(source) : undefined
      if (desktopAlias && importer?.split('?')[0] !== resolve(renderer, desktopAlias)) return bundlerResolved(resolve(renderer, desktopAlias))
      const desktopOverlayAlias = target === 'desktop' && !headless ? overlay.application[desktopOverlayAliases.get(source)] : undefined
      if (desktopOverlayAlias && importer?.split('?')[0] !== desktopOverlayAlias) return bundlerResolved(desktopOverlayAlias)
      // The official UI's one-load script loader (core/lib/client-runtime/script.tsx) is web-only.
      if (source === '@hosted/core/lib/client-runtime/script' && target === 'desktop') throw new Error('FRONTEND_DESKTOP_REMOTE_SCRIPT_FORBIDDEN')
      if (source.startsWith('@ui-slot/')) throw new Error(`UI_SLOT_RETIRED: ${source}`)
      const candidate = resolveOverlaySpecifier(source, overlay) ?? (source.startsWith('@/') ? resolve(repository, source.slice(2)) : source)
      // Keep require-call/import semantics when resolving conditional package
      // exports; a CommonJS helper must not become an ESM namespace object.
      const resolved = await this.resolve(candidate, importer, { ...options, skipSelf: true })
      if (!resolved) return null
      const id = resolved.id.split('?')[0]
      if (target === 'desktop' && !headless && id === resolve(overlay.dir, 'web/hooks/use-feature-availability.ts')
          && importer?.split('?')[0] !== resolve(renderer, 'feature-availability.ts')) {
        return bundlerResolved(resolve(renderer, 'feature-availability.ts'))
      }
      if (serverFile(id)) throw new Error(`FRONTEND_SERVER_MODULE: ${slash(relative(repository, id))}`)
      if (target === 'web' && id === resolve(renderer, 'rpc.ts') && importer?.split('?')[0] !== webRpc) return webRpc
      if (isAbsolute(id) && dirname(id) === actionDirectory && id.endsWith('.ts')) return `${virtualAction}${id.slice(actionDirectory.length + 1, -3)}`
      return resolved
    },
    async load(id) {
      if (id === '\0mikka:frontend-runtime') return headless ? '' : frontendRuntimeSource(target, { development, frontend, overlay: overlay.dir })
      if (id === '\0mikka:renderer-build') return 'export const rendererBuild = "development";'
      if (id === '\0mikka:native-offline' || id === '\0mikka:native-offline.css') return (await offline.load({ path: id.slice(1) })).contents
      if (!id.startsWith(virtualAction)) return null
      const name = id.slice(virtualAction.length)
      const signatures = actionSignatures(await readFile(resolve(actionDirectory, `${name}.ts`), 'utf8'), name)
      actions.set(name, signatures.map(value => value.name))
      const rpc = target === 'desktop' ? resolve(renderer, 'rpc.ts') : webRpc
      return `import { callAction } from ${JSON.stringify(rpc)};\n${signatures.map(({ name: action, arity, rest }) => `export const ${action} = (...args) => callAction(${JSON.stringify(`${name}.${action}`)}, ${rest ? 'args' : arity ? `args.slice(0, ${arity})` : '[]'});`).join('\n')}\n`
    },
    async transform(code, id) {
      const filename = id.split('?')[0]
      if (serverFile(filename) || /^\s*['"]use server['"]\s*;?/.test(code)) throw new Error('FRONTEND_SERVER_MODULE')
      if (isAbsolute(filename) && !filename.includes('node_modules') && /\.[cm]?[jt]sx?$/.test(filename)) inputs.add(filename)
      for (const catalogue of catalogues) if (catalogue.filter.test(filename)) return { code: (await catalogue.load({ path: filename })).contents, map: null }
      return null
    },
    async generateBundle() {
      const used = new Set()
      for (const path of inputs) for (const name of actionReferences(await readFile(path, 'utf8'), path)) used.add(name)
      const missing = [...used].filter(name => !allowed.has(name)).sort()
      if (missing.length) throw new Error(`FRONTEND_ACTION_NOT_ALLOWED: ${missing.join(', ')}`)
      const modules = Object.fromEntries([...actions].sort(([a], [b]) => a.localeCompare(b)))
      inventory = {
        version: 1, target, modules, exports: Object.values(modules).reduce((sum, names) => sum + names.length, 0),
        ...(headless && { headless: true }),
        usedActions: [...used].sort(), sourceActions: (await readdir(actionDirectory)).filter(name => name.endsWith('.ts')).length,
        inputs: [...inputs].map(path => slash(relative(repository, path))).sort(), serverModules: [],
      }
    },
  }
}
