// Whether a root manifest or lockfile change can reach the Desktop suite (.github/workflows/desktop.yml), so a pull
// request runs Desktop only when it can affect it (scripts/ci/select.mjs). Desktop installs from the root and builds
// the root application for its smoke, so its dependency closure is the root importer, apps/desktop and every
// workspace package either links, with everything those resolve to. A lockfile change outside that closure (for
// example a dependency only the mobile app uses) cannot change what Desktop installs.
import yaml from 'js-yaml'
import { posix } from 'node:path'

const importerFields = ['dependencies', 'devDependencies', 'optionalDependencies']
// Lockfile sections that change how every package installs.
const globalSections = ['lockfileVersion', 'settings', 'overrides', 'packageExtensionsChecksum', 'patchedDependencies', 'pnpmfileChecksum', 'catalogs']
/** Root scripts desktop.yml runs, and the manifest fields that change how anything installs or runs. */
export const DESKTOP_ROOT_SCRIPTS = ['test:platform', 'lint:ui', 'migrate', 'test:e2e:setup', 'build:app', 'test:desktop-auth']
const manifestFields = ['packageManager', 'engines', 'pnpm', 'type', 'workspaces', 'resolutions', 'overrides']

/** Every lockfile entry Desktop's install depends on, as sorted strings. */
export function desktopLockClosure(text) {
  const lock = yaml.load(text) ?? {}
  const importers = lock.importers ?? {}
  const snapshots = lock.snapshots ?? {}
  const packages = lock.packages ?? {}
  const entries = new Set(globalSections.map(name => `global:${name}=${JSON.stringify(lock[name] ?? null)}`))
  const pendingImporters = ['.', 'apps/desktop']
  const seenImporters = new Set()
  const pendingSnapshots = []
  const resolve = (from, name, version) => {
    const value = String(version)
    if (value.startsWith('link:')) pendingImporters.push(posix.normalize(posix.join(from, value.slice(5))) || '.')
    else pendingSnapshots.push(`${name}@${value}`)
  }
  while (pendingImporters.length) {
    const key = pendingImporters.pop()
    if (seenImporters.has(key)) continue
    seenImporters.add(key)
    const importer = importers[key]
    entries.add(`importer:${key}=${importer ? 'present' : 'missing'}`)
    for (const field of importerFields) for (const [name, { specifier, version } = {}] of Object.entries(importer?.[field] ?? {})) {
      entries.add(`importer:${key}:${field}:${name}=${specifier}>${version}`)
      resolve(key, name, version)
    }
  }
  const seenSnapshots = new Set()
  while (pendingSnapshots.length) {
    const key = pendingSnapshots.pop()
    if (seenSnapshots.has(key)) continue
    seenSnapshots.add(key)
    const snapshot = snapshots[key]
    const base = key.includes('(') ? key.slice(0, key.indexOf('(')) : key
    entries.add(`snapshot:${key}=${JSON.stringify(snapshot ?? null)}`)
    entries.add(`package:${base}=${JSON.stringify(packages[base] ?? null)}`)
    for (const field of ['dependencies', 'optionalDependencies']) for (const [name, version] of Object.entries(snapshot?.[field] ?? {})) {
      if (!String(version).startsWith('link:')) pendingSnapshots.push(`${name}@${version}`)
    }
  }
  return [...entries].sort()
}

/** Whether the lockfile change alters Desktop's closure. Unreadable input counts as a change. */
export function lockfileTouchesDesktop(before, after) {
  try {
    return JSON.stringify(desktopLockClosure(before)) !== JSON.stringify(desktopLockClosure(after))
  } catch { return true }
}

/** Whether a root package.json change alters a script desktop.yml runs, a dependency or an install setting. */
export function manifestTouchesDesktop(before, after) {
  try {
    const view = text => {
      const manifest = JSON.parse(text)
      return JSON.stringify([
        DESKTOP_ROOT_SCRIPTS.map(name => manifest.scripts?.[name] ?? null),
        importerFields.map(field => manifest[field] ?? null),
        manifestFields.map(field => manifest[field] ?? null),
      ])
    }
    return view(before) !== view(after)
  } catch { return true }
}
