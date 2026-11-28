import { appendFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { actionsMikkaRepository, officialMikkaRepository, publicRepositoryId } from '../cloudflare-source.mjs'
import { isValidDeploymentId } from '../../lib/deployment-id.mjs'
import { artifactFor, readArtifactMembers } from './pipeline-inputs.mjs'
import { isPromoter } from './release-policy.mjs'
import { setTimeout as sleep } from 'node:timers/promises'
import { containsDesktopSource, githubRead, PRODUCTION_VERSION_URL } from './web-deploy.mjs'
import { isPipelineProductionPromoted } from './production-promotion.mjs'

const ownerId = 183887963
const mergeQueueId = 118344674
const mergeQueueLogin = 'github-merge-queue[bot]'
const isOwnerActor = actor => actor?.id === ownerId
const isPipelineActor = actor => isOwnerActor(actor)
  || (actor?.id === mergeQueueId && actor?.login === mergeQueueLogin)
const ownerIssue = /^https:\/\/api\.github\.com\/repos\/(alexj11324|aspectly-labs)\/Mikka\/issues\/1954$/
const officialRepository = row => officialMikkaRepository(row?.full_name, String(row?.id),
  row?.owner?.id === undefined ? undefined : String(row.owner.id))
const runtimeWorkflow = '.github/workflows/e2b-official-runtime.yml'
const desktopWorkflow = '.github/workflows/desktop-release.yml'
const deploymentWorkflow = '.github/workflows/cloudflare-app-deploy.yml'
const anchorName = '_mikka-release.aspectlylabs.com'
const anchorUrl = 'https://cloudflare-dns.com/dns-query?name=' + anchorName + '&type=TXT'
const receiptFields = ['schema', 'approvalComment', 'approvalSha256', 'product', 'overlay', 'releasePin',
  'gatewayVersionSha256', 'inventorySha256', 'verifiedAt', 'outcome']
const desktopPathPrefixes = ['apps/desktop/', 'apps/frontend/', 'app/[locale]/', 'app/actions/', 'lib/', 'messages/',
  'i18n/', 'public/', 'packages/config/', 'packages/daemon/', 'packages/protocol/', 'patches/', 'scripts/release/']
const desktopExactPaths = new Set(['instrumentation-client.ts', 'postcss.config.mjs', 'tsconfig.json',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'config/release-security.json',
  '.github/workflows/desktop-release.yml'])
const isDesktopRelevantPath = filename => typeof filename === 'string'
  && (desktopExactPaths.has(filename) || desktopPathPrefixes.some(prefix => filename.startsWith(prefix)))
const sha = /^[0-9a-f]{40}$/
const hash = /^[0-9a-f]{64}$/
const decimal = /^[1-9][0-9]*$/
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex')
const present = (value, pattern) => typeof value === 'string' && pattern.test(value)
const requireProof = (ok, code) => { if (!ok) throw Error('cloudflareWeb:' + code) }

async function readOwnerBody(id, bodyHash, prefix, api) {
  const row = await githubRead('/issues/comments/' + id, api)
  const owner = ownerIssue.exec(row.issue_url ?? '')?.[1]
  requireProof(String(row.id) === id && owner && row.user?.id === ownerId
    && row.user.login === 'alexj11324' && (row.author_association === 'OWNER'
      || owner === 'aspectly-labs' && row.author_association === 'MEMBER'), 'ownerComment')
  requireProof(typeof row.body === 'string' && digest(row.body) === bodyHash && row.body.startsWith(prefix), 'commentChanged')
  return row.body.slice(prefix.length)
}

export function parsePromotionRecord(raw) {
  const record = JSON.parse(raw)
  requireProof(record && Object.keys(record).join('|') === receiptFields.join('|') && JSON.stringify(record) === raw
    && record.schema === 'mikka.cloudflare-promotion.v1' && record.outcome === 'promoted', 'receiptShape')
  requireProof(present(record.approvalComment, decimal) && [record.product, record.overlay].every(v => present(v, sha))
    && [record.gatewayVersionSha256, record.inventorySha256, record.approvalSha256].every(v => present(v, hash)), 'receiptIdentity')
  requireProof(isValidDeploymentId(record.releasePin) && /^[0-9a-f]{7,12}-[1-9][0-9]*-[1-9][0-9]*$/.test(record.releasePin)
    && record.product.startsWith(record.releasePin.split('-')[0]), 'clientPin')
  const verified = Date.parse(record.verifiedAt)
  requireProof(Number.isFinite(verified) && new Date(verified).toISOString() === record.verifiedAt, 'verificationTime')
  return record
}

// A live read rides out up to two immediate 503s; a caller with its own backoff loop passes 0 so
// its attempt count is the total number of requests.
async function publicRead(url, accept, fetchImpl, retries = fetchImpl === fetch ? 2 : 0) {
  const init = () => ({ redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: { accept, 'cache-control': 'no-cache' } })
  let response = await fetchImpl(url, init())
  for (let retry = 0; retry < retries && response.status === 503; retry++) {
    await response.body?.cancel()
    response = await fetchImpl(url, init())
  }
  if (response.status !== 200) {
    await response.body?.cancel()
    throw Error('cloudflareWeb:publicUnavailable')
  }
  return response
}

async function readBoundedBytes(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw Error('cloudflareWeb:pipelineArtifact')
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer())
    requireProof(bytes.length <= maxBytes, 'pipelineArtifact')
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw Error('cloudflareWeb:pipelineArtifact')
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function githubReadBytes(path, { token, fetchImpl, accept = 'application/vnd.github+json', maxBytes = 4 * 1024 * 1024, timeoutMs = 60_000 }) {
  if (!token) throw Error('webDeploy:githubTokenRequired')
  const url = `https://api.github.com/repositories/${publicRepositoryId}${path}`
  let response
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))), redirect: 'manual', cache: 'no-store',
    })
  } catch (cause) { throw Error('webDeploy:githubUnavailable', { cause }) }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    await response.body?.cancel()
    let target
    try { target = new URL(location ?? '') } catch (cause) { throw Error('cloudflareWeb:pipelineArtifact', { cause }) }
    requireProof(target.protocol === 'https:' && !target.username && !target.password
      && (target.hostname.endsWith('.blob.core.windows.net') || target.hostname.endsWith('.githubusercontent.com')), 'pipelineArtifact')
    try {
      response = await fetchImpl(target.href, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))), redirect: 'error', cache: 'no-store',
      })
    } catch (cause) { throw Error('webDeploy:githubUnavailable', { cause }) }
  }
  if (!response.ok) { await response.body?.cancel(); throw Error(`webDeploy:github:${response.status}`) }
  return readBoundedBytes(response, maxBytes)
}

