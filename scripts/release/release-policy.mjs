// The release policy is private mikka-cloud docs/operations/releases/deploy-pipeline.json on main.
// It holds the two pause switches (autoProduction, mobileProduction), the promoters allowlist and
// the extensible list of evidence checks per release target. Promotion is gated on evidence, not on
// who dispatches it: any listed promoter may promote, nobody else, and a merge never promotes itself.
// Every reader fails closed: a missing, unreadable or malformed policy admits no promotion.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const POLICY_PATH = 'docs/operations/releases/deploy-pipeline.json'
export const TARGETS = Object.freeze(['production', 'desktop', 'mobile'])
// Automation that merges or runs jobs must never be able to promote by itself.
export const FORBIDDEN_PROMOTERS = Object.freeze([
  { id: 118344674, login: 'github-merge-queue[bot]' },
  { id: 41898282, login: 'github-actions[bot]' },
])
// Gates that hold whatever the policy lists: the policy may add checks, never remove these.
export const MANDATORY_CHECKS = Object.freeze({
  production: Object.freeze([]),
  desktop: Object.freeze([Object.freeze({ name: 'desktop-route-guard', kind: 'builtin' })]),
  mobile: Object.freeze([]),
})
const OWNERS = new Set(['alexj11324', 'aspectly-labs'])
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/
const SHA = /^[0-9a-f]{40}$/

function fail(code) {
  throw new Error('releasePolicy:' + code)
}

function checkedCheck(entry, target) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !NAME.test(entry.name ?? '')) fail('checkInvalid')
  if (entry.kind === 'builtin') {
    if (Object.keys(entry).sort().join() !== 'kind,name') fail('checkInvalid')
    return { name: entry.name, kind: 'builtin' }
  }
  if (entry.kind === 'check-run') {
    // A successful GitHub check run with this exact name on the released public commit.
    if (target === 'mobile') fail('checkUnsupported')
    if (Object.keys(entry).sort().join() !== 'checkRun,kind,name,repository' || entry.repository !== 'public'
      || typeof entry.checkRun !== 'string' || entry.checkRun.length < 1 || entry.checkRun.length > 200) fail('checkInvalid')
    return { name: entry.name, kind: 'check-run', repository: 'public', checkRun: entry.checkRun }
  }
  fail('checkInvalid')
}

/** Validate the whole policy. Throws on anything malformed; the caller treats that as "nobody may promote". */
export function checkedReleasePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || policy.version !== 1) fail('versionRequired')
  for (const flag of ['autoProduction', 'mobileProduction']) if (typeof policy[flag] !== 'boolean') fail('flagUnreadable')
  if (!Array.isArray(policy.promoters)) fail('promotersRequired')
  const ids = new Set(), logins = new Set()
  const promoters = policy.promoters.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Number.isSafeInteger(entry.id) || entry.id < 1
      || !LOGIN.test(entry.login ?? '') || typeof entry.note !== 'string' || entry.note.trim() === ''
      || Object.keys(entry).sort().join() !== 'id,login,note') fail('promoterInvalid')
    if (FORBIDDEN_PROMOTERS.some(item => item.id === entry.id || item.login === entry.login)) fail('promoterForbidden')
    if (ids.has(entry.id) || logins.has(entry.login)) fail('promoterDuplicate')
    ids.add(entry.id); logins.add(entry.login)
    return { id: entry.id, login: entry.login }
  })
  const listed = policy.requiredChecks
  if (!listed || typeof listed !== 'object' || Array.isArray(listed)
    || Object.keys(listed).sort().join() !== [...TARGETS].sort().join()) fail('requiredChecksInvalid')
  const requiredChecks = {}
  for (const target of TARGETS) {
    if (!Array.isArray(listed[target])) fail('requiredChecksInvalid')
    const merged = new Map(MANDATORY_CHECKS[target].map(check => [check.name, check]))
    for (const entry of listed[target]) {
      const check = checkedCheck(entry, target)
      const known = merged.get(check.name)
      if (known && JSON.stringify(known) !== JSON.stringify(check)) fail('checkInvalid')
      merged.set(check.name, check)
    }
    requiredChecks[target] = [...merged.values()]
  }
  return { autoProduction: policy.autoProduction, mobileProduction: policy.mobileProduction, promoters, requiredChecks }
}

/** The public copy that release workflows gate their jobs on before any secret is read. */
export const COMMITTED_PROMOTERS_PATH = 'config/release-promoters.json'
export function committedPromoters(source = readFileSync(new URL('../../' + COMMITTED_PROMOTERS_PATH, import.meta.url), 'utf8')) {
  const file = JSON.parse(source)
  if (file?.version !== 1 || !Array.isArray(file.promoters) || !file.promoters.length) fail('committedPromotersInvalid')
  return checkedReleasePolicy({ version: 1, autoProduction: false, mobileProduction: false, promoters: file.promoters,
    requiredChecks: { production: [], desktop: [], mobile: [] } }).promoters
}

