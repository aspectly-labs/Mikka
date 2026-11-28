import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { verifyPromotedWeb, verifyDesktopPromotedWeb, readServingPromotion, readProductionVersion, promotionTrigger } from './cloudflare-promoted-web.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const product = 'abc1234'.padEnd(40, '5'), overlay = 'c'.repeat(40), releasePin = 'abc1234-902-1'
const verified = Date.parse('2026-11-10T10:00:00.100Z')
const iso = offset => new Date(verified + offset).toISOString()
const repo = 'alexj11324/Mikka', issue = 'https://api.github.com/repos/' + repo + '/issues/1954'
const api = '/repositories/1427517699'
const workflow = '.github/workflows/e2b-official-runtime.yml'

function fixture(change = {}) {
  const inventory = { url: 'https://github.com/alexj11324/mikka-cloud/issues/4#issuecomment-901', sha256: 'd'.repeat(64) }
  const approval = { product, overlay, from: iso(-1000), until: iso(3 * 3600_000), decision: 'approved',
    evidence: { inventoryAndRollback: inventory }, ...change.approval }
  const owner = { issue_url: issue, user: { id: 183887963, login: 'alexj11324' }, author_association: 'OWNER' }
  const prior = { ...owner, id: 80, body: 'MIKKA_CUTOVER_ACCEPTANCE_V1\r\n' + JSON.stringify(approval), ...change.prior }
  const record = { schema: 'mikka.cloudflare-promotion.v1', approvalComment: '80', approvalSha256: digest(prior.body), product,
    overlay, releasePin, gatewayVersionSha256: 'e'.repeat(64), inventorySha256: 'd'.repeat(64), verifiedAt: iso(0),
    outcome: 'promoted', ...change.record }
  const raw = change.raw?.(record) ?? JSON.stringify(record)
  const post = { ...owner, id: 81, body: 'MIKKA_CLOUDFLARE_WEB_PROMOTION_V1\n' + raw, ...change.post }
  const env = { GITHUB_REPOSITORY: repo, GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: '183887963', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: product,
    GITHUB_RUN_ID: '55', GITHUB_RUN_ATTEMPT: '2', GITHUB_TOKEN: 'test', CLOUDFLARE_RECEIPT: '81-' + digest(post.body), ...change.env }
  withDesktopDispatch(env)
  const started = { repository: { id: 1427517699, full_name: repo, owner: { id: 183887963 } }, event: 'workflow_dispatch', path: workflow, head_sha: product, head_branch: 'main',
    id: 55, run_attempt: 2, run_started_at: iso(30000), actor: { id: 183887963, login: 'alexj11324' },
    triggering_actor: { id: 183887963, login: 'alexj11324' }, ...change.run }
  const anchor = { name: '_mikka-release.aspectlylabs.com.', type: 16, data: '"mikka-release-v1=sha256:' + digest(raw) + '"' }
  const calls = []
  const fetchImpl = async (url, options) => {
    const u = new URL(url)
    calls.push(u.pathname)
    assert.equal(options.redirect, 'error')
    assert.equal(options.cache, 'no-store')
    if (u.origin === 'https://api.github.com') {
      if (change.observation && u.pathname.includes('/actions/runs/99/attempts/1')) return Response.json(u.pathname.endsWith('/jobs') ? change.observation.jobs : change.observation.run)
      assert.equal(options.headers.authorization, 'Bearer test')
      if (u.pathname === api + '/compare/' + product + '...main') {
        return Response.json({ status: (change.main ?? product) === product ? 'identical' : 'ahead', merge_base_commit: { sha: product }, ...change.served })
      }
      if (u.pathname.includes('/compare/')) {
        const latestSha = (change.latestRelease ?? { target_commitish: 'f'.repeat(40) }).target_commitish
        if (u.pathname === api + '/compare/' + product + '...' + latestSha) {
          assert.equal(u.searchParams.get('per_page'), '1')
          return Response.json({ url: 'https://api.github.com/repos/' + repo + '/compare/' + product + '...' + latestSha, base_commit: { sha: product },
            merge_base_commit: { sha: latestSha }, status: 'behind', ahead_by: 0, behind_by: 1, ...change.latestComparison })
        }
        const path = api + '/compare/' + env.GITHUB_SHA + '...' + product
        assert.equal(u.pathname, path)
        assert.equal(u.searchParams.get('per_page'), '1')
        return Response.json({ url: 'https://api.github.com/repos/' + repo + '/compare/' + env.GITHUB_SHA + '...' + product, base_commit: { sha: env.GITHUB_SHA },
          merge_base_commit: { sha: env.GITHUB_SHA }, status: 'ahead', ahead_by: 1, behind_by: 0, ...change.comparison })
      }
      const body = { [api + '/issues/comments/81']: post, [api + '/issues/comments/80']: prior,
        [api + '/actions/runs/55/attempts/2']: started,
        [api + '/git/ref/heads/main']: { object: { type: 'commit', sha: change.main ?? product } },
        [api + '/releases/latest']: change.latestRelease ?? { target_commitish: 'f'.repeat(40) } }[u.pathname]
      assert.ok(body, u.pathname)
      return Response.json(body)
    }
    assert.equal(options.headers.authorization, undefined)
    if (u.hostname === 'cloudflare-dns.com') {
      assert.equal(options.headers.accept, 'application/dns-json')
      assert.equal(u.search, '?name=_mikka-release.aspectlylabs.com&type=TXT')
      return Response.json({ Status: 0, TC: false, Answer: [anchor], ...change.dns?.(anchor) })
    }
    assert.equal(u.origin, 'https://app.aspectlylabs.com')
    if (u.pathname === '/mikka/api/version') return Response.json({ build: product, overlaySha: overlay, ...change.version }, {
      headers: { 'cf-ray': 'edge', 'x-mikka-gateway-version-sha256': record.gatewayVersionSha256, ...change.headers } })
    assert.equal(u.pathname, '/mikka/en/sign-in')
    return new Response(change.shell ?? '<script type="module" src="/mikka/assets/entry-123.js?dpl=' + releasePin + '"></script>')
  }
  const options = { env, event: change.event, fetchImpl, now: () => verified + (change.elapsed ?? 3600000) }
  return { verify: () => verifyPromotedWeb(options), desktop: () => verifyDesktopPromotedWeb(options),
    trigger: consumer => promotionTrigger(consumer, { env, event: change.event, fetchImpl }),
    observe: () => readServingPromotion(env.CLOUDFLARE_RECEIPT,{token:env.GITHUB_TOKEN,fetchImpl,now:options.now()}),calls }
}

