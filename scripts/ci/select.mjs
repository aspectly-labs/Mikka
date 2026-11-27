import { execFileSync } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { filterAffected } from 'nx/src/project-graph/affected/affected-project-graph.js'
import yaml from 'js-yaml'
import { buildGraph, dbId, taskId } from './graph.mjs'
import { isDocsOnly } from '../ci-docs-only.mjs'
import { frozenUnitInventory } from './frozen-inventory.mjs'
import { lockfileTouchesDesktop, manifestTouchesDesktop } from './desktop-inputs.mjs'

export const GLOBAL = /^(?:\.github\/(?!workflows\/README\.md$)|scripts\/|tests\/(?:helpers|support)\/|patches\/|packages\/(?:config|protocol|subscription-worker)\/|services\/|cloudflare\/|(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|nx\.json|[^/]*config[^/]*|[^/]*lock[^/]*|Dockerfile|docker-compose[^/]*|\.dockerignore|\.npmrc)$|lib\/(?:db(?:\/|\.)|auth|api-auth|fresh-session|credentials\/|secrets\/|permissions|.*authorization|.*tenant|.*scope))/
// Keep the expression readable without a trailing whitespace token.
// On a pull request Desktop runs only for a change that can reach it, as Orca routes its e2e: the Desktop app, the
// workspace packages it links (desktopWorkspaceRoots), the Desktop workflow, the registry settings its install reads,
// and whatever the Nx graph says @mikka/desktop imports. GLOBAL does not select it.
export const DESKTOP_PATH = /^(?:apps\/desktop\/|\.github\/workflows\/desktop\.yml$|\.npmrc$)/
// What the Desktop renderer build reads without an import the Nx graph can see: the application plugin's virtual
// modules (apps/frontend/scripts/application-plugin.mjs: `mikka:application` is headless.ts without the official UI,
// each `@/app/actions/<name>` is generated from that file, the RPC registry is read as text) and Vite's own inputs.
// Selected on pull requests and merge groups alike.
export const DESKTOP_VIRTUAL_INPUT = /^(?:apps\/frontend\/(?:src\/headless\.ts|index\.html|vite\.config\.mjs)|app\/actions\/[\w-]+\.ts|lib\/desktop-rpc\/registry\.ts)$/
// Root files Nx treats as touching every project; Desktop reads their content instead (desktop-inputs.mjs).
const ROOT_INPUTS = { 'pnpm-lock.yaml': 'lockfile', 'package.json': 'manifest' }
const IMPLICIT_ALL = new Set(['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', 'nx.json'])
const globalPath = file => !isDocsOnly([file]) && (GLOBAL.test(file) || /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/.test(file))
export function area(file, plan) {
  if (file.startsWith('apps/desktop/')) return 'desktop'
  if (file.startsWith('packages/daemon/')) return 'daemon'
  if (file.startsWith('packages/subscription-worker/')) return 'e2b/runtime'
  if (file.startsWith('packages/')) return 'protocol/shared'
  if (/^(?:components|hooks|i18n|messages|public|apps\/frontend)\/|^app\/(?:fonts|globals)/.test(file)) return 'frontend/web'
  if (/^(?:lib|app|apps\/api)\//.test(file)) return 'api/factory/coordinator'
  if (file.startsWith('drizzle/')) return 'database/migrations'
  if (file.startsWith('scripts/e2b/')) return 'e2b/runtime'
  if (globalPath(file)) return 'ci/release/security'
  if (isDocsOnly([file])) return 'docs-only'
  // A filename is not coverage: require the validated DB inventory and the
  // existing graph's direct command edge before recognizing an unmapped test.
  if (plan?.db.files.includes(file) && plan.db.scripts.some(script => {
    const id = dbId(script)
    return plan.graph.nodes[id] && plan.graph.dependencies[id]?.some(edge => edge.target === `source:${file}`)
  })) return 'database/tests'
  return 'unknown'
}
export function diffRange(env, event) {
  if (env.GITHUB_EVENT_NAME === 'pull_request') return [event.pull_request?.base?.sha, event.pull_request?.head?.sha]
  if (env.GITHUB_EVENT_NAME === 'merge_group') return [event.merge_group?.base_sha, event.merge_group?.head_sha]
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main') return [event.before, event.after]
  return [] // Manual, nightly, tag and unsupported events always run all checks.
}
// Root scripts only desktop.yml runs. Its other root scripts (lint:ui, build:app, migrate, test:e2e:setup and the
// test:desktop-auth DB suite) also run in Source checks, the build and the DB shards, which select on their own.
export const DESKTOP_ONLY_SCRIPTS = ['test:platform']
const cached = (cache, key, compute) => cache.has(key) ? cache.get(key) : cache.set(key, compute()).get(key)
const runTokenCache = new Map(), workspaceCache = new Map()
/** Every path desktop.yml runs directly (`node <path>` and DESKTOP_ONLY_SCRIPTS), whether or not the file still exists:
 * deleting or renaming one must still select Desktop. */
export function desktopRunPaths(root = process.cwd()) {
  return cached(runTokenCache, root, () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/desktop.yml'), 'utf8'))
    // A step's paths resolve against its working-directory; root scripts run from the root.
    const scripts = [...Object.values(workflow.jobs ?? {}).flatMap(job => (job.steps ?? []).map(step => [step['working-directory'] ?? '', step.run ?? ''])),
      ...DESKTOP_ONLY_SCRIPTS.map(name => ['', manifest.scripts?.[name] ?? ''])]
    return [...new Set(scripts.flatMap(([directory, text]) => text.split(/[\s"'`;|&()=]+/)
      .filter(token => /^[\w.-]+(?:\/[\w@.-]+)+$/.test(token) && !token.startsWith('.cache/'))
      .map(token => directory ? posix.normalize(posix.join(directory, token)) : token)))].sort()
  })
}
/** The files desktop.yml runs directly that exist in this tree, the seeds of Desktop's closure beyond @mikka/desktop. */
export function desktopEntryFiles(root, files) {
  const present = new Set(files)
  return desktopRunPaths(root).filter(token => present.has(token))
}
/** Directories (with a trailing slash) of every workspace package apps/desktop links through `workspace:`, followed
 * transitively, read from the package manifests so a new link cannot be missed. */
export function desktopWorkspaceRoots(root = process.cwd()) {
  return cached(workspaceCache, root, () => {
    const manifests = new Map()
    for (const parent of ['apps', 'packages']) {
      let entries = []
      try { entries = readdirSync(resolve(root, parent), { withFileTypes: true }) } catch { continue }
      for (const entry of entries.filter(entry => entry.isDirectory())) {
        try {
          const manifest = JSON.parse(readFileSync(resolve(root, parent, entry.name, 'package.json'), 'utf8'))
          if (manifest.name) manifests.set(manifest.name, { dir: `${parent}/${entry.name}/`, manifest })
        } catch {}
      }
    }
    const desktop = [...manifests.values()].find(({ dir }) => dir === 'apps/desktop/')
    const seen = new Set(), pending = desktop ? [desktop.manifest] : []
    while (pending.length) {
      const manifest = pending.pop()
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, version] of Object.entries(manifest[field] ?? {})) {
          if (!String(version).startsWith('workspace:') || seen.has(name)) continue
          seen.add(name)
          const linked = manifests.get(name)
          if (linked) pending.push(linked.manifest)
        }
      }
    }
    return [...seen].map(name => manifests.get(name)?.dir).filter(dir => dir && dir !== 'apps/desktop/').sort()
  })
}
const closures = new WeakMap()
/** Every source file Desktop's suite builds, imports or runs: the Nx closure of @mikka/desktop and of the files
 * desktop.yml runs directly. */