/** The exact job-level `if` clause every promotion job uses: actor id, actor login and re-run actor. */
export function promoterGateExpression(promoters = committedPromoters()) {
  const ids = JSON.stringify(promoters.map(entry => String(entry.id)))
  const logins = JSON.stringify(promoters.map(entry => entry.login))
  return `(contains(fromJSON('${ids}'), github.actor_id) && contains(fromJSON('${logins}'), github.actor) && contains(fromJSON('${logins}'), github.triggering_actor))`
}

/** The private list is authoritative; a public gate that drifted from it admits nobody. */
export function requireCommittedPromoters(checked, committed = committedPromoters()) {
  const key = list => JSON.stringify(list.map(entry => [entry.id, entry.login]).sort((a, b) => a[0] - b[0]))
  if (key(checked.promoters) !== key(committed)) fail('promotersDiverged')
}

/** An actor promotes only when both its stable id and its login match one listed entry. */
export function isPromoter(checked, actor) {
  const id = Number(actor?.id)
  return Number.isSafeInteger(id) && typeof actor?.login === 'string'
    && checked.promoters.some(entry => entry.id === id && entry.login === actor.login)
}

/** A login alone (GITHUB_TRIGGERING_ACTOR carries no id) matches a listed login. */
export function isPromoterLogin(checked, login) {
  return typeof login === 'string' && checked.promoters.some(entry => entry.login === login)
}

/** Both the actor that dispatched and whoever started this attempt (a re-run) must be promoters. */
export function requirePromoters(checked, { actor, triggeringActor }) {
  if (!checked.promoters.length) fail('noPromoters')
  if (!isPromoter(checked, actor)) fail('actorNotPromoter')
  if (!isPromoter(checked, triggeringActor)) fail('triggeringActorNotPromoter')
}

/** Read the policy at `ref` on private main with a read-only contents token and verify its Git blob. */
export async function readReleasePolicy({ owner, token, ref = 'main', fetchImpl = fetch } = {}) {
  if (!OWNERS.has(owner) || typeof token !== 'string' || token.length < 10 || !(ref === 'main' || SHA.test(ref))) fail('policyUnreadable')
  let record
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/mikka-cloud/contents/${POLICY_PATH}?ref=${ref}`, {
      headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
    })
    if (response.status !== 200) { await response.body?.cancel(); fail('policyUnreadable') }
    record = await response.json()
  } catch (error) {
    if (error?.message?.startsWith('releasePolicy:')) throw error
    fail('policyUnreadable')
  }
  return policyFromContents(record)
}

export function policyFromContents(record) {
  if (record?.type !== 'file' || record.path !== POLICY_PATH || record.encoding !== 'base64'
    || !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > 64 * 1024) fail('policyUnreadable')
  const bytes = Buffer.from(String(record.content ?? ''), 'base64')
  const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
  if (bytes.length !== record.size || blob !== record.sha) fail('policyUnreadable')
  let policy
  try { policy = JSON.parse(bytes.toString('utf8')) } catch { fail('policyUnreadable') }
  return { policy, blob }
}

/** The public projection a later job may carry: switches, promoters and checks, nothing secret. */
export function publicPolicy(checked, target) {
  if (!TARGETS.includes(target)) fail('targetInvalid')
  return { autoProduction: checked.autoProduction, mobileProduction: checked.mobileProduction,
    promoters: checked.promoters, requiredChecks: checked.requiredChecks[target] }
}

async function main() {
  const [command, target] = process.argv.slice(2)
  if (command !== 'read' || !TARGETS.includes(target)) fail('usage')
  const { policy, blob } = await readReleasePolicy({ owner: process.env.MIKKA_OPERATIONS_OWNER,
    token: process.env.MIKKA_OPERATIONS_READ_TOKEN, ref: process.env.MIKKA_OPERATIONS_REF || 'main' })
  const checked = checkedReleasePolicy(policy)
  requireCommittedPromoters(checked)
  const projection = publicPolicy(checked, target)
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `policy=${JSON.stringify(projection)}\nblob=${blob}\n`)
  console.log(JSON.stringify({ target, blob, promoters: projection.promoters.map(entry => entry.login),
    requiredChecks: projection.requiredChecks.map(check => check.name) }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(/^releasePolicy:[A-Za-z]+$/.test(error?.message ?? '') ? error.message : 'releasePolicy:policyUnreadable')
    process.exitCode = 1
  })
}