test('revalidates the live promoted Web on the original dispatch after 3976 seconds of native work', async () => {
  for (const elapsed of [60000, 3976000]) {
    const f = fixture({ elapsed })
    assert.deepEqual(await f.verify(), { product, releasePin })
    assert.equal(f.calls.length, 7)
    assert.equal(f.calls.at(-1), api + '/compare/' + product + '...main')
  }
})
test('rejects dispatch, owner, hash, inventory, timing and current-main changes', async () => {
  for (const [change, code] of [
    [{ env: { GITHUB_EVENT_NAME: 'push' } }, 'dispatch'],
    [{ env: { CLOUDFLARE_RECEIPT: '81-' + 'f'.repeat(64) } }, 'commentChanged'],
    [{ post: { issue_url: issue + '0' } }, 'ownerComment'],
    [{ prior: { author_association: 'MEMBER' } }, 'ownerComment'],
    [{ post: { user: { id: 1, login: 'alexj11324' } } }, 'ownerComment'],
    [{ record: { approvalSha256: 'f'.repeat(64) } }, 'commentChanged'],
    [{ env: { MIKKA_RUNTIME_SOURCE: 'b'.repeat(40) } }, 'dispatchSource'],
    [{ record: { releasePin: 'abc1234-x-1' } }, 'clientPin'],
    [{ raw: record => JSON.stringify(record, null, 2) }, 'receiptShape'],
    [{ raw: record => JSON.stringify({ ...record, privateMapping: 'extra' }) }, 'receiptShape'],
    [{ record: { outcome: 'rolled-back' } }, 'receiptShape'],
    [{ record: { verifiedAt: '2026-11-10' } }, 'verificationTime'],
    [{ record: { inventorySha256: 'f'.repeat(64) } }, 'approval'],
    [{ approval: { decision: 'denied' } }, 'approval'],
    [{ approval: { overlay: 'f'.repeat(40) } }, 'approval'],
    [{ approval: { evidence: {} } }, 'approval'],
    [{ run: { path: '.github/workflows/other.yml' } }, 'runIdentity'],
    [{ run: { run_attempt: 1 } }, 'runIdentity'],
    [{ run: { run_started_at: iso(600001) } }, 'staleDispatch'],
    [{ run: { run_started_at: iso(-30000) } }, 'staleDispatch'],
    [{ elapsed: 3 * 3600_000 }, 'approvalWindow'],
    [{ served: { status: 'diverged' } }, 'servedOnMain'],
  ]) await assert.rejects(fixture(change).verify(), new RegExp(code), code)
})
test('a later main dispatch publishes the served product only when it is already part of main', async () => {
  const head = '7'.repeat(40), env = { GITHUB_SHA: head }, run = { head_sha: head }
  const later = fixture({ env, run, main: head })
  assert.deepEqual(await later.verify(), { product, releasePin })
  assert.ok(later.calls.includes(api + '/compare/' + product + '...main'))
  // A merge to main during the release does not block publishing the served commit.
  assert.deepEqual(await fixture({ env, run, main: 'e'.repeat(40) }).verify(), { product, releasePin })
  assert.deepEqual(await fixture({ env: { ...env, MIKKA_RUNTIME_SOURCE: product }, run, main: head }).verify(), { product, releasePin })
  for (const [change, code] of [
    [{ served: { status: 'diverged' } }, 'servedOnMain'],
    [{ served: { merge_base_commit: { sha: 'f'.repeat(40) } } }, 'servedOnMain'],
    [{ env: { ...env, MIKKA_RUNTIME_SOURCE: head } }, 'dispatchSource'],
  ]) await assert.rejects(fixture({ run, main: head, ...change, env: { ...env, ...change.env } }).verify(), new RegExp(code), code)
})
test('rejects stale DNS, rollback, a legacy gateway serving the same SHA, and client skew', async () => {
  for (const [change, code] of [
    [{ dns: () => ({ Status: 3, Answer: [] }) }, 'dnsAnchor'],
    [{ dns: a => ({ Answer: [a, a] }) }, 'dnsAnchor'],
    [{ dns: a => ({ Answer: [{ ...a, name: 'other.example.' }] }) }, 'dnsAnchor'],
    [{ dns: a => ({ Answer: [{ ...a, data: '"prior"' }] }) }, 'dnsAnchor'],
    [{ dns: () => ({ TC: true }) }, 'dnsAnchor'],
    [{ headers: { 'x-vercel-id': 'same-source' } }, 'gatewayVersion'],
    [{ headers: { 'x-mikka-gateway-version-sha256': '0'.repeat(64) } }, 'gatewayVersion'],
    [{ version: { overlaySha: 'a'.repeat(40) } }, 'productionSource'],
    [{ shell: '<script src="/mikka/assets/current.js?dpl=old"></script>' }, 'servedClientPin'],
    [{ shell: '<script src="/mikka/assets/current.js?dpl=' + releasePin + '&amp;dpl=old"></script>' }, 'servedClientPin'],
  ]) await assert.rejects(fixture(change).verify(), new RegExp(code), code)
})
test('Desktop binds its own original attempt, installer ancestry, overlay and serving gateway before publication', async () => {
  const installer = '9'.repeat(40)
  const run = { path: '.github/workflows/desktop-release.yml', head_sha: installer }
  const env = { GITHUB_SHA: installer, MIKKA_DESKTOP_SOURCE: installer, MIKKA_UI_OVERLAY_SHA: overlay }
  const good = fixture({ env, run, elapsed: 5400000 })
  assert.deepEqual(await good.desktop(), { product, releasePin, overlay })
  assert.ok(good.calls.some(path => path.endsWith('/compare/' + installer + '...' + product)))
  await assert.rejects(good.verify(), /runIdentity/)
  const exact = fixture({ run: { ...run, head_sha: product } })
  assert.deepEqual(await exact.desktop(), { product, releasePin, overlay })
  // Built from the served commit itself: no installer ancestry comparison, only the served-on-main check.
  assert.ok(!exact.calls.some(path => path.endsWith('...' + product)))
  for (const [change, code] of [
    [{ run: { ...run, path: workflow } }, 'runIdentity'],
    [{ run: { ...run, head_sha: product } }, 'runIdentity'],
    [{ run: { ...run, run_attempt: 3 } }, 'runIdentity'],
    [{ run: { ...run, event: 'push' } }, 'runIdentity'],
    [{ env: { ...env, EXPECTED_UI_OVERLAY_SHA: 'a'.repeat(40), MIKKA_UI_OVERLAY_SHA: '' } }, 'desktopOverlay'],
    [{ env: { ...env, MIKKA_UI_OVERLAY_SHA: 'a'.repeat(40) } }, 'desktopOverlay'],
    [{ comparison: { merge_base_commit: { sha: product }, status: 'diverged', behind_by: 1 } }, 'desktopSource'],
    [{ comparison: { base_commit: { sha: product } } }, 'invalidCommitComparison'],
    [{ served: { status: 'diverged' } }, 'servedOnMain'],
    [{ headers: { 'x-vercel-id': 'old' } }, 'gatewayVersion'],
    [{ elapsed: 4 * 3600000 }, 'approvalWindow'],
  ]) await assert.rejects(fixture({ env, run, ...change }).desktop(), new RegExp(code))
  await assert.rejects(fixture({ run: { path: '.github/workflows/desktop-release.yml' } }).verify(), /runIdentity/)
})

