import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  BASELINE_PATH,
  auditApiRoutes,
  inspectApiRouteSource,
  runRouteGuardPolicy,
} from './route-guard-policy.mjs'

const policyScript = fileURLToPath(new URL('./route-guard-policy.mjs', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mikka-route-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Route Guard Fixture'], { cwd: root })
  const write = (file, source) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  const commit = message => {
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: root })
  }
  const run = () => spawnSync(process.execPath, [policyScript], { cwd: root, encoding: 'utf8' })
  return { root, write, commit, run }
}

const GUARDED_SAMPLE = `
import { defineRoute } from '@/lib/primitives/define-route'
export const GET = defineRoute(
  { auth: 'mobile-or-session', origin: 'native-mobile-allowed', workspace: 'member' },
  async () => Response.json({ ok: true }),
)
`

const UNGUARDED_SAMPLE = `
export async function GET() {
  return Response.json({ ok: true })
}
`

test('the current repository satisfies the ratcheted route-guard baseline and includes flagship migrated routes', () => {
  const result = runRouteGuardPolicy()
  assert.deepEqual(result.problems, [])
  const guardedFiles = result.scan.guarded.map(entry => entry.file)
  for (const flagship of [
    'app/api/health/route.ts',
    'app/api/mobile/bots/route.ts',
    'app/api/mobile/chat-order/route.ts',
    'app/api/mobile/preferences/route.ts',
  ]) {
    assert.ok(guardedFiles.includes(flagship), `expected ${flagship} to be guarded`)
  }
  assert.equal(result.scan.unguarded.length, result.baseline.maxUnguardedRoutes)
})

test('inspectApiRouteSource accepts direct, aliased, relative, wrapped, and multi-method defineRoute handlers', () => {
  const direct = inspectApiRouteSource('app/api/a/route.ts', GUARDED_SAMPLE)
  assert.equal(direct.status, 'guarded')
  assert.deepEqual(direct.guardedMethods, ['GET'])

  const aliasedAndWrapped = inspectApiRouteSource(
    'app/api/b/route.ts',
    `
    import { defineRoute as guard } from '../../../lib/primitives/define-route'
    import { withRequestLog } from '@/lib/request-log'
    const spec = { auth: 'session', origin: 'same-origin-or-desktop', workspace: 'admin' } as const
    const postHandler = guard(spec, async () => Response.json({ ok: true }))
    export const GET = withRequestLog('/api/b', guard({ auth: 'public', origin: 'any', workspace: 'none' }, () => Response.json({ ok: true })))
    export { postHandler as POST }
    `,
  )
  assert.equal(aliasedAndWrapped.status, 'guarded')
  assert.deepEqual(aliasedAndWrapped.guardedMethods, ['GET', 'POST'])
})

test('inspectApiRouteSource flags unguarded methods, partial migrations, spoofed helpers, and invalid specs', () => {
  const raw = inspectApiRouteSource('app/api/raw/route.ts', UNGUARDED_SAMPLE)
  assert.equal(raw.status, 'unguarded')
  assert.deepEqual(raw.unguardedMethods, ['GET'])

  const partial = inspectApiRouteSource(
    'app/api/partial/route.ts',
    `
    import { defineRoute } from '@/lib/primitives/define-route'
    export const GET = defineRoute({ auth: 'public', origin: 'any', workspace: 'none' }, () => Response.json({}))
    export async function POST() { return Response.json({}) }
    `,
  )
  assert.equal(partial.status, 'unguarded')
  assert.deepEqual(partial.guardedMethods, ['GET'])
  assert.deepEqual(partial.unguardedMethods, ['POST'])

  // A local spoofed function named `defineRoute` cannot bypass the policy.
  const spoofed = inspectApiRouteSource(
    'app/api/spoof/route.ts',
    `
    const defineRoute = (_spec: unknown, fn: unknown) => fn
    export const GET = defineRoute({ auth: 'public', origin: 'any', workspace: 'none' }, () => Response.json({}))
    `,
  )
  assert.equal(spoofed.status, 'unguarded')
  assert.deepEqual(spoofed.unguardedMethods, ['GET'])

  const missingWorkspace = inspectApiRouteSource(
    'app/api/bad-spec/route.ts',
    `
    import { defineRoute } from '@/lib/primitives/define-route'
    export const GET = defineRoute({ auth: 'session', origin: 'any' }, () => Response.json({}))
    `,
  )
  assert.equal(missingWorkspace.status, 'invalid')
  assert.match(missingWorkspace.specErrors[0], /requires explicit valid literal `workspace`/)

  const publicWithWorkspace = inspectApiRouteSource(
    'app/api/bad-public/route.ts',
    `
    import { defineRoute } from '@/lib/primitives/define-route'
    export const GET = defineRoute({ auth: 'public', origin: 'any', workspace: 'member' }, () => Response.json({}))
    `,
  )
  assert.equal(publicWithWorkspace.status, 'invalid')
  assert.match(publicWithWorkspace.specErrors[0], /must use workspace: "none"/)

  const webhookWithoutVerifier = inspectApiRouteSource(
    'app/api/bad-webhook/route.ts',
    `
    import { defineRoute } from '@/lib/primitives/define-route'
    export const POST = defineRoute({ auth: 'webhook-signature', origin: 'any', workspace: 'none' }, () => Response.json({}))
    `,
  )
  assert.equal(webhookWithoutVerifier.status, 'invalid')
  assert.match(webhookWithoutVerifier.specErrors[0], /must provide `verifyWebhook`/)
})

