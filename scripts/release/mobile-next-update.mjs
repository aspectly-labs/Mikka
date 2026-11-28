// Fail-closed helper for .github/workflows/mobile-next-update.yml.
// Enforces next-channel OTA isolation, validates dispatch inputs and EAS channel
// mappings before publication, and prints only public-safe metadata (never
// credentials or private diagnostics).
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactFor, readArtifactMembers } from './pipeline-inputs.mjs'
import { officialMikkaRepository } from '../cloudflare-source.mjs'
import { checkedReleasePolicy, isPromoter, isPromoterLogin, publicPolicy, readReleasePolicy, requireCommittedPromoters } from './release-policy.mjs'

const SHA = /^[0-9a-f]{40}$/
const MOBILE_OTA_RUNTIME_PATTERN = /^mikka-next-[1-9][0-9]*$/
const APP_RUNTIME_SYMBOL = ['MIKKA_NEXT', 'RUNTIME_VERSION'].join('_')
const SAFE_ID = /^[A-Za-z0-9-]+$/
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/
export const EXPECTED_CHANNEL = 'next'
export const EXPECTED_PLATFORM = 'ios'
export const EXPECTED_IOS_BUNDLE_ID = 'com.aspectlylabs.mikka'
// A staged OTA lands on this EAS branch, which no user-facing channel may map to.
export const STAGING_BRANCH = 'next-staging'
export const MOBILE_PHASES = Object.freeze(['stage', 'publish', 'promote'])
const WORKFLOW_PATH = '.github/workflows/mobile-next-update.yml'
const DECIMAL = /^[1-9][0-9]{0,15}$/

function hasControlChars(text) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function fail(code, cause) {
  throw cause === undefined ? new Error(`mobileNextUpdate:${code}`) : new Error(`mobileNextUpdate:${code}`, { cause })
}

export function validateHostedUiRef(value) {
  const ref = value === undefined || value === '' ? 'main' : value
  if (typeof ref !== 'string') fail('invalidHostedUiRef')
  if (ref === 'main' || SHA.test(ref)) return ref
  fail('invalidHostedUiRef')
}

export function formatUpdateMessage(message, overlaySha) {
  if (typeof overlaySha !== 'string' || !SHA.test(overlaySha)) fail('invalidOverlaySha')
  if (message === undefined || message === null || String(message).trim() === '') {
    return `mobile-next OTA (${overlaySha.slice(0, 12)})`
  }
  const trimmed = String(message).trim()
  if (hasControlChars(trimmed) || trimmed.length > 200) fail('invalidMessage')
  return trimmed
}