test('the paid builder and publication run only behind the Cloudflare receipt, with no Vercel publisher', () => {
  const read = name => readFileSync(new URL('../../.github/workflows/' + name, import.meta.url), 'utf8')
  const parent = read('e2b-official-runtime.yml'), child = read('e2b-runtime-release.yml')
  const gate = 'run: node scripts/release/cloudflare-promoted-web.mjs'
  const verify = parent.indexOf(gate + '\n'), trigger = parent.indexOf(gate + ' trigger runtime')
  assert.ok(verify > parent.indexOf('  web-ready:') && verify < parent.indexOf('  release:'))
  assert.ok(trigger > parent.indexOf('  check:') && trigger < parent.indexOf('  web-ready:'))
  const paid = child.indexOf('    uses: ./.github/workflows/e2b-template.yml')
  const proof = child.indexOf('run: cp "$RUNNER_TEMP/e2b-candidates/candidates.json" "$RUNNER_TEMP/accepted.json"')
  const first = child.indexOf(gate), second = child.indexOf(gate, first + 1), third = child.indexOf(gate, second + 1)
  assert.ok(first >= 0 && first < paid && paid < second && second < proof && proof < third && third < child.indexOf('--publish-verified'))
  assert.match(child, /id: release[\s\S]*node scripts\/e2b\/runtime-report\.mjs reference\n          node scripts\/release\/cloudflare-promoted-web\.mjs/)
  for (const source of [parent, child]) {
    assert.doesNotMatch(source, /web-deploy\.mjs await-|workflows\/web-deploy\.yml|\n  publish:/)
    // Every receipt gate runs unconditionally; an empty receipt fails closed.
    assert.doesNotMatch(source, /if: github\.event\.inputs\.cloudflare_receipt != ''/)
  }
})

test('read-only monitor witness rechecks an older actual promotion without authorizing publication', async () => {
  const historical=fixture({elapsed:100*86400000})
  assert.equal((await historical.observe()).product,product)
  assert.ok(!historical.calls.some(path=>path.includes('/actions/runs/')))
  await assert.rejects(historical.verify(),/approvalWindow/)
  for(const changed of [{headers:{'x-vercel-id':'old'}},{version:{overlaySha:'1'.repeat(40)}},
    {shell:'<script src="/unrelated.js"></script>'},{approval:{decision:'rejected'}},
    {approval:{until:iso(-10000)}},{post:{author_association:'MEMBER'}}]){
    await assert.rejects(fixture(changed).observe())
  }
})

test('Desktop and E2B accept only an original successful protected serving observation and the currently served pins', async () => {
  const repository = { id:1427517699, full_name:repo, fork:false }
  const actor = { id:183887963, login:'alexj11324' }
  const run = { repository, head_repository:repository, path:'.github/workflows/cloudflare-app-deploy.yml', head_branch:'main',
    head_sha:product, id:99, run_attempt:1, event:'workflow_dispatch', status:'completed', conclusion:'success', actor, triggering_actor:actor }
  const gate = { status:'completed', conclusion:'success', head_sha:product, run_id:99, run_attempt:1, completed_at:iso(0) }
  const jobs = { total_count:2, jobs:[{...gate,name:'deploy-application'}, {...gate,name:'Serving release '+[product,overlay,releasePin,'e'.repeat(64)].join(' ')}] }
  const observation = {run,jobs}, env = {CLOUDFLARE_RECEIPT:'actions:99:1'}, consumer = {actor,triggering_actor:actor}
  const f = fixture({observation,env,run:consumer})
  assert.deepEqual(await f.verify(),{product,releasePin})
  assert.equal((await f.observe()).verifiedAt,iso(0))
  assert.ok(!f.calls.some(path=>path.includes('/issues/')||path==='/dns-query'))
  assert.deepEqual(await fixture({observation,env,run:{...consumer,path:'.github/workflows/desktop-release.yml'}}).desktop(),{product,overlay,releasePin})
  await assert.rejects(fixture({
    observation, env, run: { ...consumer, path: '.github/workflows/desktop-release.yml' },
    latestComparison: { merge_base_commit: { sha: product }, status: 'ahead', ahead_by: 1, behind_by: 0 },
  }).desktop(), /staleRelease/)
  for (const change of [{observation:{...observation,run:{...run,conclusion:'failure'}}},
    {observation:{...observation,run:{...run,triggering_actor:{id:1}}}},
    {observation:{...observation,jobs:{total_count:2,jobs:[jobs.jobs[0],{...jobs.jobs[1],run_attempt:2}]}}},
    {observation:{...observation,jobs:{total_count:2,jobs:[jobs.jobs[0],{...jobs.jobs[1],name:'Prepared release'}]}}},
    {observation:{...observation,jobs:{total_count:1,jobs:[jobs.jobs[1]]}}},
    {headers:{'x-mikka-gateway-version-sha256':'1'.repeat(64)}}, {version:{overlaySha:'1'.repeat(40)}},
    {run:{...consumer,actor:{id:1}}}, {served:{status:'diverged'}}]) {
    await assert.rejects(fixture({observation,env,run:consumer,...change}).verify())
  }
})