test('auditApiRoutes rejects baseline increases, unlisted unguarded routes, and stale entries', () => {
  const previous = { version: 1, maxUnguardedRoutes: 1, legacyRoutes: ['app/api/legacy/route.ts'] }
  const inflated = {
    version: 1,
    maxUnguardedRoutes: 2,
    legacyRoutes: ['app/api/legacy/route.ts', 'app/api/new/route.ts'],
  }
  const scan = {
    total: 2,
    guarded: [],
    invalid: [],
    unguarded: [
      { file: 'app/api/legacy/route.ts', status: 'unguarded', methods: ['GET'], guardedMethods: [], unguardedMethods: ['GET'], specErrors: [] },
      { file: 'app/api/new/route.ts', status: 'unguarded', methods: ['POST'], guardedMethods: [], unguardedMethods: ['POST'], specErrors: [] },
    ],
    results: [
      { file: 'app/api/legacy/route.ts', status: 'unguarded', methods: ['GET'], guardedMethods: [], unguardedMethods: ['GET'], specErrors: [] },
      { file: 'app/api/new/route.ts', status: 'unguarded', methods: ['POST'], guardedMethods: [], unguardedMethods: ['POST'], specErrors: [] },
    ],
  }
  const errors = auditApiRoutes(scan, inflated, previous)
  assert.ok(errors.some(line => line.includes('maxUnguardedRoutes increased from 1 to 2')))
  assert.ok(errors.some(line => line.includes('cannot add app/api/new/route.ts to legacyRoutes')))
})

test('CLI ratchet blocks new unguarded routes, allows new guarded routes, and enforces downward ratcheting on migrations', t => {
  const f = fixture(t)
  f.write('app/api/legacy/route.ts', UNGUARDED_SAMPLE)
  f.write(
    BASELINE_PATH,
    JSON.stringify({ version: 1, maxUnguardedRoutes: 1, legacyRoutes: ['app/api/legacy/route.ts'] }, null, 2) + '\n',
  )
  f.commit('base')
  execFileSync('git', ['branch', '-M', 'main'], { cwd: f.root })
  execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: f.root })
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'main'], { cwd: f.root })

  assert.equal(f.run().status, 0)

  // Adding a new unguarded route fails immediately.
  f.write('app/api/brand-new/route.ts', UNGUARDED_SAMPLE)
  const blockedNew = f.run()
  assert.equal(blockedNew.status, 1)
  assert.match(blockedNew.stderr, /app\/api\/brand-new\/route\.ts: unguarded API route/)

  // Trying to cheat by bumping baseline in the same branch fails against origin/main.
  f.write(
    BASELINE_PATH,
    JSON.stringify(
      { version: 1, maxUnguardedRoutes: 2, legacyRoutes: ['app/api/brand-new/route.ts', 'app/api/legacy/route.ts'] },
      null,
      2,
    ) + '\n',
  )
  const blockedBump = f.run()
  assert.equal(blockedBump.status, 1)
  assert.match(blockedBump.stderr, /maxUnguardedRoutes increased from 1 to 2/)

  // Switching the new route to defineRoute and restoring the baseline passes.
  f.write('app/api/brand-new/route.ts', GUARDED_SAMPLE)
  f.write(
    BASELINE_PATH,
    JSON.stringify({ version: 1, maxUnguardedRoutes: 1, legacyRoutes: ['app/api/legacy/route.ts'] }, null, 2) + '\n',
  )
  assert.equal(f.run().status, 0)

  // Migrating the legacy route requires shrinking the baseline (strict downward ratchet).
  f.write('app/api/legacy/route.ts', GUARDED_SAMPLE)
  const stale = f.run()
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /stale entry app\/api\/legacy\/route\.ts is now guarded/)

  f.write(BASELINE_PATH, JSON.stringify({ version: 1, maxUnguardedRoutes: 0, legacyRoutes: [] }, null, 2) + '\n')
  const ratcheted = f.run()
  assert.equal(ratcheted.status, 0)
  assert.match(ratcheted.stdout, /2 guarded, 0 legacy unguarded \(ceiling 0\)/)
})