export function verifyMobileNextConfig(appConfigSource, easConfigSource) {
  if (typeof appConfigSource !== 'string' || typeof easConfigSource !== 'string') {
    fail('configUnreadable')
  }
  const channelMatch = /export\s+const\s+MIKKA_NEXT_UPDATES_CHANNEL\s*=\s*["']([^"']+)["']/.exec(appConfigSource)
  if (!channelMatch || channelMatch[1] !== EXPECTED_CHANNEL) {
    fail('channelMustBeNext')
  }
  const runtimeDeclPattern = new RegExp(`export\\s+const\\s+${APP_RUNTIME_SYMBOL}\\s*=\\s*["']([^"']+)["']`)
  const runtimeMatch = runtimeDeclPattern.exec(appConfigSource)
  if (!runtimeMatch || !MOBILE_OTA_RUNTIME_PATTERN.test(runtimeMatch[1])) {
    fail('runtimeVersionInvalid')
  }
  const runtimeRefPattern = new RegExp(`runtimeVersion\\s*:[\\s\\S]*?${APP_RUNTIME_SYMBOL}`)
  if (
    !/["']expo-channel-name["']\s*:\s*MIKKA_NEXT_UPDATES_CHANNEL/.test(appConfigSource) ||
    !runtimeRefPattern.test(appConfigSource)
  ) {
    fail('appConfigIsolationInvalid')
  }
  const iosBlockMatch = /\bios\s*:\s*\{([\s\S]*?)\n\s{2}\},/.exec(appConfigSource)
  if (iosBlockMatch && /\bruntimeVersion\s*:/.test(iosBlockMatch[1])) {
    fail('iosRuntimeVersionOverrideForbidden')
  }
  let easConfig
  try {
    easConfig = JSON.parse(easConfigSource)
  } catch {
    // Redaction boundary: eas.json belongs to private mikka-hosted-ui; drop
    // the raw JSON.parse error cause so private config excerpts cannot leak
    // into public Actions logs (docs/design/decisions/2026-11-05-0330-error-causes.md).
    fail('easConfigInvalidJson')
  }
  const nextProfile = easConfig?.build?.next
  if (
    nextProfile?.channel !== EXPECTED_CHANNEL ||
    nextProfile?.env?.APP_VARIANT !== 'production'
  ) {
    fail('easConfigIsolationInvalid')
  }
  return {
    channel: EXPECTED_CHANNEL,
    runtimeVersion: runtimeMatch[1],
  }
}

export function verifyResolvedExpoConfig(rawConfigJson, { expectedChannel = EXPECTED_CHANNEL, expectedRuntimeVersion } = {}) {
  if (expectedChannel !== EXPECTED_CHANNEL) fail('channelMustBeNext')
  if (typeof expectedRuntimeVersion !== 'string' || !MOBILE_OTA_RUNTIME_PATTERN.test(expectedRuntimeVersion)) {
    fail('runtimeVersionInvalid')
  }
  const config = parseJsonPayload(rawConfigJson, 'invalidExpoConfigJson')
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('invalidExpoConfigJson')

  const updatesChannel = config.updates?.requestHeaders?.['expo-channel-name']
  if (updatesChannel !== expectedChannel) fail('resolvedChannelMismatch')
  if (config.updates?.enabled === false) fail('updatesDisabled')

  const topRuntime = config.runtimeVersion
  const iosRuntime = config.ios?.runtimeVersion
  const effectiveIosRuntime = iosRuntime ?? topRuntime
  if (typeof effectiveIosRuntime !== 'string' || effectiveIosRuntime !== expectedRuntimeVersion) {
    fail('resolvedRuntimeVersionMismatch')
  }
  if (typeof topRuntime !== 'string' || topRuntime !== expectedRuntimeVersion) {
    fail('resolvedRuntimeVersionMismatch')
  }
  if (config.ios?.bundleIdentifier !== EXPECTED_IOS_BUNDLE_ID) {
    fail('resolvedBundleIdMismatch')
  }

  return {
    channel: updatesChannel,
    runtimeVersion: effectiveIosRuntime,
    bundleIdentifier: config.ios.bundleIdentifier,
  }
}

function parseJsonPayload(rawOutput, errorCode = 'invalidEasJson') {
  if (typeof rawOutput !== 'string' || rawOutput.trim() === '') fail('emptyEasOutput')
  const trimmed = rawOutput.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Redaction boundary: Expo/EAS CLI stdout may contain private workspace
    // diagnostics before the JSON block; scan for a trailing JSON payload and
    // drop raw parser causes so private text never enters public logs.
    for (let index = 0; index < trimmed.length; index++) {
      const ch = trimmed[index]
      if (ch !== '[' && ch !== '{') continue
      if (index > 0 && trimmed[index - 1] !== '\n') continue
      try {
        return JSON.parse(trimmed.slice(index))
      } catch {
        // Ignore non-JSON preamble braces; redaction drops intermediate causes.
      }
    }
    fail(errorCode)
  }
}

function unwrapChannelPage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('invalidChannelJson')
  }
  if (Object.hasOwn(payload, 'currentPage')) {
    if (!payload.currentPage || typeof payload.currentPage !== 'object' || Array.isArray(payload.currentPage)) {
      fail('invalidChannelJson')
    }
    return payload.currentPage
  }
  return payload
}

