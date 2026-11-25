// Fail-closed helper for .github/workflows/mobile-next-update.yml.
// Enforces next-channel OTA isolation, validates dispatch inputs, and prints
// only public-safe EAS Update metadata (never credentials or private diagnostics).
import { appendFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA = /^[0-9a-f]{40}$/
const NEXT_RUNTIME = /^mikka-next-[1-9][0-9]*$/
const SAFE_ID = /^[A-Za-z0-9-]+$/
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/
export const EXPECTED_CHANNEL = 'next'
export const EXPECTED_PLATFORM = 'ios'

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
  let easConfig
  try {
    easConfig = JSON.parse(easConfigSource)
  } catch {
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

function parseJsonPayload(rawOutput) {
  if (typeof rawOutput !== 'string' || rawOutput.trim() === '') fail('emptyEasOutput')
  const trimmed = rawOutput.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Metro/CLI can emit non-JSON progress lines before the JSON block.
    for (let index = 0; index < trimmed.length; index++) {
      const ch = trimmed[index]
      if (ch !== '[' && ch !== '{') continue
      if (index > 0 && trimmed[index - 1] !== '\n') continue
      try {
        return JSON.parse(trimmed.slice(index))
      } catch {
        // Keep scanning for the trailing JSON payload.
      }
    }
    fail('invalidEasJson')
  }
}

export function parseEasUpdateOutput(
  rawOutput,
  {
    expectedChannel = EXPECTED_CHANNEL,
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

  const branch = selected.branch ?? payload?.branch ?? expectedChannel
  if (typeof branch !== 'string' || !SAFE_BRANCH.test(branch) || branch === 'production') {
    fail('forbiddenBranch')
  }

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
  const [command, target] = process.argv.slice(2)
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