test('shallow synthetic PR merge checkouts still enforce the ratchet against pull_request.base.sha and fail closed when unresolvable', t => {
  // Simulate an upstream repo with an enrolled baseline on `main`, and a PR branch adding a new unguarded route + bumping baseline.
  const remote = fixture(t)
  remote.write('app/api/legacy/route.ts', UNGUARDED_SAMPLE)
  remote.write(
    BASELINE_PATH,
    JSON.stringify({ version: 1, maxUnguardedRoutes: 1, legacyRoutes: ['app/api/legacy/route.ts'] }, null, 2) + '\n',
  )
  remote.commit('base')
  execFileSync('git', ['branch', '-M', 'main'], { cwd: remote.root })
  const baseSha = execFileSync('git', ['rev-parse', 'main'], { cwd: remote.root, encoding: 'utf8' }).trim()

  execFileSync('git', ['checkout', '-q', '-b', 'pr-cheat'], { cwd: remote.root })
  remote.write('app/api/sneaky/route.ts', UNGUARDED_SAMPLE)
  remote.write(
    BASELINE_PATH,
    JSON.stringify(
      { version: 1, maxUnguardedRoutes: 2, legacyRoutes: ['app/api/legacy/route.ts', 'app/api/sneaky/route.ts'] },
      null,
      2,
    ) + '\n',
  )
  remote.commit('pr adds unguarded route and bumps baseline')
  const prSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remote.root, encoding: 'utf8' }).trim()

  // Create a depth=1 shallow clone of ONLY the PR commit (disconnected from main, mirroring shallow PR checkouts).
  const shallow = mkdtempSync(join(tmpdir(), 'mikka-route-guard-shallow-'))
  t.after(() => rmSync(shallow, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q'], { cwd: shallow })
  execFileSync('git', ['remote', 'add', 'origin', remote.root], { cwd: shallow })
  execFileSync('git', ['fetch', '--depth=1', 'origin', prSha], { cwd: shallow, stdio: 'ignore' })
  execFileSync('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: shallow })

  const eventFile = join(shallow, '.git', 'event.json')
  writeFileSync(eventFile, JSON.stringify({ pull_request: { base: { sha: baseSha } } }))
  const blocked = spawnSync(process.execPath, [policyScript], {
    cwd: shallow,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventFile },
  })
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /maxUnguardedRoutes increased from 1 to 2/)
  assert.match(blocked.stderr, /cannot add app\/api\/sneaky\/route\.ts to legacyRoutes/)

  // If the PR base commit cannot be resolved at all, fail closed instead of comparing baseline to itself.
  const badEventFile = join(shallow, '.git', 'bad-event.json')
  writeFileSync(badEventFile, JSON.stringify({ pull_request: { base: { sha: 'deadbeef'.repeat(5) } } }))
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: shallow })
  const failClosed = spawnSync(process.execPath, [policyScript], {
    cwd: shallow,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: badEventFile },
  })
  assert.equal(failClosed.status, 1)
  assert.match(failClosed.stderr, /cannot resolve trusted base commit for pull_request event/)
})

test('the route-guard policy is wired into package.json and the required source-checks CI job', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(
    pkg.scripts['check:route-guard'],
    'node scripts/route-guard-policy.mjs && node --test scripts/route-guard-policy.test.mjs && node --import tsx --test lib/primitives/define-route.test.ts',
  )
  assert.ok(pkg.scripts.check.split(' && ').includes('pnpm check:route-guard'))
  const workflow = readFileSync(new URL('../.github/workflows/ui-policy.yml', import.meta.url), 'utf8')
  const sourceChecks = workflow.slice(workflow.indexOf('\n  source-checks:'), workflow.indexOf('\n  daemon-checks:'))
  assert.match(sourceChecks, /fetch-depth:\s*0/)
  assert.match(sourceChecks, /run: pnpm check:route-guard/)
})