function extractMappedBranchNames(rawPayload) {
  const channelPayload = unwrapChannelPage(rawPayload)
  const byId = new Map()
  if (Array.isArray(channelPayload.updateBranches)) {
    for (const branch of channelPayload.updateBranches) {
      if (typeof branch?.id === 'string' && typeof branch?.name === 'string') {
        byId.set(branch.id, branch.name)
      }
    }
  }

  let mapping = channelPayload.branchMapping
  if (typeof mapping === 'string') {
    try {
      mapping = JSON.parse(mapping)
    } catch {
      // Redaction boundary: drop raw JSON parse error on EAS channel response.
      fail('invalidBranchMapping')
    }
  }

  const names = []
  if (Array.isArray(mapping?.data) && mapping.data.length > 0) {
    for (const entry of mapping.data) {
      if (Array.isArray(entry?.updateBranches) && entry.updateBranches.length > 0) {
        for (const sub of entry.updateBranches) {
          if (typeof sub?.name === 'string') names.push(sub.name)
        }
      } else if (typeof entry?.branchName === 'string') {
        names.push(entry.branchName)
      } else if (typeof entry?.branchId === 'string' && byId.has(entry.branchId)) {
        names.push(byId.get(entry.branchId))
      } else {
        fail('unmappedBranchId')
      }
    }
  } else if (Array.isArray(channelPayload.updateBranches) && channelPayload.updateBranches.length > 0) {
    for (const branch of channelPayload.updateBranches) {
      if (typeof branch?.name === 'string') names.push(branch.name)
    }
  }

  return [...new Set(names)]
}

export function verifyChannelMapping(
  nextChannelRaw,
  { expectedChannel = EXPECTED_CHANNEL, productionChannelRaw } = {},
) {
  if (expectedChannel !== EXPECTED_CHANNEL) fail('channelMustBeNext')
  const nextPayload = unwrapChannelPage(parseJsonPayload(nextChannelRaw, 'invalidChannelJson'))
  if (nextPayload?.name !== undefined && nextPayload.name !== expectedChannel) {
    fail('channelNameMismatch')
  }
  const nextBranches = extractMappedBranchNames(nextPayload)
  if (nextBranches.length !== 1) fail('ambiguousBranchMapping')
  const [branch] = nextBranches
  if (!SAFE_BRANCH.test(branch) || branch === 'production') fail('forbiddenBranch')

  if (typeof productionChannelRaw !== 'string' || productionChannelRaw.trim() === '') {
    fail('productionChannelRequired')
  }
  const prodPayload = unwrapChannelPage(parseJsonPayload(productionChannelRaw, 'invalidProductionChannelJson'))
  if (prodPayload?.name !== undefined && prodPayload.name !== 'production') {
    fail('productionChannelNameMismatch')
  }
  const prodBranches = extractMappedBranchNames(prodPayload)
  if (prodBranches.length === 0) fail('invalidProductionChannelJson')
  if (prodBranches.includes(branch)) fail('branchSharedWithProduction')

  return { channel: expectedChannel, branch }
}

export function parseEasUpdateOutput(
  rawOutput,
  {
    expectedChannel = EXPECTED_CHANNEL,
    expectedBranch = null,
    expectedRuntimeVersion,
    expectedPlatform = EXPECTED_PLATFORM,
    overlaySha,
  } = {},
) {
  if (expectedChannel !== EXPECTED_CHANNEL) fail('channelMustBeNext')
  if (typeof expectedRuntimeVersion !== 'string' || !MOBILE_OTA_RUNTIME_PATTERN.test(expectedRuntimeVersion)) {
    fail('runtimeVersionInvalid')
  }
  if (typeof overlaySha !== 'string' || !SHA.test(overlaySha)) fail('invalidOverlaySha')

  const payload = parseJsonPayload(rawOutput)
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.updates)
      ? payload.updates
      : payload && typeof payload === 'object'
        ? [payload]
        : []

  // `update --json` and `update:view --json` print `branch`/`runtimeVersion` strings; `update:republish --json`
  // prints GraphQL updates with `branch: {id, name}` and `runtime: {id, version}` (eas-cli 27.2.0).
  const branchName = entry => typeof entry?.branch === 'string' ? entry.branch : entry?.branch?.name
  for (const entry of candidates) {
    if (branchName(entry) === 'production') fail('forbiddenBranch')
  }

  const selected = candidates.find(entry => entry?.platform === expectedPlatform)
    ?? (candidates.length === 1 && !candidates[0]?.platform ? candidates[0] : null)
  if (!selected || typeof selected !== 'object') fail('platformMissing')

  const updateGroupId = selected.group ?? payload?.group ?? ''
  if (typeof updateGroupId !== 'string' || !SAFE_ID.test(updateGroupId)) fail('groupIdMissing')

  const updateId = selected.id ?? ''
  if (updateId !== '' && (typeof updateId !== 'string' || !SAFE_ID.test(updateId))) {
    fail('updateIdInvalid')
  }

  const runtimeVersion = selected.runtimeVersion ?? selected.runtime?.version ?? payload?.runtimeVersion ?? ''
  if (runtimeVersion !== expectedRuntimeVersion) fail('runtimeVersionMismatch')

  const branch = branchName(selected) ?? payload?.branch ?? expectedBranch ?? expectedChannel
  if (typeof branch !== 'string' || !SAFE_BRANCH.test(branch) || branch === 'production') {
    fail('forbiddenBranch')
  }
  if (expectedBranch && branch !== expectedBranch) fail('branchMismatch')

  const createdAt = typeof (selected.createdAt ?? payload?.createdAt) === 'string'
    && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(selected.createdAt ?? payload?.createdAt)
    ? (selected.createdAt ?? payload?.createdAt)
    : null

  return {
    updateGroupId,
    ...(updateId ? { updateId } : {}),
    channel: expectedChannel,
    branch,
    runtimeVersion,
    platform: expectedPlatform,
    overlaySha,
    ...(createdAt ? { createdAt } : {}),
  }
}