export function desktopClosure(plan, root = process.cwd()) {
  if (closures.has(plan)) return closures.get(plan)
  const seen = new Set()
  const pending = ['@mikka/desktop', ...desktopEntryFiles(root, plan.files).map(file => `source:${file}`)]
  while (pending.length) {
    const node = pending.pop()
    if (seen.has(node) || !plan.graph.nodes[node]) continue
    seen.add(node)
    for (const { target } of plan.graph.dependencies[node] ?? []) pending.push(target)
  }
  const result = new Set([...seen].filter(id => id.startsWith('source:')).map(id => id.slice('source:'.length)))
  closures.set(plan, result)
  return result
}
/** Desktop on a pull request: true only for a change that can reach the Desktop suite. `inputs` says whether the
 * root lockfile and manifest changes reach it (desktop-inputs.mjs); a change it does not cover counts as reaching it. */
function desktopOnPullRequest(plan, changes, inputs, root = process.cwd()) {
  const files = changes.map(c => c.file)
  const linked = desktopWorkspaceRoots(root), run = new Set(desktopRunPaths(root))
  if (files.some(file => DESKTOP_PATH.test(file) || DESKTOP_VIRTUAL_INPUT.test(file) || linked.some(dir => file.startsWith(dir)) || run.has(file))) return true
  // pnpm-workspace.yaml and nx.json change how every package resolves or builds.
  if (files.some(file => file === 'pnpm-workspace.yaml' || file === 'nx.json')) return true
  for (const [file, key] of Object.entries(ROOT_INPUTS)) if (files.includes(file) && inputs?.[key] !== false) return true
  const closure = desktopClosure(plan, root)
  if (files.some(file => !IMPLICIT_ALL.has(file) && closure.has(file))) return true
  // A deleted or renamed file Desktop imported leaves a dangling import in its closure (the candidate graph records it).
  return plan.unresolved.some(u => !u.spec.startsWith('<') && closure.has(u.file))
}
export async function select(plan, changes, { force = false, event, desktopInputs, root } = {}) {
  const { tasks } = plan
  const files = changes.map(c => c.file)
  const areas = [...new Set(files.map(file => area(file, plan)))].sort()
  const reasons = []
  if (force || !files.length) reasons.push('full integration or no trustworthy diff')
  if (changes.some(c => !['A', 'M'].includes(c.status) || c.mode !== '100644' || (c.oldMode !== '000000' && c.oldMode !== '100644'))) reasons.push('deletion, rename or non-regular/mode-changing file')
  if (files.some(globalPath)) reasons.push('global configuration, schema, policy or security input')
  if (areas.includes('unknown')) reasons.push('unmapped file')
  if (files.some(f => !plan.graph.nodes[`source:${f}`])) reasons.push('file absent from graph')
  if (plan.unresolved.some(u => files.includes(u.file))) reasons.push('changed source has unresolved/generated imports')
  let full = reasons.length > 0
  const docs = !full && isDocsOnly(files)
  let affected = []
  try {
    affected = Object.keys((await filterAffected(plan.graph, files.map(file => ({ file, getChanges: () => [] })), {}, {})).nodes)
  } catch (error) { full = true; reasons.push(`Nx affected failed (${error.name})`) }
  const selected = new Set(affected)
  // Source policies and security/credential/release regressions stay unconditional.
  const always = /test:(?:ui-policy|i18n|release-security|credentials|test-accounts|execution-rules|abuse|signup-turnstile|db-runner)|(?:i18n:check|check:agent-definitions)/
  const units = Object.entries(tasks).filter(([key, value]) => !docs && (full || selected.has(taskId(key)) || always.test(value.command) || key === 'core-triage')).map(([key]) => taskId(key))
  let suites = docs ? [] : plan.db.scripts.filter(s => full || selected.has(dbId(s)))
  // Server paths without a proven suite mapping must never silently skip DB.
  if (!docs && areas.includes('api/factory/coordinator') && suites.length === 0) {
    suites = plan.db.scripts; reasons.push('server change without proven DB coverage: all DB suites')
  }
  // A migration changes the schema every suite runs against, so it keeps the
  // full DB inventory. It is deliberately not a GLOBAL input: GLOBAL also turns
  // on the macOS packaged acceptance, and a new table says nothing about UI
  // rendering. `test:migrations` stays in the unit set through `always`.
  if (!docs && areas.includes('database/migrations')) {
    suites = plan.db.scripts; reasons.push('migration: all DB suites')
  }
  const shardCount = Math.min(4, Math.ceil(suites.length / 8))
  const flags = {
    source: !docs, daemon: !docs && (full || selected.has('@mikka/daemon') || areas.includes('daemon')),
    // Merge groups, main pushes and full runs keep the broad rule; a pull request takes the routed one.
    desktop: !docs && (event === 'pull_request' && !force && files.length
      ? desktopOnPullRequest(plan, changes, desktopInputs, root)
      : full || selected.has('@mikka/desktop') || areas.includes('desktop') || files.some(file => DESKTOP_VIRTUAL_INPUT.test(file))),
    analytics: !docs && (full || files.some(f => /analytics|posthog|instrumentation|^apps\/frontend\/|^app\/globals/.test(f))),
  }
  return { version: 1, full, docs_only: docs, areas, reasons, affected, units,
    unit_tasks: units.map(id => ({ project: id, target: `ci-tasks:${id.slice(3)}`, command: tasks[id.slice(3)].command.trim(), reason: full ? 'full validation' : always.test(tasks[id.slice(3)].command) || id === 'ci-core-triage' ? 'mandatory source/security policy' : 'Nx reverse dependency' })),
    db_suites: suites,
    db_matrix: { shard: Array.from({ length: shardCount }, (_, i) => `${i + 1}/${shardCount}`) }, ...flags }
}
export function emit(result, env = process.env) {
  if (env.GITHUB_OUTPUT) {
    const values = { ...result, db: result.db_suites.length > 0, core: result.units.some(n => n.startsWith('ci-core-')), integration: result.units.some(n => n.startsWith('ci-integration-')) }
    for (const [key, value] of Object.entries(values)) appendFileSync(env.GITHUB_OUTPUT, `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}\n`)
  }
  const summary = `## Dependency-aware CI selection\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\nInventory validated independently; skipped tasks are outside this affected closure. Full regressions remain available by dispatch/schedule.\n`
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary)
  console.log(JSON.stringify(result, null, 2))
}
/** Whether the root lockfile and manifest changes reach Desktop, read from the merge base and the head. */
export function desktopInputs(root, range, changes) {
  const inputs = {}
  if (range.length !== 2) return inputs
  for (const [file, key] of Object.entries(ROOT_INPUTS)) {
    if (!changes.some(c => c.file === file && c.status === 'M')) continue
    try {
      const base = execFileSync('git', ['merge-base', range[0], range[1]], { cwd: root, encoding: 'utf8' }).trim()
      const read = sha => execFileSync('git', ['show', `${sha}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      inputs[key] = (key === 'lockfile' ? lockfileTouchesDesktop : manifestTouchesDesktop)(read(base), read(range[1]))
    } catch { inputs[key] = true }
  }
  return inputs
}
export async function main(env = process.env) {
  const root = env.CI_CANDIDATE_ROOT || process.cwd()
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH)) : {}
  const provenance = diffRange(env, event)
  let frozen = null
  if (env.CI_POLICY_FALLBACK === 'true' && ['pull_request', 'merge_group'].includes(env.GITHUB_EVENT_NAME)) {
    if (env.CI_FORCE_FULL !== 'true' || provenance.length !== 2) throw Error('frozenCiFullCoverageRequired')
    frozen = frozenUnitInventory(root, { policy: env.CI_POLICY_SHA, base: provenance[0], head: provenance[1], checkout: env.GITHUB_SHA })
  }
  const plan = buildGraph(root, frozen?.tasks) // Always validates the entire candidate DB inventory.
  const range = env.CI_BASE && env.CI_HEAD ? [env.CI_BASE, env.CI_HEAD] : diffRange(env, event)
  let changes = [], force = env.CI_FORCE_FULL === 'true'
  try {
    if (range.length !== 2 || range.some(s => !s || /^0+$/.test(s))) throw Error('noRange')
    if (env.GITHUB_EVENT_NAME === 'push') execFileSync('git', ['merge-base', '--is-ancestor', ...range], { cwd: root })
    const raw = execFileSync('git', ['diff', '--no-renames', '--raw', '--no-abbrev', '-z', `${range[0]}...${range[1]}`], { cwd: root, encoding: 'utf8' }).split('\0')
    for (let i = 0; i < raw.length - 1; i += 2) {
      const [oldMode, mode, , , status] = raw[i].slice(1).split(' ')
      changes.push({ file: raw[i + 1], status, mode, oldMode })
    }
  } catch { force = true }
  const result = await select(plan, changes, { force, event: env.GITHUB_EVENT_NAME, desktopInputs: desktopInputs(root, range, changes), root })
  if (frozen) {
    result.unit_inventory = frozen.proof
    result.reasons.push('frozen dependency: complete unit inventory from reviewed main ancestor')
  }
  if (env.CI_SELECTION_FILE) writeFileSync(env.CI_SELECTION_FILE, JSON.stringify(result, null, 2) + '\n')
  emit(result, env)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
