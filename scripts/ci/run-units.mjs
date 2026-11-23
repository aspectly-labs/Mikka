import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import tasks from './tasks.json' with { type: 'json' }

// Older trusted selectors (origin/main before Wave 2 UI pruning) still emit
// these retired public Web UI suites, which now run inside mikka-hosted-ui.
const RETIRED_UI_TASKS = new Map([
  ['ci-core-8', 'core'],
  ['ci-core-49', 'core'],
  ['ci-core-57', 'core'],
  ['ci-core-view-state', 'core'],
])

// Nx defaults FORCE_COLOR to true in children. Keep Actions' non-TTY semantics:
// native-process fixtures and machine-readable CLI output must remain plain.
export const unitEnvironment = env => ({ ...env, FORCE_COLOR: '0', NX_CACHE_PROJECT_GRAPH: 'false', NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false', NX_NO_CLOUD: 'true' })
export function main(kind, env = process.env, run = spawnSync) {
  if (!['core', 'integration'].includes(kind)) throw Error('unitKindRequired')
  const input = JSON.parse(env.CI_UNITS || 'null')
  if (!Array.isArray(input) || !input.length) throw Error('unitSelectionRequired')
  // A PR or main push can still receive the older trusted selector's standalone
  // docs classifier target. Its tests now run inside the mandatory UI policy suite.
  const selected = [...new Set(input.map(key => key === 'ci-core-6' ? 'ci-core-7' : key))]
  if (selected.some(key => key !== '*' && !Object.hasOwn(tasks, key.replace(/^ci-/, '')) && !RETIRED_UI_TASKS.has(key))) {
    throw Error('invalidUnitSelection')
  }
  const all = Object.entries(tasks).filter(([, task]) => task.kind === kind).map(([key]) => `ci-${key}`)
  const names = selected.includes('*') ? all : selected.filter(key => all.includes(key))
  if (!names.length) {
    if (selected.some(key => RETIRED_UI_TASKS.get(key) === kind)) return 0
    throw Error('invalidUnitSelection')
  }
  const result = run('pnpm', ['exec', 'nx', 'run-many', '-t', names.map(n => n.slice(3)).join(','), '--projects', 'ci-tasks', '--parallel=2', '--outputStyle=stream', '--skip-nx-cache'], { stdio: 'inherit', env: unitEnvironment(env) })
  return result.status === 0 && !result.signal && !result.error ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv[2])