export function validatePhase(value) {
  const phase = value === undefined || value === '' ? 'stage' : value
  if (!MOBILE_PHASES.includes(phase)) fail('invalidPhase')
  return phase
}

/** The production mobile switch is `mobileProduction` in private mikka-cloud deploy-pipeline.json on main,
 * read exactly like `autoProduction`: only `version: 1` with a boolean flag is readable; `true` allows a
 * direct publish to the `next` channel, `false` (paused, 2026-11-27) allows only an owner promotion of a
 * staged update. Anything else is unreadable and publishes nothing to `next`. */
export function mobilePolicyMode(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || policy.version !== 1
    || typeof policy.mobileProduction !== 'boolean') return 'unreadable'
  return policy.mobileProduction ? 'automatic' : 'manual'
}

export function requirePhaseAllowed(phase, mode) {
  validatePhase(phase)
  if (phase === 'stage') return
  if (phase === 'publish' && mode !== 'automatic') fail(mode === 'manual' ? 'productionOtaPaused' : 'productionPolicyUnreadable')
  if (phase === 'promote' && !['automatic', 'manual'].includes(mode)) fail('productionPolicyUnreadable')
}

/** Read and check the release policy on private main. Every failure is `unreadable`; a policy whose
 * promoters differ from config/release-promoters.json (the public job gate) is unreadable too. */
export async function readOperationsPolicy({ owner, token, fetchImpl = fetch, read = readReleasePolicy } = {}) {
  try {
    const { policy, blob } = await read({ owner, token, fetchImpl })
    const checked = checkedReleasePolicy(policy)
    requireCommittedPromoters(checked)
    return { mode: mobilePolicyMode(policy), blob, checked }
  } catch {
    return { mode: 'unreadable' }
  }
}

/** publish and promote run only for a promoter: the dispatcher (id and login) and whoever started this attempt. */
export function requirePromoterDispatch(env, checked) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || !checked
    || !isPromoter(checked, { id: env.GITHUB_ACTOR_ID, login: env.GITHUB_ACTOR })
    || !isPromoterLogin(checked, env.GITHUB_TRIGGERING_ACTOR)) fail('dispatchNeedsPromoter')
}

function extractProductionBranches(productionChannelRaw) {
  const prodPayload = unwrapChannelPage(parseJsonPayload(productionChannelRaw, 'invalidProductionChannelJson'))
  return extractMappedBranchNames(prodPayload)
}

/** A staged update must not reach any user: its branch is neither the `next` nor the `production` branch. */
export function verifyStagingTarget(nextChannelRaw, productionChannelRaw) {
  const { branch } = verifyChannelMapping(nextChannelRaw, { productionChannelRaw })
  if (branch === STAGING_BRANCH || extractProductionBranches(productionChannelRaw).includes(STAGING_BRANCH)) {
    fail('stagingBranchServesUsers')
  }
  return { branch: STAGING_BRANCH, nextBranch: branch }
}