async function readLatestRelease(api) {
  try { return await githubRead('/releases/latest', api) }
  catch (error) {
    if (error?.message === 'webDeploy:github:404') return null
    throw error
  }
}

async function latestReleaseOverlay(latest, api) {
  const asset = Array.isArray(latest?.assets) ? latest.assets.find(item => item?.name === 'mikka-ui-overlay.json') : null
  if (!asset || !present(String(asset.id ?? ''), decimal)) return null
  const bytes = await githubReadBytes('/releases/assets/' + asset.id, { ...api, accept: 'application/octet-stream', maxBytes: 4096 })
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { return null }
  return present(parsed?.overlaySha, sha) ? parsed.overlaySha : null
}

// The original publisher may use its Vercel credentials only while the public app
// and release DNS agree it is still the active origin. An incomplete cutover fails closed.
export async function readWebAuthority(fetchImpl = fetch) {
  const [dns, version] = await Promise.all([
    publicRead(anchorUrl, 'application/dns-json', fetchImpl).then(response => response.json()),
    publicRead(PRODUCTION_VERSION_URL, 'application/json', fetchImpl),
  ])
  const answers = dns.Answer ?? []
  const name = value => value?.replace(/\.$/, '').toLowerCase()
  requireProof(!dns.TC && Array.isArray(answers) && dns.Question?.length === 1
    && name(dns.Question[0].name) === anchorName && dns.Question[0].type === 16, 'dnsAuthority')
  const { build } = await version.json()
  requireProof(present(build, sha), 'productionSource')
  const gateway = version.headers.get('x-mikka-gateway-version-sha256')
  if ([0, 3].includes(dns.Status) && answers.length === 0 && version.headers.get('x-vercel-id') && !gateway) {
    return { provider: 'vercel', sha: build }
  }
  const absent = [0, 3].includes(dns.Status) && answers.length === 0
  const historical = dns.Status === 0 && answers.length === 1 && name(answers[0].name) === anchorName
    && answers[0].type === 16 && /^"mikka-release-v1=sha256:[a-f0-9]{64}"$/.test(answers[0].data)
  requireProof((absent || historical) && !version.headers.has('x-vercel-id')
    && version.headers.has('cf-ray') && present(gateway, hash), 'originUnconfirmed')
  return { provider: 'cloudflare', sha: build }
}

async function liveProof(record, raw, fetchImpl, options) {
  const [dns] = await Promise.all([
    publicRead(anchorUrl, 'application/dns-json', fetchImpl).then(r => r.json()),
    liveServingRelease(record, fetchImpl, options),
  ])
  const answers = dns.Answer
  requireProof(dns.Status === 0 && !dns.TC && Array.isArray(answers) && answers.length === 1 && answers[0].type === 16
    && answers[0].name?.replace(/\.$/, '').toLowerCase() === anchorName
    && answers[0].data === '"mikka-release-v1=sha256:' + digest(raw) + '"', 'dnsAnchor')
}

