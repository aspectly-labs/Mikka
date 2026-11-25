// Fail-closed helper for .github/workflows/mobile-next-update.yml.
// Enforces next-channel OTA isolation, validates dispatch inputs and EAS channel
// mappings before publication, and prints only public-safe metadata (never
// credentials or private diagnostics).
import { appendFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA = /^[0-9a-f]{40}$/
const NEXT_RUNTIME = /^mikka-next-[1-9][0-9]*$/
const SAFE_ID = /^[A-Za-z0-9-]+$/
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/
export const EXPECTED_CHANNEL = 'next'
export const EXPECTED_PLATFORM = 'ios'
export const EXPECTED_IOS_BUNDLE_ID = 'com.aspectlylabs.mikka'

function hasControlChars(text) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function fail(code) {
  throw new Error(`mobileNextUpdate:${code}`)
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
  const runtimeMatch = /export\s+const\s+MIKKA_NEXT_RUNTIME_VERSION\s*=\s*["']([^"']+)["']/.exec(appConfigSource)
  if (!runtimeMatch || !NEXT_RUNTIME.test(runtimeMatch[1])) {
    fail('runtimeVersionInvalid')
  }
  if (
    !/["']expo-channel-name["']\s*:\s*MIKKA_NEXT_UPDATES_CHANNEL/.test(appConfigSource) ||
    !/runtimeVersion\s*:[\s\S]*?MIKKA_NEXT_RUNTIME_VERSION/.test(appConfigSource)
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
  if (typeof expectedRuntimeVersion !== 'string' || !NEXT_RUNTIME.test(expectedRuntimeVersion)) {
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
  if (typeof expectedRuntimeVersion !== 'string' || !NEXT_RUNTIME.test(expectedRuntimeVersion)) {
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

  for (const entry of candidates) {
    if (entry?.branch === 'production') fail('forbiddenBranch')
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

  const runtimeVersion = selected.runtimeVersion ?? payload?.runtimeVersion ?? ''
  if (runtimeVersion !== expectedRuntimeVersion) fail('runtimeVersionMismatch')

  const branch = selected.branch ?? payload?.branch ?? expectedBranch ?? expectedChannel
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
  if (command === 'validate-inputs') {
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
        `MOBILE_NEXT_CHANNEL=${verified.channel}\nMOBILE_NEXT_RUNTIME_VERSION=${verified.runtimeVersion}\n`,
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
      expectedRuntimeVersion: process.env.MOBILE_NEXT_RUNTIME_VERSION,
    })
    console.log(JSON.stringify(verified))
    return
  }
  if (command === 'verify-channel') {
    if (!target) fail('channelJsonPathRequired')
    if (!secondary) fail('productionChannelRequired')
    const [nextRaw, prodRaw] = await Promise.all([
      readFile(target, 'utf8'),
      readFile(secondary, 'utf8').catch(() => {
        // Redaction boundary: fail closed if the production channel lookup file
        // is missing or unreadable without leaking runner filesystem paths.
        fail('productionChannelRequired')
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
      expectedRuntimeVersion: process.env.MOBILE_NEXT_RUNTIME_VERSION,
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