export function stageReceipt(summary, { runId, runAttempt }) {
  if (!DECIMAL.test(String(runId ?? '')) || !DECIMAL.test(String(runAttempt ?? ''))) fail('invalidStageRun')
  if (summary?.branch !== STAGING_BRANCH || summary.platform !== EXPECTED_PLATFORM) fail('stageBranchMismatch')
  return { version: 1, phase: 'stage', runId: String(runId), runAttempt: String(runAttempt), branch: STAGING_BRANCH,
    platform: EXPECTED_PLATFORM, runtimeVersion: summary.runtimeVersion, overlaySha: summary.overlaySha,
    updateGroupId: summary.updateGroupId }
}

/** Promotion requires a completed, successful stage run of this workflow on main, dispatched by a
 * repository writer, whose receipt names the exact hosted-ui commit the owner asks to promote. */
export async function verifiedStage({ stageRun, hostedUiRef, read, checked }) {
  if (!DECIMAL.test(String(stageRun ?? ''))) fail('stageRunRequired')
  if (!SHA.test(hostedUiRef ?? '')) fail('promoteNeedsExactSha')
  const run = await read(`actions/runs/${stageRun}`)
  for (const key of ['repository', 'head_repository']) {
    if (!officialMikkaRepository(run?.[key]?.full_name, String(run?.[key]?.id)) || run[key].fork !== false) fail('stageRunRepository')
  }
  if (run.path !== WORKFLOW_PATH || run.event !== 'workflow_dispatch' || run.head_branch !== 'main'
    || run.status !== 'completed' || run.conclusion !== 'success' || String(run.id) !== String(stageRun)
    || !DECIMAL.test(String(run.run_attempt))) fail('stageRunUnsuccessful')
  // Only a stage a promoter started (and did not have re-run by someone else) can be promoted.
  if (!checked || !isPromoter(checked, run.actor) || !isPromoter(checked, run.triggering_actor)) fail('stageRunNotPromoter')
  // The workflow revision that staged it is part of main.
  const compared = await read(`compare/${run.head_sha}...main`)
  if (!['identical', 'ahead'].includes(compared?.status) || compared.merge_base_commit?.sha !== run.head_sha) fail('stageRunOffMain')
  const listing = await read(`actions/runs/${run.id}/artifacts?per_page=100`)
  let artifact, files
  try {
    artifact = artifactFor(run, listing?.artifacts ?? [], 'mobile-ota-stage')
    files = readArtifactMembers(await read(`actions/artifacts/${artifact.id}/zip`, { bytes: true }), artifact)
  } catch (cause) { fail('stageReceiptMissing', cause) }
  const receipt = files['receipt.json']
  if (receipt?.version !== 1 || receipt.phase !== 'stage' || receipt.runId !== String(run.id)
    || receipt.runAttempt !== String(run.run_attempt) || receipt.branch !== STAGING_BRANCH
    || receipt.platform !== EXPECTED_PLATFORM || !MOBILE_OTA_RUNTIME_PATTERN.test(receipt.runtimeVersion ?? '')
    || !SAFE_ID.test(receipt.updateGroupId ?? '')) fail('stageReceiptInvalid')
  if (receipt.overlaySha !== hostedUiRef) fail('stageOverlayMismatch')
  return { runId: String(run.id), runAttempt: String(run.run_attempt), updateGroupId: receipt.updateGroupId,
    runtimeVersion: receipt.runtimeVersion, overlaySha: receipt.overlaySha }
}

/** `eas update:view <group> --json` must show the staged group still on the staging branch, for iOS and its runtime. */
export function verifyStagedGroup(rawOutput, { groupId, runtimeVersion }) {
  const payload = parseJsonPayload(rawOutput, 'invalidStagedGroupJson')
  const updates = Array.isArray(payload) ? payload : Array.isArray(payload?.updates) ? payload.updates : []
  if (!updates.length || !SAFE_ID.test(groupId ?? '')) fail('stagedGroupMissing')
  for (const update of updates) {
    const branch = typeof update?.branch === 'string' ? update.branch : update?.branch?.name
    const runtime = update?.runtimeVersion ?? update?.runtime?.version
    if (update?.group !== groupId || branch !== STAGING_BRANCH || runtime !== runtimeVersion) fail('stagedGroupMismatch')
  }
  if (!updates.some(update => update.platform === EXPECTED_PLATFORM)) fail('stagedGroupMismatch')
  return { groupId, branch: STAGING_BRANCH, runtimeVersion }
}