/** Production's version endpoint occasionally answers `{"error":"deploymentVersionUnavailable"}` or a
 * transient non-200 for a few seconds (seen 2026-11-27). Retry only that unavailability, with exponential
 * backoff; an answer that names a build is final, so a real mismatch still fails at once. */
export async function readProductionVersion(fetchImpl = fetch, { wait = sleep, attempts = 4, baseMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let failure
    try {
      // No inner 503 retry: this loop alone bounds the reads at `attempts` requests.
      const response = await publicRead(PRODUCTION_VERSION_URL, 'application/json', fetchImpl, 0)
      let body
      try { body = await response.json() } catch { body = null }
      if (present(body?.build, sha)) return { headers: response.headers, body }
      failure = Error('cloudflareWeb:productionSource')
    } catch (error) {
      if (error?.message !== 'cloudflareWeb:publicUnavailable') throw error
      failure = error
    }
    if (attempt >= attempts) throw failure
    await wait(baseMs * 2 ** (attempt - 1))
  }
}

async function liveServingRelease(record, fetchImpl, { wait = sleep } = {}) {
  const [version, shell] = await Promise.all([
    readProductionVersion(fetchImpl, { wait }),
    publicRead(new URL('/mikka/en/sign-in', PRODUCTION_VERSION_URL).href, 'text/html', fetchImpl),
  ])
  const gateway = version.headers.get('x-mikka-gateway-version-sha256')
  requireProof(!version.headers.has('x-vercel-id') && version.headers.has('cf-ray')
    && (record.gatewayVersionSha256 ? gateway === record.gatewayVersionSha256 : present(gateway, hash)), 'gatewayVersion')
  const body = version.body
  const expectedBuild = record.servedBuild ?? record.product
  requireProof(body.build === expectedBuild && body.overlaySha === record.overlay
    && (!record.apiBuild || body.apiBuild === record.apiBuild)
    && (!record.apiOverlay || body.apiOverlaySha === record.apiOverlay), 'productionSource')
  const script = (await shell.text()).match(/<script[^>]*\bsrc=["'](\/mikka\/assets\/[^"']+)["']/i)
  const url = script && new URL(script[1].replaceAll('&amp;', '&'), PRODUCTION_VERSION_URL)
  requireProof(url && /^\/mikka\/assets\/[A-Za-z0-9_.-]+\.js$/.test(url.pathname)
    && url.searchParams.getAll('dpl').length === 1 && url.searchParams.get('dpl') === record.releasePin, 'servedClientPin')
}

// The protected gateway observer publishes four non-secret identifiers in a
// terminal job name. GitHub scopes job metadata to the exact original attempt.
const observationRef = /^actions:([1-9][0-9]{0,15}):([1-9][0-9]{0,15})$/
async function servingObservation(ref, api) {
  const [, runId, attempt] = ref
  const path = '/actions/runs/' + runId + '/attempts/' + attempt
  const [run, listing] = await Promise.all([githubRead(path, api), githubRead(path + '/jobs?per_page=100', api)])
  requireProof([run.repository, run.head_repository].every(r => officialRepository(r) && r.fork === false)
    && run.path === '.github/workflows/cloudflare-app-deploy.yml' && run.head_branch === 'main' && present(run.head_sha, sha)
    && run.event === 'workflow_dispatch' && run.status === 'completed' && run.conclusion === 'success'
    && run.actor?.id === ownerId && run.triggering_actor?.id === ownerId
    && String(run.id) === runId && String(run.run_attempt) === attempt, 'observationRun')
  requireProof(Array.isArray(listing.jobs) && listing.total_count === listing.jobs.length, 'observationJobs')
  const completed = job => job.status === 'completed' && job.conclusion === 'success' && job.head_sha === run.head_sha
    && String(job.run_id) === runId && String(job.run_attempt) === attempt
  const jobs = listing.jobs.filter(job => job.name?.startsWith('Serving release '))
  const drivers = listing.jobs.filter(job => job.name === 'deploy-application')
  requireProof(jobs.length === 1 && drivers.length === 1 && completed(jobs[0]) && completed(drivers[0]), 'observationJobs')
  const fields = /^Serving release ([a-f0-9]{40}) ([a-f0-9]{40}) ([a-f0-9]{7,12}-[1-9][0-9]*-[1-9][0-9]*) ([a-f0-9]{64})$/.exec(jobs[0].name)
  requireProof(fields && fields[1].startsWith(fields[3].split('-')[0]) && isValidDeploymentId(fields[3]), 'observationIdentity')
  requireProof(Number.isFinite(Date.parse(jobs[0].completed_at)), 'observationTime')
  return { product: fields[1], overlay: fields[2], releasePin: fields[3], gatewayVersionSha256: fields[4], verifiedAt: jobs[0].completed_at }
}