test('a successful gateway observation starts the runtime release by itself, but never Desktop', async () => {
  const repository = { id:1427517699, full_name:repo, fork:false }
  const actor = { id:183887963, login:'alexj11324' }
  const run = { repository, head_repository:repository, path:'.github/workflows/cloudflare-app-deploy.yml', head_branch:'main',
    head_sha:product, id:99, run_attempt:1, event:'workflow_dispatch', status:'completed', conclusion:'success', actor, triggering_actor:actor }
  const gate = { status:'completed', conclusion:'success', head_sha:product, run_id:99, run_attempt:1, completed_at:iso(0) }
  const jobs = { total_count:2, jobs:[{...gate,name:'deploy-application'}, {...gate,name:'Serving release '+[product,overlay,releasePin,'e'.repeat(64)].join(' ')}] }
  const observation = { run, jobs }, event = { workflow_run: run }
  const env = { GITHUB_EVENT_NAME:'workflow_run', CLOUDFLARE_RECEIPT:'' }
  const desktop = '.github/workflows/desktop-release.yml'

  const started = fixture({ observation, event, env })
  assert.deepEqual(await started.trigger(workflow), { ready:true, receipt:'actions:99:1', product,
    reason:'Cloudflare serves ' + product + ' on main' })
  // An owner gateway-observe dispatch is a manual production action: Desktop waits for its own explicit dispatch.
  for (const change of [{}, { main:'a'.repeat(40) }, { served:{ status:'diverged' } }, { latestRelease:{ target_commitish:'f'.repeat(40) } }]) {
    const desktopTrigger = await fixture({ observation, event, env, ...change }).trigger(desktop)
    assert.deepEqual(desktopTrigger, { ready:false,
      reason:'Desktop starts only from an automatic production promotion or an explicit desktop-release.yml dispatch' })
  }

  // The started consumer verifies exactly that observation, under its own workflow_run identity.
  const chainedEnv = { ...env, CLOUDFLARE_RECEIPT:'actions:99:1' }, consumer = { actor, triggering_actor:actor, event:'workflow_run' }
  assert.deepEqual(await fixture({ observation, event, env:chainedEnv, run:consumer }).verify(), { product, releasePin })
  // A chained Desktop run refuses the observation receipt; the owner's own Desktop dispatch accepts it.
  await assert.rejects(fixture({ observation, event, env:chainedEnv, run:{ ...consumer, path:desktop } }).desktop(), /dispatchSource/)
  assert.deepEqual(await fixture({ observation, event, env:{ ...chainedEnv, GITHUB_EVENT_NAME:'workflow_dispatch' },
    run:{ actor, triggering_actor:actor, event:'workflow_dispatch', path:desktop } }).desktop(), { product, overlay, releasePin })
  for (const change of [{ event:{ workflow_run:{ ...run, id:98 } } }, { event:{ workflow_run:{ ...run, run_attempt:2 } } },
    { run:{ ...consumer, event:'workflow_dispatch' } }, { env:{ ...chainedEnv, CLOUDFLARE_RECEIPT:'81-' + 'f'.repeat(64) } }]) {
    await assert.rejects(fixture({ observation, event, env:chainedEnv, run:consumer, ...change }).verify(), /dispatch|runIdentity/)
  }

  // Anything else is a quiet no-op, not a failure.
  for (const [change, reason] of [
    [{ event:{ workflow_run:{ ...run, conclusion:'failure' } } }, /not a successful Cloudflare deployment/],
    [{ event:{ workflow_run:{ ...run, head_branch:'other' } } }, /not a successful Cloudflare deployment/],
    [{ event:{ workflow_run:{ ...run, path:'.github/workflows/other.yml' } } }, /not a successful Cloudflare deployment/],
    [{ env:{ ...env, GITHUB_EVENT_NAME:'push' } }, /not a successful Cloudflare deployment/],
    [{ observation:{ run, jobs:{ total_count:1, jobs:[jobs.jobs[0]] } } }, /does not change what is served/],
    [{ observation:{ run, jobs:{ total_count:2, jobs:[jobs.jobs[0], { ...jobs.jobs[1], name:'Serving release ${{ needs.deploy-application.outputs.serving-release }}', conclusion:'skipped' }] } } }, /does not change what is served/],
    [{ main:'a'.repeat(40) }, /but main is a{40}/],
    [{ env:{ ...env, GITHUB_SHA:'a'.repeat(40) } }, /but main is/],
  ]) {
    const result = await fixture({ observation, event, env, ...change }).trigger(workflow)
    assert.equal(result.ready, false)
    assert.match(result.reason, reason)
  }
  assert.equal((await fixture({ observation, event, env, latestRelease:{ target_commitish:product } }).trigger(workflow)).ready, true)
  // A gateway that no longer serves the observed pins fails loudly.
  await assert.rejects(fixture({ observation, event, env, headers:{ 'x-mikka-gateway-version-sha256':'1'.repeat(64) } }).trigger(workflow))
})


test('transferred native dispatches retain historical owner receipts and reject mixed repository profiles', async () => {
  const env = { GITHUB_REPOSITORY: 'aspectly-labs/Mikka', GITHUB_REPOSITORY_OWNER_ID: '359279274' }
  const repository = { id: 1427517699, full_name: 'aspectly-labs/Mikka', owner: { id: 359279274 } }
  assert.deepEqual(await fixture({ env, run: { repository } }).verify(), { product, releasePin })
  const post = { issue_url: 'https://api.github.com/repos/aspectly-labs/Mikka/issues/1954', author_association: 'MEMBER' }
  assert.deepEqual(await fixture({ env, run: { repository }, post, prior: post }).verify(), { product, releasePin })
  for (const patch of [{ GITHUB_REPOSITORY_ID: '42' }, { GITHUB_REPOSITORY_OWNER_ID: '183887963' },
    { GITHUB_REPOSITORY: 'foreign/Mikka' }, { GITHUB_REPOSITORY_OWNER_ID: '' }]) {
    await assert.rejects(fixture({ env: { ...env, ...patch }, run: { repository } }).verify(), /dispatch/)
  }
  for (const invalid of [{ ...repository, id: 42 }, { ...repository, owner: { id: 183887963 } }]) {
    await assert.rejects(fixture({ env, run: { repository: invalid } }).verify(), /runIdentity/)
  }
  await assert.rejects(fixture({ env, run: { repository }, post: { ...post, user: { id: 359279274, login: 'aspectly-labs' } } }).verify(), /ownerComment/)
})

function zipJson(entries) {
  return execFileSync('python3', ['-c', String.raw`
import io,json,sys,zipfile
buf=io.BytesIO()
with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as archive:
    for name,payload in json.loads(sys.stdin.read()).items():
        archive.writestr(name,json.dumps(payload,indent=2)+'\n')
sys.stdout.buffer.write(buf.getvalue())
`], { input: JSON.stringify(entries), stdio: ['pipe', 'pipe', 'pipe'] })
}

// A hand-dispatched Desktop carries the release policy projection and runs main's own workflow file.
const releasePolicy = JSON.stringify({ promoters: [{ id: 183887963, login: 'alexj11324' }, { id: 158243242, login: 'devin-ai-integration[bot]' }],
  requiredChecks: [{ name: 'desktop-route-guard', kind: 'builtin' }] })
function withDesktopDispatch(env) {
  if (!('MIKKA_RELEASE_POLICY' in env)) env.MIKKA_RELEASE_POLICY = releasePolicy
  if (!('GITHUB_WORKFLOW_REF' in env)) env.GITHUB_WORKFLOW_REF = env.GITHUB_REPOSITORY + '/.github/workflows/desktop-release.yml@refs/heads/main'
  if (!('GITHUB_WORKFLOW_SHA' in env)) env.GITHUB_WORKFLOW_SHA = env.GITHUB_SHA
  for (const [key, value] of Object.entries(env)) if (value === null) delete env[key]
  return env
}