async function publicActionsRead(path, { bytes = false } = {}) {
  const token = process.env.GITHUB_TOKEN
  if (!token) fail('actionsTokenRequired')
  const response = await fetch(`https://api.github.com/repositories/1427517699/${path}`, {
    headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    cache: 'no-store', signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) { await response.body?.cancel(); fail('actionsReadFailed') }
  return bytes ? Buffer.from(await response.arrayBuffer()) : response.json()
}

export function formatStepSummary(summary) {
  return [
    '## Mobile next OTA update',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Update group ID | \`${summary.updateGroupId}\` |`,
    ...(summary.updateId ? [`| Update ID | \`${summary.updateId}\` |`] : []),
    `| Channel | \`${summary.channel}\` |`,
    `| Branch | \`${summary.branch}\` |`,
    `| Runtime version | \`${summary.runtimeVersion}\` |`,
    `| Platform | \`${summary.platform}\` |`,
    `| mikka-hosted-ui SHA | \`${summary.overlaySha}\` |`,
    ...(summary.createdAt ? [`| Created at | \`${summary.createdAt}\` |`] : []),
    '',
  ].join('\n')
}

async function main() {
  const [command, target, secondary] = process.argv.slice(2)
  if (command === 'policy' || command === 'policy-recheck') {
    // policy <phase>: read private main with MIKKA_OPERATIONS_READ_TOKEN; fail closed; publish and promote need a promoter.
    // policy-recheck <phase>: the same, and the policy blob must still be the one read first (MOBILE_POLICY_BLOB).
    const phase = validatePhase(target)
    const { mode, blob, checked } = await readOperationsPolicy({ owner: process.env.MIKKA_OPERATIONS_OWNER,
      token: process.env.MIKKA_OPERATIONS_READ_TOKEN })
    requirePhaseAllowed(phase, mode)
    if (phase !== 'stage') requirePromoterDispatch(process.env, checked)
    if (command === 'policy-recheck' && (!blob || blob !== process.env.MOBILE_POLICY_BLOB)) fail('productionPolicyChanged')
    if (command === 'policy' && process.env.GITHUB_ENV && checked) await appendFile(process.env.GITHUB_ENV,
      `MOBILE_POLICY_BLOB=${blob}\nMIKKA_RELEASE_POLICY=${JSON.stringify(publicPolicy(checked, 'mobile'))}\n`)
    console.log(JSON.stringify({ phase, mode }))
    return
  }
  if (command === 'verify-staged-group') {
    if (!target) fail('easOutputPathRequired')
    console.log(JSON.stringify(verifyStagedGroup(await readFile(target, 'utf8'), {
      groupId: process.env.STAGED_UPDATE_GROUP, runtimeVersion: process.env.STAGED_RUNTIME_VERSION })))
    return
  }
  if (command === 'verify-staging-channel') {
    if (!target || !secondary) fail('channelJsonPathRequired')
    const [nextRaw, prodRaw] = await Promise.all([readFile(target, 'utf8'), readFile(secondary, 'utf8')])
    process.stdout.write(verifyStagingTarget(nextRaw, prodRaw).branch)
    return
  }
  if (command === 'stage-receipt') {
    if (!target) fail('easOutputPathRequired')
    const summary = parseEasUpdateOutput(await readFile(target, 'utf8'), {
      expectedBranch: STAGING_BRANCH,
      expectedRuntimeVersion: process.env.MOBILE_OTA_RUNTIME_VERSION,
      overlaySha: process.env.OVERLAY_SHA,
    })
    const receipt = stageReceipt(summary, { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT })
    const directory = join(process.env.RUNNER_TEMP, 'mobile-ota-stage')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify(receipt))
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, formatStepSummary(summary))
    return
  }
  if (command === 'verify-stage') {
    // Runs after `policy promote`, which exported the checked public projection of the policy.
    let projection
    try { projection = JSON.parse(process.env.MIKKA_RELEASE_POLICY ?? '') } catch { fail('policyRequired') }
    const checked = { promoters: Array.isArray(projection?.promoters) ? projection.promoters : [] }
    requirePromoterDispatch(process.env, checked)
    const staged = await verifiedStage({ stageRun: process.env.STAGE_RUN, hostedUiRef: process.env.HOSTED_UI_REF,
      read: publicActionsRead, checked })
    if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV,
      `STAGED_UPDATE_GROUP=${staged.updateGroupId}\nSTAGED_RUNTIME_VERSION=${staged.runtimeVersion}\n`)
    console.log(JSON.stringify(staged))
    return
  }
  if (command === 'validate-inputs') {
    validatePhase(process.env.MOBILE_OTA_PHASE)
    const ref = validateHostedUiRef(process.env.HOSTED_UI_REF)
    if (process.env.UPDATE_MESSAGE && process.env.UPDATE_MESSAGE.trim() !== '') {
      formatUpdateMessage(process.env.UPDATE_MESSAGE, '0'.repeat(40))
    }
    console.log(JSON.stringify({ hostedUiRef: ref }))
    return
  }
  if (command === 'verify-config') {
    if (!target) fail('appDirRequired')
    const [appConfig, easConfig] = await Promise.all([
      readFile(join(target, 'app.config.ts'), 'utf8'),
      readFile(join(target, 'eas.json'), 'utf8'),
    ])
    const verified = verifyMobileNextConfig(appConfig, easConfig)
    if (process.env.GITHUB_ENV) {
      await appendFile(
        process.env.GITHUB_ENV,
        `MOBILE_OTA_CHANNEL=${verified.channel}\nMOBILE_OTA_RUNTIME_VERSION=${verified.runtimeVersion}\n`,
      )
    }
    console.log(JSON.stringify(verified))
    return
  }
  if (command === 'verify-resolved-config') {
    if (!target) fail('expoConfigPathRequired')
    const raw = await readFile(target, 'utf8')
    const verified = verifyResolvedExpoConfig(raw, {
      expectedChannel: process.env.EAS_CHANNEL ?? EXPECTED_CHANNEL,
      expectedRuntimeVersion: process.env.MOBILE_OTA_RUNTIME_VERSION,
    })
    console.log(JSON.stringify(verified))
    return
  }
  if (command === 'verify-channel') {
    if (!target) fail('channelJsonPathRequired')
    if (!secondary) fail('productionChannelRequired')
    const [nextRaw, prodRaw] = await Promise.all([
      readFile(target, 'utf8'),
      readFile(secondary, 'utf8').catch(cause => {
        fail('productionChannelUnreadable', cause)
      }),
    ])
    const verified = verifyChannelMapping(nextRaw, {
      expectedChannel: process.env.EAS_CHANNEL ?? EXPECTED_CHANNEL,
      productionChannelRaw: prodRaw,
    })
    process.stdout.write(verified.branch)
    return
  }
  if (command === 'format-message') {
    const message = formatUpdateMessage(process.env.UPDATE_MESSAGE, process.env.OVERLAY_SHA)
    process.stdout.write(message)
    return
  }
  if (command === 'summarize') {
    if (!target) fail('easOutputPathRequired')
    const raw = await readFile(target, 'utf8')
    const summary = parseEasUpdateOutput(raw, {
      expectedChannel: process.env.EAS_CHANNEL ?? EXPECTED_CHANNEL,
      expectedBranch: process.env.VERIFIED_EAS_BRANCH || null,
      expectedRuntimeVersion: process.env.MOBILE_OTA_RUNTIME_VERSION,
      expectedPlatform: EXPECTED_PLATFORM,
      overlaySha: process.env.OVERLAY_SHA,
    })
    console.log(JSON.stringify(summary))
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, formatStepSummary(summary))
    }
    return
  }
  fail('invalidCommand')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const message = /^mobileNextUpdate:[A-Za-z0-9]+$/.test(error?.message ?? '')
      ? error.message
      : 'mobileNextUpdate:operationFailed'
    console.error(message)
    process.exitCode = 1
  })
}