// pipeline-production promotions upload an immutable receipt archive bound to the exact run
// attempt, manifest digest, served Web/API builds and funded acceptance. An automatic promotion
// (workflow_run) may start a Desktop release by itself; an owner's manual pipeline-promote
// dispatch, used while automatic promotion is paused, is accepted only by a Desktop release the
// owner dispatches by hand with that receipt (`manual`).
const pipelineRef = /^pipeline:([1-9][0-9]{0,15}):([1-9][0-9]{0,15})$/

/** The release policy projection the workflow read from private main (release-policy.mjs read desktop). */
function releasePromoters(env) {
  let projection
  try { projection = JSON.parse(env.MIKKA_RELEASE_POLICY ?? '') } catch { return null }
  const promoters = projection?.promoters
  if (!Array.isArray(promoters) || !promoters.length
    || !promoters.every(entry => Number.isSafeInteger(entry?.id) && entry.id > 0 && typeof entry.login === 'string' && entry.login)) return null
  return { promoters }
}

async function pipelineObservation(ref, api, { manual = false, policy = null } = {}) {
  const [, runId, attempt] = ref
  const path = '/actions/runs/' + runId + '/attempts/' + attempt
  const [run, listing, artifactsPage] = await Promise.all([
    githubRead(path, api),
    githubRead(path + '/jobs?per_page=100', api),
    githubRead('/actions/runs/' + runId + '/artifacts?per_page=100', api),
  ])
  requireProof([run.repository, run.head_repository].every(r => officialRepository(r) && r.fork === false)
    && run.path === deploymentWorkflow && run.head_branch === 'main' && present(run.head_sha, sha)
    && run.status === 'completed' && run.conclusion === 'success'
    && (run.event === 'workflow_run' ? isPipelineActor(run.actor) && isPipelineActor(run.triggering_actor)
      : manual && policy && run.event === 'workflow_dispatch' && isPromoter(policy, run.actor) && isPromoter(policy, run.triggering_actor))
    && String(run.id) === runId && String(run.run_attempt) === attempt, 'pipelineRun')
  const dispatched = run.event === 'workflow_dispatch'
  requireProof(Array.isArray(listing.jobs) && listing.total_count === listing.jobs.length, 'pipelineJobs')
  const completed = job => job.status === 'completed' && job.conclusion === 'success' && job.head_sha === run.head_sha
    && String(job.run_id) === runId && String(job.run_attempt) === attempt
  const prodJobs = listing.jobs.filter(job => job.name === 'pipeline-production')
  const stageJobs = listing.jobs.filter(job => job.name === 'pipeline')
  // A manual promotion stages nothing itself: it promotes an earlier, separately verified staging run.
  requireProof(prodJobs.length === 1 && stageJobs.length === 1 && completed(prodJobs[0])
    && (dispatched ? stageJobs[0].conclusion === 'skipped' : completed(stageJobs[0]))
    && isPipelineProductionPromoted(prodJobs[0]) && present(String(prodJobs[0].id ?? ''), decimal), 'pipelineJobs')
  requireProof(Number.isFinite(Date.parse(prodJobs[0].completed_at)), 'pipelineTime')
  requireProof(Array.isArray(artifactsPage.artifacts) && Number.isSafeInteger(artifactsPage.total_count), 'pipelineArtifact')
  const artifacts = [...artifactsPage.artifacts]
  for (let page = 2; artifacts.length < artifactsPage.total_count && page <= 10; page++) {
    const next = await githubRead('/actions/runs/' + runId + '/artifacts?per_page=100&page=' + page, api)
    requireProof(Array.isArray(next.artifacts) && next.artifacts.length > 0, 'pipelineArtifact')
    artifacts.push(...next.artifacts)
  }
  requireProof(artifacts.length === artifactsPage.total_count, 'pipelineArtifact')
  let artifact, files
  try { artifact = artifactFor(run, artifacts, 'deploy-production') }
  catch (cause) { throw Error('cloudflareWeb:pipelineArtifact', { cause }) }
  const [bytes, logBytes] = await Promise.all([
    githubReadBytes('/actions/artifacts/' + artifact.id + '/zip', { ...api, maxBytes: 4 * 1024 * 1024 }),
    githubReadBytes('/actions/jobs/' + prodJobs[0].id + '/logs', { ...api, maxBytes: 16 * 1024 * 1024 }),
  ])
  const log = logBytes.toString('utf8')
  requireProof(log.includes('Artifact ' + artifact.name + '.zip successfully finalized.')
    && log.includes('Artifact ID ' + artifact.id), 'pipelineArtifact')
  try { files = readArtifactMembers(bytes, artifact) }
  catch (cause) { throw Error('cloudflareWeb:pipelineArtifact', { cause }) }
  const summary = files['pipeline-summary.json']
  const manifest = files['release-manifest.json']
  requireProof(summary && typeof summary === 'object' && !Array.isArray(summary)
    && manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'pipelineArtifact')
  requireProof(summary.version === 1 && summary.target === 'production' && summary.status === 'passed'
    && summary.productionPromoted === true && summary.verification?.status === 'pass'
    && summary.rollback === undefined && summary.admission === undefined
    && summary.deployment?.runId === runId && summary.deployment?.runAttempt === attempt
    && summary.manifestSha256 === digest(JSON.stringify(manifest)), 'pipelineSummary')
  const web = manifest.services?.web, apiService = manifest.services?.api
  // An automatic run promotes the main push that triggered it; a manual dispatch runs on a later main and
  // names its source, which must still be part of that main.
  requireProof(manifest.version === 1 && present(summary.sourceCommit, sha)
    && summary.sourceCommit === manifest.sourceCommit && (dispatched || summary.sourceCommit === run.head_sha)
    && present(manifest.overlayCommit, sha) && web && apiService
    && present(web.sourceCommit, sha) && present(web.overlayCommit, sha) && web.overlayCommit === manifest.overlayCommit
    && present(apiService.sourceCommit, sha) && present(apiService.overlayCommit, sha) && apiService.overlayCommit === manifest.overlayCommit
    && isValidDeploymentId(web.release) && /^[0-9a-f]{7,12}-[1-9][0-9]*-[1-9][0-9]*$/.test(web.release)
    && web.sourceCommit.startsWith(web.release.split('-')[0]), 'pipelineIdentity')
  requireProof(summary.modelAcceptance?.status === 'passed'
    && summary.modelAcceptance?.source === web.sourceCommit
    && summary.modelAcceptance?.overlay === web.overlayCommit, 'pipelineAcceptance')
  requireProof(await containsDesktopSource({ ...api, expectedBuild: web.sourceCommit, publicCommit: manifest.sourceCommit })
    && await containsDesktopSource({ ...api, expectedBuild: apiService.sourceCommit, publicCommit: manifest.sourceCommit }), 'pipelineIdentity')
  return {
    product: manifest.sourceCommit,
    servedBuild: web.sourceCommit,
    apiBuild: apiService.sourceCommit,
    overlay: web.overlayCommit,
    apiOverlay: apiService.overlayCommit,
    releasePin: web.release,
    gatewayVersionSha256: null,
    verifiedAt: prodJobs[0].completed_at,
  }
}