function pipelineFixture(change = {}) {
  const desktop = '.github/workflows/desktop-release.yml'
  const head = change.head ?? 'b'.repeat(40)
  const webSha = change.webSha ?? product
  const apiSha = change.apiSha ?? webSha
  const latestSha = change.latestSha ?? 'f'.repeat(40)
  const mergeQueue = { id: 118344674, login: 'github-merge-queue[bot]' }
  const owner = { id: 183887963, login: 'alexj11324' }
  const repository = { id: 1427517699, full_name: 'aspectly-labs/Mikka', owner: { id: 359279274 }, fork: false }
  const deployRun = {
    repository, head_repository: repository, path: '.github/workflows/cloudflare-app-deploy.yml',
    head_branch: 'main', head_sha: head, id: 101, run_attempt: 1, event: 'workflow_run',
    status: 'completed', conclusion: 'success', actor: mergeQueue, triggering_actor: mergeQueue,
    ...change.deployRun,
  }
  const prodSteps = change.prodSteps ?? [
    { name: 'Promote and verify the staged service manifest', status: 'completed', conclusion: 'success' },
    { name: 'Upload production receipts', status: 'completed', conclusion: 'success' },
  ]
  const gate = { status: 'completed', conclusion: 'success', head_sha: deployRun.head_sha, run_id: 101, run_attempt: 1, completed_at: iso(0) }
  const jobs = change.jobs ?? {
    total_count: 2,
    jobs: [
      { ...gate, id: 9000, name: 'pipeline' },
      { ...gate, id: 9001, name: 'pipeline-production', steps: prodSteps },
    ],
  }
  const manifest = {
    version: 1, sourceCommit: deployRun.head_sha, overlayCommit: overlay,
    services: {
      web: { kind: 'worker', sourceCommit: webSha, overlayCommit: overlay, release: releasePin, reused: webSha !== deployRun.head_sha, ...change.webService },
      api: { kind: 'container', sourceCommit: apiSha, overlayCommit: overlay, reused: apiSha !== deployRun.head_sha, ...change.apiService },
    },
    ...change.manifest,
  }
  const summary = {
    version: 1, target: 'production', status: 'passed', sourceCommit: deployRun.head_sha,
    manifestSha256: digest(JSON.stringify(manifest)),
    deployment: { runId: '101', runAttempt: '1', driverSource: deployRun.head_sha, operationsSource: 'd'.repeat(40) },
    productionPromoted: true, verification: { status: 'pass' },
    modelAcceptance: { status: 'passed', source: webSha, overlay },
    ...change.summary,
  }
  const archive = change.archive ?? zipJson(change.files ?? { 'pipeline-summary.json': summary, 'release-manifest.json': manifest })
  const artifact = {
    id: 7001, name: 'deploy-production-101-1', expired: false,
    size_in_bytes: archive.length, digest: 'sha256:' + createHash('sha256').update(archive).digest('hex'),
    workflow_run: { id: 101, head_sha: deployRun.head_sha, head_branch: 'main', repository_id: 1427517699, head_repository_id: 1427517699 },
    ...change.artifact,
  }
  const prodLog = change.prodLog ?? `2026-11-26T19:04:00Z Artifact ${artifact.name}.zip successfully finalized. Artifact ID ${artifact.id}\n`
  const consumerRun = {
    repository, event: 'workflow_run', path: desktop, head_sha: deployRun.head_sha, head_branch: 'main',
    id: 55, run_attempt: 2, actor: mergeQueue, triggering_actor: mergeQueue, ...change.consumerRun,
  }
  const env = {
    GITHUB_REPOSITORY: 'aspectly-labs/Mikka', GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: '359279274',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_SHA: deployRun.head_sha,
    GITHUB_RUN_ID: '55', GITHUB_RUN_ATTEMPT: '2', GITHUB_TOKEN: 'test', CLOUDFLARE_RECEIPT: 'pipeline:101:1',
    ...change.env,
  }
  withDesktopDispatch(env)
  const event = change.event ?? { workflow_run: deployRun }
  const redirectLocation = change.redirectLocation ?? 'https://productionresultssa0.blob.core.windows.net/artifacts/deploy-production-101-1.zip?sig=fixture'
  const logLocation = change.logLocation ?? 'https://pipelinesghubeus1.actions.githubusercontent.com/logs/9001.txt?sig=fixture'
  const overlayAssetLocation = 'https://release-assets.githubusercontent.com/assets/7777/mikka-ui-overlay.json?sig=fixture'
  const latestOverlayAsset = change.latestOverlay ? JSON.stringify({ overlaySha: change.latestOverlay }) : null
  const fetchImpl = async (url, options) => {
    const u = new URL(url)
    assert.equal(options.cache, 'no-store')
    if (u.origin === 'https://api.github.com') {
      assert.equal(options.headers.authorization, 'Bearer test')
      if (u.pathname === api + '/actions/artifacts/' + artifact.id + '/zip') {
        assert.equal(options.redirect, 'manual')
        if (change.directZip) return new Response(archive, { status: 200 })
        return new Response(null, { status: 302, headers: { location: redirectLocation } })
      }
      if (u.pathname === api + '/actions/jobs/9001/logs') {
        assert.equal(options.redirect, 'manual')
        return new Response(null, { status: 302, headers: { location: logLocation } })
      }
      if (u.pathname === api + '/releases/assets/7777') {
        assert.equal(options.redirect, 'manual')
        assert.equal(options.headers.accept, 'application/octet-stream')
        return new Response(null, { status: 302, headers: { location: overlayAssetLocation } })
      }
      assert.equal(options.redirect, 'error')
      if (u.pathname === api + '/actions/runs/101/attempts/1') return Response.json(deployRun)
      if (u.pathname === api + '/actions/runs/101/attempts/1/jobs') return Response.json(jobs)
      if (u.pathname === api + '/actions/runs/101/artifacts') return Response.json(change.artifactsPage ?? { total_count: 1, artifacts: [artifact] })
      if (u.pathname === api + '/actions/runs/55/attempts/2') return Response.json(consumerRun)
      if (u.pathname === api + '/git/ref/heads/main') return Response.json({ object: { type: 'commit', sha: change.main ?? deployRun.head_sha } })
      if (u.pathname === api + '/releases/latest') {
        if (change.latestStatus) return new Response('status ' + change.latestStatus, { status: change.latestStatus })
        const defaultLatest = {
          target_commitish: latestSha,
          ...(latestOverlayAsset ? { assets: [{ id: 7777, name: 'mikka-ui-overlay.json' }] } : {}),
        }
        return Response.json(change.latestRelease ?? defaultLatest)
      }
      if (u.pathname === api + '/compare/' + deployRun.head_sha + '...main') {
        return Response.json({ status: 'identical', merge_base_commit: { sha: deployRun.head_sha }, ...change.served })
      }
      if (u.pathname.startsWith(api + '/compare/')) {
        const [base, target] = u.pathname.slice((api + '/compare/').length).split('...')
        assert.equal(u.searchParams.get('per_page'), '1')
        const custom = change.compares?.[base + '...' + target]
        if (custom) return Response.json({ url: 'https://api.github.com/repos/aspectly-labs/Mikka/compare/' + base + '...' + target, base_commit: { sha: base }, ...custom })
        // By default: webSha/apiSha are ancestors of head, and NOT ancestors of latestSha (latestSha is older than head/webSha).
        if (target === deployRun.head_sha && (base === webSha || base === apiSha)) {
          return Response.json({ url: 'https://api.github.com/repos/aspectly-labs/Mikka/compare/' + base + '...' + target,
            base_commit: { sha: base }, merge_base_commit: { sha: base }, status: 'ahead', ahead_by: 2, behind_by: 0 })
        }
        if (target === latestSha && (base === webSha || base === apiSha || base === deployRun.head_sha)) {
          return Response.json({ url: 'https://api.github.com/repos/aspectly-labs/Mikka/compare/' + base + '...' + target,
            base_commit: { sha: base }, merge_base_commit: { sha: latestSha }, status: 'behind', ahead_by: 0, behind_by: 5 })
        }
        return Response.json({ url: 'https://api.github.com/repos/aspectly-labs/Mikka/compare/' + base + '...' + target,
          base_commit: { sha: base }, merge_base_commit: { sha: base }, status: 'ahead', ahead_by: 1, behind_by: 0,
          files: [{ filename: 'apps/desktop/src/main/index.ts' }] })
      }
      assert.fail('unexpected GitHub API path: ' + u.pathname)
    }
    assert.equal(options.headers.authorization, undefined)
    assert.equal(options.redirect, 'error')
    if (u.href === redirectLocation) return new Response(archive, { status: 200, headers: change.zipHeaders })
    if (u.href === logLocation) return new Response(prodLog, { status: 200 })
    if (u.href === overlayAssetLocation && latestOverlayAsset) return new Response(latestOverlayAsset, { status: 200 })
    assert.equal(u.origin, 'https://app.aspectlylabs.com')
    if (u.pathname === '/mikka/api/version') {
      if (change.versionFlakes > 0) {
        change.versionFlakes--
        change.versionReads = (change.versionReads ?? 0) + 1
        return Response.json({ error: 'deploymentVersionUnavailable' }, { headers: { 'cf-ray': 'edge' } })
      }
      change.versionReads = (change.versionReads ?? 0) + 1
      return Response.json({ build: webSha, overlaySha: overlay, apiBuild: apiSha, apiOverlaySha: overlay, ...change.version }, {
        headers: { 'cf-ray': 'edge', 'x-mikka-gateway-version-sha256': 'e'.repeat(64), ...change.headers },
      })
    }
    assert.equal(u.pathname, '/mikka/en/sign-in')
    return new Response(change.shell ?? '<script type="module" src="/mikka/assets/entry-123.js?dpl=' + releasePin + '"></script>')
  }
  return {
    head, owner, mergeQueue, desktop,
    trigger: consumer => promotionTrigger(consumer, { env: { ...env, CLOUDFLARE_RECEIPT: '' }, event, fetchImpl }),
    desktopVerify: () => verifyDesktopPromotedWeb({ env, event, fetchImpl, wait: change.wait }),
    runtimeVerify: () => verifyPromotedWeb({ env, event, fetchImpl }),
    observe: () => readServingPromotion('pipeline:101:1', { token: env.GITHUB_TOKEN, fetchImpl }),
  }
}