/** Re-read the original release decision at its issuance and the currently
 * served gateway, shell and DNS. This read-only check grants no release rights. */
export async function readServingPromotion(pin, {token, fetchImpl=fetch, now=Date.now(), wait=sleep}={}) {
  const observed = observationRef.exec(pin)
  if (observed) {
    const record = await servingObservation(observed, { token, fetchImpl })
    await liveServingRelease(record, fetchImpl, { wait })
    return record
  }
  const piped = pipelineRef.exec(pin)
  if (piped) {
    const record = await pipelineObservation(piped, { token, fetchImpl })
    await liveServingRelease(record, fetchImpl, { wait })
    return record
  }
  const match=/^([1-9][0-9]{0,15})-([a-f0-9]{64})$/.exec(pin)
  requireProof(match,'ownerComment')
  const api={token,fetchImpl}
  const raw=await readOwnerBody(match[1],match[2],'MIKKA_CLOUDFLARE_WEB_PROMOTION_V1\n',api)
  const record=parsePromotionRecord(raw)
  const approvalBody=await readOwnerBody(record.approvalComment,record.approvalSha256,'MIKKA_CUTOVER_ACCEPTANCE_V1',api)
  requireProof(/^\r?\n/.test(approvalBody),'approvalMarker')
  const approval=JSON.parse(approvalBody),issued=Date.parse(record.verifiedAt)
  requireProof(record.approvalComment!==match[1] && approval.decision==='approved' && approval.product===record.product &&
    approval.overlay===record.overlay && approval.evidence?.inventoryAndRollback?.sha256===record.inventorySha256 &&
    /^https:\/\/github\.com\/alexj11324\/mikka-cloud\/issues\/4#issuecomment-[1-9][0-9]*$/.test(approval.evidence.inventoryAndRollback.url) &&
    Date.parse(approval.from)<=issued && issued<Date.parse(approval.until) && issued<=now,'approval')
  await liveProof(record,raw,fetchImpl,{wait})
  return record
}

export function verifyPromotedWeb(options) {
  return verifyPromotion(runtimeWorkflow, options)
}

export function verifyDesktopPromotedWeb(options) {
  return verifyPromotion(desktopWorkflow, options)
}

async function verifyPromotion(workflow, { env = process.env, event, fetchImpl = fetch, now = Date.now, wait = sleep } = {}) {
  const pin = /^([1-9][0-9]*)-([a-f0-9]{64})$/.exec(env.CLOUDFLARE_RECEIPT ?? '')
  const observed = observationRef.exec(env.CLOUDFLARE_RECEIPT ?? '')
  const piped = workflow === desktopWorkflow ? pipelineRef.exec(env.CLOUDFLARE_RECEIPT ?? '') : null
  const automated = observed || piped
  // A consumer started by the observation itself (workflow_run) may only use that
  // exact observation; a historical owner receipt still needs a manual dispatch.
  const chained = env.GITHUB_EVENT_NAME === 'workflow_run'
  requireProof((pin || automated) && actionsMikkaRepository(env) && env.GITHUB_REF === 'refs/heads/main'
    && (env.GITHUB_EVENT_NAME === 'workflow_dispatch' || chained && automated) && present(env.GITHUB_SHA, sha)
    && present(env.GITHUB_RUN_ID, decimal) && present(env.GITHUB_RUN_ATTEMPT, decimal), 'dispatch')
  // Desktop starts by itself only after an automatic pipeline-production promotion. A gateway
  // observation (a manual production action) never chains Desktop; a listed promoter dispatches it.
  requireProof(!(workflow === desktopWorkflow && chained && observed), 'dispatchSource')
  // A hand-dispatched Desktop is admitted on evidence for any listed promoter (release policy
  // `promoters`), never for anyone else, and only from main's own workflow file at the dispatched commit.
  const desktopDispatch = workflow === desktopWorkflow && !chained
  const policy = desktopDispatch ? releasePromoters(env) : null
  if (desktopDispatch) {
    requireProof(policy, 'dispatchActor')
    requireProof(env.GITHUB_WORKFLOW_REF === env.GITHUB_REPOSITORY + '/' + desktopWorkflow + '@refs/heads/main'
      && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA, 'runIdentity')
  }
  if (chained) {
    const source = (event ?? await readEvent(env)).workflow_run
    requireProof(String(source?.id) === automated[1] && String(source?.run_attempt) === automated[2]
      && source.path === deploymentWorkflow, 'dispatchSource')
  }
  const api = { token: env.GITHUB_TOKEN, fetchImpl }
  let record, raw, until, approval
  if (observed) {
    record = await servingObservation(observed, api)
  } else if (piped) {
    record = await pipelineObservation(piped, api, { manual: !chained, policy })
  } else {
    raw = await readOwnerBody(pin[1], pin[2], 'MIKKA_CLOUDFLARE_WEB_PROMOTION_V1\n', api)
    record = parsePromotionRecord(raw)
    requireProof(record.approvalComment !== pin[1], 'dispatchSource')
  }
  // The runtime release publishes the worker of the commit Cloudflare serves. A
  // dispatch on a later main builds that served commit (MIKKA_RUNTIME_SOURCE once
  // chosen); it never builds HEAD in its place.
  const runtimeSource = env.MIKKA_RUNTIME_SOURCE || record.product
  requireProof(workflow === desktopWorkflow ? true : record.product === runtimeSource
    && (record.product === env.GITHUB_SHA || !chained), 'dispatchSource')
  const run = await githubRead('/actions/runs/' + env.GITHUB_RUN_ID + '/attempts/' + env.GITHUB_RUN_ATTEMPT, api)
  requireProof(officialRepository(run.repository) === env.GITHUB_REPOSITORY && run.event === (chained ? 'workflow_run' : 'workflow_dispatch') && run.path === workflow
    && run.head_sha === env.GITHUB_SHA && run.head_branch === 'main' && String(run.id) === env.GITHUB_RUN_ID
    && String(run.run_attempt) === env.GITHUB_RUN_ATTEMPT, 'runIdentity')
  // The dispatcher and whoever started this attempt (a re-run) must both be allowed.
  const dispatcher = desktopDispatch ? actor => isPromoter(policy, actor) : isOwnerActor
  if (desktopDispatch) requireProof(dispatcher(run.actor) && dispatcher(run.triggering_actor), 'dispatchActor')
  if (observed) {
    requireProof(dispatcher(run.actor) && dispatcher(run.triggering_actor), 'dispatchActor')
  } else if (piped) {
    const allowedActor = chained ? isPipelineActor : dispatcher
    requireProof(allowedActor(run.actor) && allowedActor(run.triggering_actor), 'dispatchActor')
  } else {
    const approvalBody = await readOwnerBody(record.approvalComment, record.approvalSha256, 'MIKKA_CUTOVER_ACCEPTANCE_V1', api)
    requireProof(/^\r?\n/.test(approvalBody), 'approvalMarker')
    approval = JSON.parse(approvalBody)
    const inventory = approval.evidence?.inventoryAndRollback
    requireProof(approval.decision === 'approved' && approval.product === record.product && approval.overlay === record.overlay
      && inventory?.sha256 === record.inventorySha256
      && /^https:\/\/github\.com\/alexj11324\/mikka-cloud\/issues\/4#issuecomment-[1-9][0-9]*$/.test(inventory?.url), 'approval')
    const verified = Date.parse(record.verifiedAt), started = Date.parse(run.run_started_at)
    // GitHub timestamps are second-precision. Bind freshness to this original attempt so
    // a long native validation can finish without accepting a new dispatch on an old anchor.
    requireProof(started >= Math.floor(verified / 1000) * 1000 && started <= verified + 600_000
      && started <= now() && verified <= now(), 'staleDispatch')
    const from = Date.parse(approval.from)
    until = Date.parse(approval.until)
    requireProof(from <= verified && now() < until, 'approvalWindow')
  }
  if (workflow === desktopWorkflow) {
    const expectedOverlay = env.MIKKA_UI_OVERLAY_SHA || env.EXPECTED_UI_OVERLAY_SHA
    requireProof(!expectedOverlay || expectedOverlay === record.overlay, 'desktopOverlay')
    // The installer is built from the served commit (MIKKA_DESKTOP_SOURCE once checked out), never from a later main.
    const desktopSource = env.MIKKA_DESKTOP_SOURCE || record.product
    requireProof(present(desktopSource, sha) && await containsDesktopSource({ ...api, expectedBuild: desktopSource, publicCommit: record.product }), 'desktopSource')
    if (automated) {
      // Because unchanged Web/API builds are reused across promotions, never allow
      // an older receipt (actions: or pipeline:) to publish under a higher run number and downgrade releases/latest.
      const latest = await readLatestRelease(api)
      if (present(latest?.target_commitish, sha) && latest.target_commitish !== record.product) {
        requireProof(!await containsDesktopSource({ ...api, expectedBuild: record.product, publicCommit: latest.target_commitish }), 'staleRelease')
      }
    }
  }
  if (automated) await liveServingRelease(record, fetchImpl, { wait })
  else await liveProof(record, raw, fetchImpl, { wait })
  // Desktop and the runtime publish the served commit; it must already be part of main.
  // Later merges to main neither replace it nor block its publication.
  requireProof(await servedOnMain(record.product, api), 'servedOnMain')
  if (!automated) requireProof(now() < until, 'approvalWindow')
  const result = { product: record.product, releasePin: record.releasePin }
  return workflow === desktopWorkflow ? { ...result, overlay: record.overlay } : result
}

async function servedOnMain(product, api) {
  const compared = await githubRead('/compare/' + product + '...main', api)
  return (compared.status === 'identical' || compared.status === 'ahead') && compared.merge_base_commit?.sha === product
}

async function desktopAlreadyCovers(latest, record, api) {
  const latestSha = latest?.target_commitish
  if (!present(latestSha, sha)) return false
  const latestOverlay = await latestReleaseOverlay(latest, api)
  if (latestOverlay !== record.overlay) return false
  if (!await containsDesktopSource({ ...api, expectedBuild: record.servedBuild, publicCommit: latestSha })) return false
  if (!await containsDesktopSource({ ...api, expectedBuild: record.apiBuild, publicCommit: latestSha })) return false
  const diff = await githubRead('/compare/' + latestSha + '...' + record.product + '?per_page=1', api)
  if (diff.status === 'identical' || (diff.status === 'behind' && diff.merge_base_commit?.sha === record.product)) return true
  if (diff.status !== 'ahead' || diff.merge_base_commit?.sha !== latestSha
    || !Array.isArray(diff.files) || diff.files.length >= 300) return false
  return !diff.files.some(file => isDesktopRelevantPath(file?.filename) || isDesktopRelevantPath(file?.previous_filename))
}

async function readEvent(env) {
  try { return JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')) } catch (cause) { throw Error('cloudflareWeb:event', { cause }) }
}

/** Decide whether a finished Cloudflare deployment run should start a consumer release.
 * The runtime release starts from a successful gateway observation; Desktop starts only from an
 * automatic pipeline-production promotion. Their served product must be on main; anything else
 * (including any owner-dispatched deployment phase, for Desktop) is a quiet no-op. */
export async function promotionTrigger(consumer, { env = process.env, event, fetchImpl = fetch, wait = sleep } = {}) {
  requireProof([runtimeWorkflow, desktopWorkflow].includes(consumer), 'consumer')
  const source = (event ?? await readEvent(env)).workflow_run
  const api = { token: env.GITHUB_TOKEN, fetchImpl }
  const pipelineEvent = consumer === desktopWorkflow && source?.event === 'workflow_run'
  if (!actionsMikkaRepository(env) || env.GITHUB_EVENT_NAME !== 'workflow_run' || source?.path !== deploymentWorkflow
    || !(source.event === 'workflow_dispatch' || pipelineEvent)
    || source.status !== 'completed' || source.conclusion !== 'success' || source.head_branch !== 'main'
    || !officialRepository(source.repository) || !present(String(source.id), decimal) || !present(String(source.run_attempt), decimal)) {
    return { ready: false, reason: 'not a successful Cloudflare deployment run on main' }
  }
  if (consumer === desktopWorkflow && !pipelineEvent) {
    return { ready: false, reason: 'Desktop starts only from an automatic production promotion or an explicit desktop-release.yml dispatch' }
  }
  const path = '/actions/runs/' + source.id + '/attempts/' + source.run_attempt + '/jobs?per_page=100'
  const listing = await githubRead(path, api)
  let receipt
  if (pipelineEvent) {
    if (!Array.isArray(listing.jobs) || !listing.jobs.some(isPipelineProductionPromoted)) {
      return { ready: false, reason: 'this deployment phase does not change what is served' }
    }
    receipt = 'pipeline:' + source.id + ':' + source.run_attempt
  } else {
    // Every deployment run lists the Serving release job; only gateway-observe runs it (the others skip it, unnamed).
    if (!Array.isArray(listing.jobs) || !listing.jobs.some(job => job.name?.startsWith('Serving release ') && job.conclusion === 'success')) {
      return { ready: false, reason: 'this deployment phase does not change what is served' }
    }
    receipt = 'actions:' + source.id + ':' + source.run_attempt
  }
  const record = await readServingPromotion(receipt, { token: env.GITHUB_TOKEN, fetchImpl, wait })
  const main = await githubRead('/git/ref/heads/main', api)
  requireProof(main.object?.type === 'commit' && present(main.object.sha, sha), 'mainRef')
  if (consumer === desktopWorkflow ? !await servedOnMain(record.product, api) : record.product !== main.object.sha || record.product !== env.GITHUB_SHA) {
    return { ready: false, reason: 'Cloudflare serves ' + record.product + ' but main is ' + main.object.sha }
  }
  if (consumer === desktopWorkflow) {
    const latest = await readLatestRelease(api)
    if (latest?.target_commitish === record.product) {
      const latestOverlay = await latestReleaseOverlay(latest, api)
      if (pipelineEvent ? latestOverlay === record.overlay : (!latestOverlay || latestOverlay === record.overlay)) {
        return { ready: false, reason: 'Desktop for ' + record.product + ' is already released' }
      }
    }
    if (pipelineEvent && await desktopAlreadyCovers(latest, record, api)) {
      return { ready: false, reason: 'Desktop release ' + latest.target_commitish + ' already covers ' + record.product }
    }
  }
  return { ready: true, receipt, product: record.product, reason: 'Cloudflare serves ' + record.product + ' on main' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'trigger') {
      requireProof(process.argv.length === 4 && ['runtime', 'desktop'].includes(process.argv[3]), 'consumer')
      const result = await promotionTrigger(process.argv[3] === 'desktop' ? desktopWorkflow : runtimeWorkflow)
      console.log(result.reason)
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
        `ready=${result.ready}\nreceipt=${result.ready ? result.receipt : ''}\nproduct=${result.ready ? result.product : ''}\n`)
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `\n### ${result.ready ? 'Released after the Cloudflare promotion' : 'Nothing to release'}\n\n${result.reason}\n`)
    } else if (process.argv.length === 2) {
      const { product } = await verifyPromotedWeb()
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `source=${product}\n`)
    }
    else {
      requireProof(process.argv.length === 3 && process.argv[2] === 'desktop', 'consumer')
      const { overlay, product } = await verifyDesktopPromotedWeb()
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `overlay-sha=${overlay}\nproduct=${product}\n`)
    }
  } catch (error) {
    console.error(/^cloudflareWeb:[A-Za-z]+$/.test(error?.message) ? error.message : 'cloudflareWeb:unverified')
    process.exitCode = 1
  }
}