test('Desktop triggers and verifies automatic pipeline-production promotions while keeping runtime releases isolated', async () => {
  const f = pipelineFixture()
  assert.deepEqual(await f.trigger(f.desktop), {
    ready: true, receipt: 'pipeline:101:1', product: f.head,
    reason: 'Cloudflare serves ' + f.head + ' on main',
  })
  assert.deepEqual(await f.desktopVerify(), { product: f.head, releasePin, overlay })
  const observed = await f.observe()
  assert.equal(observed.product, f.head)
  assert.equal(observed.servedBuild, product)
  assert.equal(observed.overlay, overlay)

  // First release (404 on /releases/latest) is allowed, while transient 500 errors fail loudly instead of silently skipping.
  assert.equal((await pipelineFixture({ latestStatus: 404 }).trigger(f.desktop)).ready, true)
  assert.deepEqual(await pipelineFixture({ latestStatus: 404 }).desktopVerify(), { product: f.head, releasePin, overlay })
  await assert.rejects(pipelineFixture({ latestStatus: 500 }).trigger(f.desktop), /webDeploy:github:500/)
  await assert.rejects(pipelineFixture({ latestStatus: 500 }).desktopVerify(), /webDeploy:github:500/)

  // Manual owner dispatch on main with a pipeline receipt also succeeds; merge-queue cannot manually dispatch.
  const manual = pipelineFixture({
    env: { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    consumerRun: { event: 'workflow_dispatch', actor: { id: 183887963, login: 'alexj11324' }, triggering_actor: { id: 183887963, login: 'alexj11324' } },
  })
  assert.deepEqual(await manual.desktopVerify(), { product: f.head, releasePin, overlay })
  await assert.rejects(pipelineFixture({
    env: { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    consumerRun: { event: 'workflow_dispatch' },
  }).desktopVerify(), /dispatchActor/)

  // E2B runtime releases do not trigger or verify from automatic pipeline-production Web promotions.
  const runtimeTrigger = await f.trigger(workflow)
  assert.equal(runtimeTrigger.ready, false)
  assert.match(runtimeTrigger.reason, /not a successful Cloudflare deployment/)
  await assert.rejects(f.runtimeVerify(), /dispatch/)
})

test('automatic pipeline-production trigger handles change coverage, renames, overlay updates and downgrade protection', async () => {
  const head = 'b'.repeat(40), latestSha = 'a'.repeat(40)
  const coveredBase = {
    head, latestSha, latestOverlay: overlay,
    compares: {
      [product + '...' + latestSha]: { merge_base_commit: { sha: product }, status: 'ahead', ahead_by: 1, behind_by: 0 },
    },
  }
  const docsOnly = pipelineFixture({
    ...coveredBase,
    compares: {
      ...coveredBase.compares,
      [latestSha + '...' + head]: { merge_base_commit: { sha: latestSha }, status: 'ahead', ahead_by: 1, behind_by: 0, files: [{ filename: 'docs/README.md' }] },
    },
  })
  const skipped = await docsOnly.trigger(docsOnly.desktop)
  assert.deepEqual(skipped, { ready: false, reason: 'Desktop release ' + latestSha + ' already covers ' + head })

  // A file renamed OUT of a Desktop path into docs/ must still trigger a Desktop release.
  const renamedOut = pipelineFixture({
    ...coveredBase,
    compares: {
      ...coveredBase.compares,
      [latestSha + '...' + head]: { merge_base_commit: { sha: latestSha }, status: 'ahead', ahead_by: 1, behind_by: 0,
        files: [{ filename: 'docs/moved.ts', previous_filename: 'lib/moved.ts' }] },
    },
  })
  assert.equal((await renamedOut.trigger(renamedOut.desktop)).ready, true)

  // Overlay-only update on either the same commit or a docs-only descendant must NOT be skipped.
  const overlayOnlySameCommit = pipelineFixture({ head, latestSha: head, latestOverlay: '1'.repeat(40) })
  assert.equal((await overlayOnlySameCommit.trigger(overlayOnlySameCommit.desktop)).ready, true)
  const overlayOnlyDocsCommit = pipelineFixture({
    ...coveredBase, latestOverlay: '1'.repeat(40),
    compares: {
      ...coveredBase.compares,
      [latestSha + '...' + head]: { merge_base_commit: { sha: latestSha }, status: 'ahead', ahead_by: 1, behind_by: 0, files: [{ filename: 'docs/README.md' }] },
    },
  })
  assert.equal((await overlayOnlyDocsCommit.trigger(overlayOnlyDocsCommit.desktop)).ready, true)

  // Missing overlay metadata on releases/latest fails closed and does NOT skip a pipeline Desktop release.
  const missingOverlayDocsCommit = pipelineFixture({
    ...coveredBase, latestOverlay: null,
    compares: {
      ...coveredBase.compares,
      [latestSha + '...' + head]: { merge_base_commit: { sha: latestSha }, status: 'ahead', ahead_by: 1, behind_by: 0, files: [{ filename: 'docs/README.md' }] },
    },
  })
  assert.equal((await missingOverlayDocsCommit.trigger(missingOverlayDocsCommit.desktop)).ready, true)
  const missingOverlaySameCommit = pipelineFixture({ head, latestSha: head, latestOverlay: null })
  assert.equal((await missingOverlaySameCommit.trigger(missingOverlaySameCommit.desktop)).ready, true)

  // A late older run whose commit is strictly behind releases/latest is skipped on trigger AND rejected on verify (no downgrade).
  const lateOlderRun = pipelineFixture({
    ...coveredBase,
    compares: {
      ...coveredBase.compares,
      [latestSha + '...' + head]: { merge_base_commit: { sha: head }, status: 'behind', ahead_by: 0, behind_by: 2, files: [{ filename: 'apps/desktop/src/main/index.ts' }] },
      [head + '...' + latestSha]: { merge_base_commit: { sha: head }, status: 'ahead', ahead_by: 2, behind_by: 0 },
    },
  })
  assert.equal((await lateOlderRun.trigger(lateOlderRun.desktop)).ready, false)
  await assert.rejects(lateOlderRun.desktopVerify(), /staleRelease/)

  const desktopOnlyChange = pipelineFixture({
    ...coveredBase,
    compares: {
      ...coveredBase.compares,
      [latestSha + '...' + head]: { merge_base_commit: { sha: latestSha }, status: 'ahead', ahead_by: 1, behind_by: 0, files: [{ filename: 'apps/desktop/src/main/menu.ts' }] },
    },
  })
  assert.equal((await desktopOnlyChange.trigger(desktopOnlyChange.desktop)).ready, true)

  // Superseded pipeline-production runs (Promote step skipped) are quiet no-ops on trigger and fail closed on verify.
  const superseded = pipelineFixture({
    prodSteps: [
      { name: 'Promote and verify the staged service manifest', status: 'completed', conclusion: 'skipped' },
      { name: 'Upload production receipts', status: 'completed', conclusion: 'skipped' },
    ],
  })
  const supersededTrigger = await superseded.trigger(superseded.desktop)
  assert.equal(supersededTrigger.ready, false)
  assert.match(supersededTrigger.reason, /does not change what is served/)
  await assert.rejects(superseded.desktopVerify(), /pipelineJobs/)
})

test('pipeline-production verification rejects forged runs, artifacts, logs, summaries, acceptance, redirects and live mismatches', async () => {
  for (const [change, code] of [
    [{ deployRun: { actor: { id: 999, login: 'outsider' } } }, 'pipelineRun'],
    [{ deployRun: { actor: { id: 118344674, login: 'spoofed' } } }, 'pipelineRun'],
    [{ deployRun: { event: 'workflow_dispatch' } }, 'pipelineRun'],
    [{ deployRun: { conclusion: 'failure' } }, 'pipelineRun'],
    [{ jobs: { total_count: 1, jobs: [{ id: 9001, status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40), run_id: 101, run_attempt: 1, completed_at: iso(0), name: 'pipeline-production', steps: [{ name: 'Promote and verify the staged service manifest', status: 'completed', conclusion: 'success' }, { name: 'Upload production receipts', status: 'completed', conclusion: 'success' }] }] } }, 'pipelineJobs'],
    [{ artifact: { expired: true } }, 'pipelineArtifact'],
    [{ artifact: { digest: 'sha256:' + '0'.repeat(64) } }, 'pipelineArtifact'],
    [{ artifact: { workflow_run: { id: 101, head_sha: '0'.repeat(40), head_branch: 'main', repository_id: 1427517699, head_repository_id: 1427517699 } } }, 'pipelineArtifact'],
    [{ prodLog: 'unrelated log output without upload confirmation' }, 'pipelineArtifact'],
    [{ redirectLocation: 'http://productionresultssa0.blob.core.windows.net/archive.zip' }, 'pipelineArtifact'],
    [{ redirectLocation: 'https://evil.example/archive.zip' }, 'pipelineArtifact'],
    [{ redirectLocation: 'https://user:pass@productionresultssa0.blob.core.windows.net/archive.zip' }, 'pipelineArtifact'],
    [{ zipHeaders: { 'content-length': String(5 * 1024 * 1024) } }, 'pipelineArtifact'],
    [{ summary: { target: 'staging' } }, 'pipelineSummary'],
    [{ summary: { productionPromoted: false } }, 'pipelineSummary'],
    [{ summary: { status: 'failed' } }, 'pipelineSummary'],
    [{ summary: { verification: { status: 'fail' } } }, 'pipelineSummary'],
    [{ summary: { rollback: { status: 'passed' } } }, 'pipelineSummary'],
    [{ summary: { manifestSha256: '0'.repeat(64) } }, 'pipelineSummary'],
    [{ summary: { deployment: { runId: '102', runAttempt: '1' } } }, 'pipelineSummary'],
    [{ summary: { modelAcceptance: { status: 'failed', source: product, overlay } } }, 'pipelineAcceptance'],
    [{ summary: { modelAcceptance: { status: 'passed', source: '0'.repeat(40), overlay } } }, 'pipelineAcceptance'],
    [{ webService: { overlayCommit: '1'.repeat(40) } }, 'pipelineIdentity'],
    [{ webService: { release: '0000000-1-1' } }, 'pipelineIdentity'],
    [{ version: { build: '1'.repeat(40) } }, 'productionSource'],
    [{ version: { apiBuild: '1'.repeat(40) } }, 'productionSource'],
    [{ version: { apiOverlaySha: '1'.repeat(40) } }, 'productionSource'],
    [{ headers: { 'x-vercel-id': 'legacy' } }, 'gatewayVersion'],
    [{ headers: { 'x-mikka-gateway-version-sha256': 'not-a-hash' } }, 'gatewayVersion'],
    [{ shell: '<script src="/mikka/assets/entry.js?dpl=wrong"></script>' }, 'servedClientPin'],
    [{ event: { workflow_run: { id: 102, run_attempt: 1, path: '.github/workflows/cloudflare-app-deploy.yml' } } }, 'dispatchSource'],
    [{ served: { status: 'diverged' } }, 'servedOnMain'],
  ]) {
    await assert.rejects(pipelineFixture(change).desktopVerify(), new RegExp(code), code)
  }
})


test('a paused production keeps Desktop manual: an owner pipeline-promote dispatch never starts Desktop by itself', async () => {
  const owner = { id: 183887963, login: 'alexj11324' }
  const gate = { status: 'completed', head_sha: 'b'.repeat(40), run_id: 101, run_attempt: 1, completed_at: iso(0) }
  const manualJobs = stage => ({ total_count: 2, jobs: [
    { ...gate, id: 9000, name: 'pipeline', conclusion: stage },
    { ...gate, id: 9001, name: 'pipeline-production', conclusion: 'success', steps: [
      { name: 'Promote and verify the staged service manifest', status: 'completed', conclusion: 'success' },
      { name: 'Upload production receipts', status: 'completed', conclusion: 'success' }] }] })
  const promoted = { deployRun: { event: 'workflow_dispatch', actor: owner, triggering_actor: owner }, jobs: manualJobs('skipped') }
  const byHand = { env: { GITHUB_EVENT_NAME: 'workflow_dispatch' }, consumerRun: { event: 'workflow_dispatch', actor: owner, triggering_actor: owner } }

  // The finished manual promotion does not trigger a Desktop release.
  const trigger = await pipelineFixture(promoted).trigger('.github/workflows/desktop-release.yml')
  assert.equal(trigger.ready, false)
  assert.match(trigger.reason, /explicit desktop-release\.yml dispatch/)
  // A chained (workflow_run) Desktop and the read-only witness both refuse the manual receipt.
  await assert.rejects(pipelineFixture(promoted).desktopVerify(), /pipelineRun/)
  await assert.rejects(pipelineFixture(promoted).observe(), /pipelineRun/)
  // The owner's own Desktop dispatch with that receipt is the release path.
  assert.deepEqual(await pipelineFixture({ ...promoted, ...byHand }).desktopVerify(), { product: 'b'.repeat(40), releasePin, overlay })
  // Only the owner's own promotion counts, and it must not have staged in the same run.
  for (const [change, code] of [
    [{ deployRun: { ...promoted.deployRun, actor: { id: 118344674, login: 'github-merge-queue[bot]' } } }, 'pipelineRun'],
    [{ deployRun: { ...promoted.deployRun, triggering_actor: { id: 7, login: 'outsider' } } }, 'pipelineRun'],
    [{ jobs: manualJobs('success') }, 'pipelineJobs'],
  ]) await assert.rejects(pipelineFixture({ ...promoted, ...byHand, ...change }).desktopVerify(), new RegExp(code), code)
})

test('the production version endpoint is retried with backoff only while it reports itself unavailable', async () => {
  const version = { build: 'a'.repeat(40), overlaySha: 'b'.repeat(40) }
  const responses = script => async url => {
    assert.equal(new URL(url).pathname, '/mikka/api/version')
    const next = script.shift()
    if (next === 503) return new Response('busy', { status: 503 })
    return Response.json(next, { headers: { 'cf-ray': 'edge' } })
  }
  const waits = []
  const wait = async ms => { waits.push(ms) }
  const unavailable = { error: 'deploymentVersionUnavailable' }
  // Two transient answers (the 2026-11-27 flake and a non-200), then the real version: backoff 2s, 4s.
  const read = await readProductionVersion(responses([unavailable, 503, version]), { wait })
  assert.deepEqual(read.body, version)
  assert.deepEqual(waits, [2000, 4000])
  // Persistent unavailability fails closed after four reads (2s, 4s, 8s).
  waits.length = 0
  await assert.rejects(readProductionVersion(responses([unavailable, unavailable, unavailable, unavailable, version]), { wait }), /productionSource/)
  assert.deepEqual(waits, [2000, 4000, 8000])
  waits.length = 0
  await assert.rejects(readProductionVersion(responses([503, 503, 503, 503]), { wait }), /publicUnavailable/)
  assert.equal(waits.length, 3)
  // With the live fetch, publicRead's own 503 retries would make each attempt up to three requests;
  // the version read skips them, so four attempts are four requests in total.
  const live = globalThis.fetch
  let requests = 0
  globalThis.fetch = async url => { requests++; assert.equal(new URL(url).pathname, '/mikka/api/version'); return new Response('busy', { status: 503 }) }
  try {
    waits.length = 0
    await assert.rejects(readProductionVersion(undefined, { wait }), /publicUnavailable/)
    assert.equal(requests, 4)
    assert.deepEqual(waits, [2000, 4000, 8000])
  } finally { globalThis.fetch = live }
  // An answer that names a build is final: no retry, so a real mismatch is reported at once.
  waits.length = 0
  assert.deepEqual((await readProductionVersion(responses([{ ...version, build: 'c'.repeat(40) }]), { wait })).body.build, 'c'.repeat(40))
  assert.deepEqual(waits, [])

  // End to end: a Desktop dispatch rides out the flake, while a mismatched build still fails without waiting.
  const owner = { id: 183887963, login: 'alexj11324' }
  const byHand = { env: { GITHUB_EVENT_NAME: 'workflow_dispatch' }, consumerRun: { event: 'workflow_dispatch', actor: owner, triggering_actor: owner } }
  const flaky = { ...byHand, versionFlakes: 2, wait }
  waits.length = 0
  assert.deepEqual(await pipelineFixture(flaky).desktopVerify(), { product: 'b'.repeat(40), releasePin, overlay })
  assert.ok(waits.length >= 2)
  waits.length = 0
  await assert.rejects(pipelineFixture({ ...byHand, wait, version: { build: '1'.repeat(40) } }).desktopVerify(), /productionSource/)
  assert.deepEqual(waits, [])
})

test('a hand-dispatched Desktop accepts any listed promoter on evidence, and nobody else', async () => {
  const devin = { id: 158243242, login: 'devin-ai-integration[bot]' }, outsider = { id: 7, login: 'outsider' }
  const gate = { status: 'completed', head_sha: 'b'.repeat(40), run_id: 101, run_attempt: 1, completed_at: iso(0) }
  const jobs = { total_count: 2, jobs: [{ ...gate, id: 9000, name: 'pipeline', conclusion: 'skipped' },
    { ...gate, id: 9001, name: 'pipeline-production', conclusion: 'success', steps: [
      { name: 'Promote and verify the staged service manifest', status: 'completed', conclusion: 'success' },
      { name: 'Upload production receipts', status: 'completed', conclusion: 'success' }] }] }
  const by = (promoter, consumer = promoter, env = {}) => ({ jobs,
    deployRun: { event: 'workflow_dispatch', actor: promoter, triggering_actor: promoter },
    env: { GITHUB_EVENT_NAME: 'workflow_dispatch', ...env },
    consumerRun: { event: 'workflow_dispatch', actor: consumer, triggering_actor: consumer } })
  // An agent promoted production and an agent releases Desktop: both are on the list.
  assert.deepEqual(await pipelineFixture(by(devin)).desktopVerify(), { product: 'b'.repeat(40), releasePin, overlay })
  for (const [change, code] of [
    [by(devin, outsider), 'dispatchActor'],
    [{ ...by(devin), consumerRun: { event: 'workflow_dispatch', actor: devin, triggering_actor: outsider } }, 'dispatchActor'],
    [{ ...by(devin), consumerRun: { event: 'workflow_dispatch', actor: { id: devin.id, login: 'renamed' }, triggering_actor: devin } }, 'dispatchActor'],
    [by(outsider, devin), 'pipelineRun'],
    [{ ...by(devin), deployRun: { event: 'workflow_dispatch', actor: devin, triggering_actor: outsider } }, 'pipelineRun'],
    [by(devin, devin, { MIKKA_RELEASE_POLICY: null }), 'dispatchActor'],
    [by(devin, devin, { MIKKA_RELEASE_POLICY: JSON.stringify({ promoters: [], requiredChecks: [] }) }), 'dispatchActor'],
    [by(devin, devin, { MIKKA_RELEASE_POLICY: '{nope' }), 'dispatchActor'],
    // A dispatch from a branch, or an edited workflow file, cannot skip the gates.
    [by(devin, devin, { GITHUB_WORKFLOW_REF: 'aspectly-labs/Mikka/.github/workflows/desktop-release.yml@refs/heads/feature' }), 'runIdentity'],
    [by(devin, devin, { GITHUB_WORKFLOW_SHA: 'c'.repeat(40) }), 'runIdentity'],
    [by(devin, devin, { GITHUB_REF: 'refs/heads/feature' }), 'dispatch'],
  ]) await assert.rejects(pipelineFixture(change).desktopVerify(), new RegExp(code), JSON.stringify(change.env ?? change.consumerRun))
})
