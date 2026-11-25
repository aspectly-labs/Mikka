import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  formatStepSummary,
  formatUpdateMessage,
  parseEasUpdateOutput,
  validateHostedUiRef,
  verifyChannelMapping,
  verifyMobileNextConfig,
  verifyResolvedExpoConfig,
} from './mobile-next-update.mjs'

const WORKFLOW_URL = new URL('../../.github/workflows/mobile-next-update.yml', import.meta.url)
const HELPER_PATH = new URL('./mobile-next-update.mjs', import.meta.url).pathname
const workflowText = readFileSync(WORKFLOW_URL, 'utf8')
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

const validAppConfig = `
const MIKKA_EAS_PROJECT_ID = "902ffab1-ed16-482e-8b83-2b7535079810";
export const MIKKA_NEXT_RUNTIME_VERSION = "mikka-next-1";
export const MIKKA_NEXT_UPDATES_CHANNEL = "next";
const config = {
  runtimeVersion: APP_VARIANT === "development" ? { policy: "appVersion" } : MIKKA_NEXT_RUNTIME_VERSION,
  updates: {
    url: \`https://u.expo.dev/\${MIKKA_EAS_PROJECT_ID}\`,
    requestHeaders: { "expo-channel-name": MIKKA_NEXT_UPDATES_CHANNEL },
  },
  ios: {
    bundleIdentifier: "com.aspectlylabs.mikka",
  },
};
`

const validEasJson = JSON.stringify({
  cli: { version: '>= 18.4.0' },
  build: {
    next: {
      channel: 'next',
      env: { APP_VARIANT: 'production' },
    },
  },
})

const validResolvedExpoConfig = JSON.stringify({
  name: 'Mikka',
  slug: 'mikka',
  runtimeVersion: 'mikka-next-1',
  updates: {
    enabled: true,
    url: 'https://u.expo.dev/902ffab1-ed16-482e-8b83-2b7535079810',
    requestHeaders: { 'expo-channel-name': 'next' },
  },
  ios: {
    bundleIdentifier: 'com.aspectlylabs.mikka',
  },
})

function stepBlock(name) {
  const marker = `- name: ${name}`
  const start = workflowText.indexOf(marker)
  assert.ok(start >= 0, `missing workflow step: ${name}`)
  const next = workflowText.indexOf('\n      - ', start + marker.length)
  return workflowText.slice(start, next < 0 ? workflowText.length : next)
}

function extractStepRun(name) {
  const block = stepBlock(name)
  const runStart = block.indexOf('run: |\n')
  assert.ok(runStart >= 0, `missing multiline run block in ${name}`)
  return block
    .slice(runStart + 'run: |\n'.length)
    .split('\n')
    .map(line => line.replace(/^ {10}/, ''))
    .join('\n')
}

test('validateHostedUiRef admits only main or a full 40-char lowercase commit SHA', () => {
  assert.equal(validateHostedUiRef(undefined), 'main')
  assert.equal(validateHostedUiRef(''), 'main')
  assert.equal(validateHostedUiRef('main'), 'main')
  assert.equal(validateHostedUiRef(SHA), SHA)
  for (const bad of [
    'HEAD',
    'refs/heads/main',
    'feature/test',
    'A'.repeat(40),
    'a'.repeat(39),
    'a'.repeat(41),
    ' main',
    'main ',
    '--upload-pack=sh',
    '../main',
  ]) {
    assert.throws(() => validateHostedUiRef(bad), /mobileNextUpdate:invalidHostedUiRef/, String(bad))
  }
})

test('formatUpdateMessage defaults to the resolved SHA and rejects control characters or oversized text', () => {
  assert.equal(formatUpdateMessage('', SHA), `mobile-next OTA (${SHA.slice(0, 12)})`)
  assert.equal(formatUpdateMessage('   ', SHA), `mobile-next OTA (${SHA.slice(0, 12)})`)
  assert.equal(formatUpdateMessage('  Sign-in redesign  ', SHA), 'Sign-in redesign')
  assert.throws(() => formatUpdateMessage('line1\nline2', SHA), /mobileNextUpdate:invalidMessage/)
  assert.throws(() => formatUpdateMessage('x'.repeat(201), SHA), /mobileNextUpdate:invalidMessage/)
  assert.throws(() => formatUpdateMessage('ok', 'main'), /mobileNextUpdate:invalidOverlaySha/)
})

test('verifyMobileNextConfig enforces next channel, mikka-next-* runtime isolation, and rejects ios.runtimeVersion overrides', () => {
  assert.deepEqual(verifyMobileNextConfig(validAppConfig, validEasJson), {
    channel: 'next',
    runtimeVersion: 'mikka-next-1',
  })
  assert.throws(
    () => verifyMobileNextConfig(validAppConfig.replace('"next"', '"production"'), validEasJson),
    /mobileNextUpdate:channelMustBeNext/,
  )
  assert.throws(
    () => verifyMobileNextConfig(validAppConfig.replace('"mikka-next-1"', '"1.0.0"'), validEasJson),
    /mobileNextUpdate:runtimeVersionInvalid/,
  )
  assert.throws(
    () => verifyMobileNextConfig(
      validAppConfig.replace('bundleIdentifier: "com.aspectlylabs.mikka",', 'bundleIdentifier: "com.aspectlylabs.mikka",\n    runtimeVersion: "1.0.0",'),
      validEasJson,
    ),
    /mobileNextUpdate:iosRuntimeVersionOverrideForbidden/,
  )
  assert.throws(
    () => verifyMobileNextConfig(validAppConfig.replace('"expo-channel-name": MIKKA_NEXT_UPDATES_CHANNEL', '"expo-channel-name": "production"'), validEasJson),
    /mobileNextUpdate:appConfigIsolationInvalid/,
  )
  assert.throws(
    () => verifyMobileNextConfig(validAppConfig, JSON.stringify({ build: { next: { channel: 'production', env: { APP_VARIANT: 'production' } } } })),
    /mobileNextUpdate:easConfigIsolationInvalid/,
  )
  assert.throws(
    () => verifyMobileNextConfig(validAppConfig, JSON.stringify({ build: { next: { channel: 'next', env: { APP_VARIANT: 'development' } } } })),
    /mobileNextUpdate:easConfigIsolationInvalid/,
  )
})

test('verifyResolvedExpoConfig rejects dynamic ios.runtimeVersion overrides, wrong channels, and disabled updates', () => {
  assert.deepEqual(
    verifyResolvedExpoConfig(validResolvedExpoConfig, { expectedRuntimeVersion: 'mikka-next-1' }),
    { channel: 'next', runtimeVersion: 'mikka-next-1', bundleIdentifier: 'com.aspectlylabs.mikka' },
  )
  const withIosOverride = JSON.stringify({
    ...JSON.parse(validResolvedExpoConfig),
    ios: { bundleIdentifier: 'com.aspectlylabs.mikka', runtimeVersion: 'legacy-prod-1' },
  })
  assert.throws(
    () => verifyResolvedExpoConfig(withIosOverride, { expectedRuntimeVersion: 'mikka-next-1' }),
    /mobileNextUpdate:resolvedRuntimeVersionMismatch/,
  )
  const wrongChannel = JSON.stringify({
    ...JSON.parse(validResolvedExpoConfig),
    updates: { enabled: true, requestHeaders: { 'expo-channel-name': 'production' } },
  })
  assert.throws(
    () => verifyResolvedExpoConfig(wrongChannel, { expectedRuntimeVersion: 'mikka-next-1' }),
    /mobileNextUpdate:resolvedChannelMismatch/,
  )
  const disabled = JSON.stringify({
    ...JSON.parse(validResolvedExpoConfig),
    updates: { enabled: false, requestHeaders: { 'expo-channel-name': 'next' } },
  })
  assert.throws(
    () => verifyResolvedExpoConfig(disabled, { expectedRuntimeVersion: 'mikka-next-1' }),
    /mobileNextUpdate:updatesDisabled/,
  )
})

test('verifyChannelMapping unwraps currentPage responses, permits dedicated next branch, and rejects production overlap or missing prod proof', () => {
  const page = channel => JSON.stringify({ currentPage: channel })
  const nextClean = page({
    id: 'ch-next',
    name: 'next',
    branchMapping: JSON.stringify({ version: 0, data: [{ branchId: 'br-next', branchMappingLogic: 'true' }] }),
    updateBranches: [{ id: 'br-next', name: 'next' }],
  })
  const prodClean = page({
    id: 'ch-prod',
    name: 'production',
    branchMapping: JSON.stringify({ version: 0, data: [{ branchId: 'br-prod', branchMappingLogic: 'true' }] }),
    updateBranches: [{ id: 'br-prod', name: 'production' }],
  })
  assert.deepEqual(
    verifyChannelMapping(nextClean, { productionChannelRaw: prodClean }),
    { channel: 'next', branch: 'next' },
  )
  // Also accept unwrapped legacy objects when present.
  assert.deepEqual(
    verifyChannelMapping(JSON.stringify(JSON.parse(nextClean).currentPage), {
      productionChannelRaw: JSON.stringify(JSON.parse(prodClean).currentPage),
    }),
    { channel: 'next', branch: 'next' },
  )
  assert.throws(
    () => verifyChannelMapping(nextClean, { productionChannelRaw: null }),
    /mobileNextUpdate:productionChannelRequired/,
  )

  const nextToProd = page({
    id: 'ch-next',
    name: 'next',
    branchMapping: JSON.stringify({ version: 0, data: [{ branchId: 'br-prod', branchMappingLogic: 'true' }] }),
    updateBranches: [{ id: 'br-prod', name: 'production' }],
  })
  assert.throws(
    () => verifyChannelMapping(nextToProd, { productionChannelRaw: prodClean }),
    /mobileNextUpdate:forbiddenBranch/,
  )

  const prodSharingNext = page({
    id: 'ch-prod',
    name: 'production',
    branchMapping: JSON.stringify({ version: 0, data: [{ branchId: 'br-next', branchMappingLogic: 'true' }] }),
    updateBranches: [{ id: 'br-next', name: 'next' }],
  })
  assert.throws(
    () => verifyChannelMapping(nextClean, { productionChannelRaw: prodSharingNext }),
    /mobileNextUpdate:branchSharedWithProduction/,
  )

  const splitMapping = page({
    id: 'ch-next',
    name: 'next',
    branchMapping: JSON.stringify({
      version: 0,
      data: [
        { branchId: 'br-next', branchMappingLogic: 'true' },
        { branchId: 'br-other', branchMappingLogic: 'false' },
      ],
    }),
    updateBranches: [{ id: 'br-next', name: 'next' }, { id: 'br-other', name: 'canary' }],
  })
  assert.throws(
    () => verifyChannelMapping(splitMapping, { productionChannelRaw: prodClean }),
    /mobileNextUpdate:ambiguousBranchMapping/,
  )
})

test('parseEasUpdateOutput handles array and object JSON shapes, verifies isolation, and emits only public-safe fields', () => {
  const arrayPayload = JSON.stringify([
    {
      id: '11111111-2222-4333-8444-555555555555',
      group: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      runtimeVersion: 'mikka-next-1',
      platform: 'ios',
      branch: 'next',
      createdAt: '2026-11-25T00:50:00.000Z',
      message: 'private internal details must not be re-emitted',
    },
  ])
  const parsedArray = parseEasUpdateOutput(`Metro preamble line\n${arrayPayload}\n`, {
    expectedBranch: 'next',
    expectedRuntimeVersion: 'mikka-next-1',
    overlaySha: SHA,
  })
  assert.deepEqual(parsedArray, {
    updateGroupId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    updateId: '11111111-2222-4333-8444-555555555555',
    channel: 'next',
    branch: 'next',
    runtimeVersion: 'mikka-next-1',
    platform: 'ios',
    overlaySha: SHA,
    createdAt: '2026-11-25T00:50:00.000Z',
  })
  assert.ok(!JSON.stringify(parsedArray).includes('private internal details'))
  const md = formatStepSummary(parsedArray)
  assert.ok(md.includes('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'))
  assert.ok(md.includes('mikka-next-1'))
  assert.ok(md.includes(SHA))

  const objectPayload = JSON.stringify({
    group: '99999999-8888-4777-8666-555555555555',
    runtimeVersion: 'mikka-next-1',
    branch: 'next',
    updates: [{ id: '12345678-1234-4123-8123-1234567890ab', platform: 'ios', runtimeVersion: 'mikka-next-1' }],
  })
  const parsedObject = parseEasUpdateOutput(objectPayload, {
    expectedBranch: 'next',
    expectedRuntimeVersion: 'mikka-next-1',
    overlaySha: SHA,
  })
  assert.equal(parsedObject.updateGroupId, '99999999-8888-4777-8666-555555555555')

  assert.throws(
    () => parseEasUpdateOutput(arrayPayload, { expectedRuntimeVersion: 'mikka-next-2', overlaySha: SHA }),
    /mobileNextUpdate:runtimeVersionMismatch/,
  )
  assert.throws(
    () => parseEasUpdateOutput(arrayPayload.replace('"next"', '"production"'), { expectedRuntimeVersion: 'mikka-next-1', overlaySha: SHA }),
    /mobileNextUpdate:forbiddenBranch/,
  )
  assert.throws(
    () => parseEasUpdateOutput(arrayPayload, { expectedBranch: 'canary', expectedRuntimeVersion: 'mikka-next-1', overlaySha: SHA }),
    /mobileNextUpdate:branchMismatch/,
  )
  assert.throws(
    () => parseEasUpdateOutput(arrayPayload.replace('"ios"', '"android"'), { expectedRuntimeVersion: 'mikka-next-1', overlaySha: SHA }),
    /mobileNextUpdate:platformMissing/,
  )
})

test('CLI subcommands verify config, resolved config, channel mapping, messages, and EAS summaries cleanly', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-next-update-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'app.config.ts'), validAppConfig)
  writeFileSync(join(dir, 'eas.json'), validEasJson)
  const envFile = join(dir, 'github-env')
  const summaryFile = join(dir, 'github-summary')
  const expoCfgFile = join(dir, 'expo-config.json')
  const nextChFile = join(dir, 'next-ch.json')
  const prodChFile = join(dir, 'prod-ch.json')
  const easJsonFile = join(dir, 'eas-update.json')
  writeFileSync(expoCfgFile, validResolvedExpoConfig)
  writeFileSync(nextChFile, JSON.stringify({
    name: 'next',
    branchMapping: JSON.stringify({ version: 0, data: [{ branchId: 'b1', branchMappingLogic: 'true' }] }),
    updateBranches: [{ id: 'b1', name: 'next' }],
  }))
  writeFileSync(prodChFile, JSON.stringify({
    name: 'production',
    branchMapping: JSON.stringify({ version: 0, data: [{ branchId: 'b2', branchMappingLogic: 'true' }] }),
    updateBranches: [{ id: 'b2', name: 'production' }],
  }))
  writeFileSync(easJsonFile, JSON.stringify([{
    id: '11111111-2222-4333-8444-555555555555',
    group: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    runtimeVersion: 'mikka-next-1',
    platform: 'ios',
    branch: 'next',
    createdAt: '2026-11-25T00:50:00.000Z',
  }]))

  const verified = JSON.parse(execFileSync(process.execPath, [HELPER_PATH, 'verify-config', dir], {
    env: { ...process.env, GITHUB_ENV: envFile },
    encoding: 'utf8',
  }))
  assert.deepEqual(verified, { channel: 'next', runtimeVersion: 'mikka-next-1' })
  assert.equal(readFileSync(envFile, 'utf8'), 'MOBILE_NEXT_CHANNEL=next\nMOBILE_NEXT_RUNTIME_VERSION=mikka-next-1\n')

  const resolved = JSON.parse(execFileSync(process.execPath, [HELPER_PATH, 'verify-resolved-config', expoCfgFile], {
    env: { ...process.env, EAS_CHANNEL: 'next', MOBILE_NEXT_RUNTIME_VERSION: 'mikka-next-1' },
    encoding: 'utf8',
  }))
  assert.equal(resolved.runtimeVersion, 'mikka-next-1')

  const verifiedBranch = execFileSync(process.execPath, [HELPER_PATH, 'verify-channel', nextChFile, prodChFile], {
    env: { ...process.env, EAS_CHANNEL: 'next' },
    encoding: 'utf8',
  })
  assert.equal(verifiedBranch, 'next')

  const msg = execFileSync(process.execPath, [HELPER_PATH, 'format-message'], {
    env: { ...process.env, UPDATE_MESSAGE: '', OVERLAY_SHA: SHA },
    encoding: 'utf8',
  })
  assert.equal(msg, `mobile-next OTA (${SHA.slice(0, 12)})`)

  const summary = JSON.parse(execFileSync(process.execPath, [HELPER_PATH, 'summarize', easJsonFile], {
    env: {
      ...process.env,
      EAS_CHANNEL: 'next',
      VERIFIED_EAS_BRANCH: 'next',
      MOBILE_NEXT_RUNTIME_VERSION: 'mikka-next-1',
      OVERLAY_SHA: SHA,
      GITHUB_STEP_SUMMARY: summaryFile,
    },
    encoding: 'utf8',
  }))
  assert.equal(summary.updateGroupId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  assert.equal(summary.branch, 'next')
  assert.ok(readFileSync(summaryFile, 'utf8').includes('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'))
})

test('workflow publish step enforces currentPage channel isolation before publishing and succeeds on dedicated next branch', t => {
  const publishScript = extractStepRun('Publish EAS Update to next channel')
  const workspaceRoot = new URL('../../', import.meta.url).pathname

  function runPublishFixture(mode) {
    const dir = mkdtempSync(join(tmpdir(), `mobile-next-publish-${mode}-`))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const binDir = join(dir, 'bin')
    const runnerTemp = join(dir, 'temp')
    const logFile = join(dir, 'npx-calls.log')
    const summaryFile = join(dir, 'summary.md')
    execFileSync('mkdir', ['-p', binDir, runnerTemp])
    const fakeNpx = join(binDir, 'npx')
    writeFileSync(fakeNpx, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${logFile}"
if [[ "$*" == *"channel:view next"* ]]; then
  if [[ "${mode}" == "next-to-prod" ]]; then
    echo '{"currentPage":{"id":"ch-next","name":"next","branchMapping":"{\\"version\\":0,\\"data\\":[{\\"branchId\\":\\"b-prod\\",\\"branchMappingLogic\\":\\"true\\"}]}","updateBranches":[{"id":"b-prod","name":"production"}]}}'
  else
    echo '{"currentPage":{"id":"ch-next","name":"next","branchMapping":"{\\"version\\":0,\\"data\\":[{\\"branchId\\":\\"b-next\\",\\"branchMappingLogic\\":\\"true\\"}]}","updateBranches":[{"id":"b-next","name":"next"}]}}'
  fi
  exit 0
fi
if [[ "$*" == *"channel:view production"* ]]; then
  if [[ "${mode}" == "prod-fail" ]]; then
    echo "network error" >&2
    exit 1
  fi
  echo '{"currentPage":{"id":"ch-prod","name":"production","branchMapping":"{\\"version\\":0,\\"data\\":[{\\"branchId\\":\\"b-prod\\",\\"branchMappingLogic\\":\\"true\\"}]}","updateBranches":[{"id":"b-prod","name":"production"}]}}'
  exit 0
fi
if [[ "$*" == *" update "* ]]; then
  echo '[{"id":"11111111-2222-4333-8444-555555555555","group":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","runtimeVersion":"mikka-next-1","platform":"ios","branch":"next","createdAt":"2026-11-25T01:10:00.000Z"}]'
  exit 0
fi
echo "unexpected npx call: $*" >&2
exit 99
`)
    chmodSync(fakeNpx, 0o755)
    const run = () => execFileSync('bash', ['--noprofile', '--norc', '-c', publishScript], {
      env: {
        PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
        RUNNER_TEMP: runnerTemp,
        GITHUB_WORKSPACE: workspaceRoot,
        GITHUB_STEP_SUMMARY: summaryFile,
        EAS_CHANNEL: 'next',
        EAS_CLI_VERSION: '27.2.0',
        MOBILE_NEXT_RUNTIME_VERSION: 'mikka-next-1',
        OVERLAY_SHA: SHA,
        UPDATE_MESSAGE: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { run, logFile, summaryFile }
  }

  // Negative 1: next -> production mapping prevents eas update invocation.
  const badMap = runPublishFixture('next-to-prod')
  assert.throws(badMap.run)
  const badMapCalls = readFileSync(badMap.logFile, 'utf8')
  assert.ok(badMapCalls.includes('channel:view next'))
  assert.ok(!badMapCalls.includes(' update '), 'eas update must never be invoked when next maps to production')

  // Negative 2: failed production channel lookup fails closed before eas update.
  const prodFail = runPublishFixture('prod-fail')
  assert.throws(prodFail.run)
  const prodFailCalls = readFileSync(prodFail.logFile, 'utf8')
  assert.ok(prodFailCalls.includes('channel:view production'))
  assert.ok(!prodFailCalls.includes(' update '), 'eas update must never be invoked when production channel lookup fails')

  // Positive: valid currentPage responses publish explicitly to --branch next and emit summary.
  const ok = runPublishFixture('ok')
  const stdout = ok.run()
  const okCalls = readFileSync(ok.logFile, 'utf8')
  assert.ok(okCalls.includes('update --branch next --platform ios --message mobile-next OTA (' + SHA.slice(0, 12) + ') --non-interactive --json'))
  const parsed = JSON.parse(stdout.trim())
  assert.equal(parsed.updateGroupId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  assert.equal(parsed.branch, 'next')
  assert.equal(parsed.channel, 'next')
  assert.equal(parsed.runtimeVersion, 'mikka-next-1')
  assert.equal(parsed.overlaySha, SHA)
  assert.ok(readFileSync(ok.summaryFile, 'utf8').includes('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'))
})

test('mobile-next-update.yml enforces fail-closed repo/main guard, pinned actions, step ordering, and next-channel isolation', () => {
  // Dispatch-only trigger on ubuntu-24.04 with main-only trusted repo guard.
  assert.match(workflowText, /^on:\n  workflow_dispatch:\n/m)
  assert.ok(!workflowText.includes('\n  pull_request:'), 'workflow must not trigger on pull_request')
  assert.ok(!workflowText.includes('\n  push:'), 'workflow must not trigger on push')
  assert.ok(workflowText.includes('runs-on: ubuntu-24.04'))
  assert.ok(workflowText.includes('EAS_CHANNEL: next'))

  const guardMatch = /if:\s*>-\n\s+([^\n]+)/.exec(workflowText)
  assert.ok(guardMatch, 'job must declare an explicit repository + main guard')
  const allowed = new Function('github', `return ${guardMatch[1]}`)
  for (const [repository, repository_owner_id, repository_id, ref, expected] of [
    ['aspectly-labs/Mikka', '359279274', '1427517699', 'refs/heads/main', true],
    ['alexj11324/Mikka', '183887963', '1427517699', 'refs/heads/main', true],
    ['aspectly-labs/Mikka', '359279274', '1427517699', 'refs/heads/feature', false],
    ['aspectly-labs/Mikka', '183887963', '1427517699', 'refs/heads/main', false],
    ['alexj11324/Mikka', '359279274', '1427517699', 'refs/heads/main', false],
    ['foreign/Mikka', '359279274', '1427517699', 'refs/heads/main', false],
    ['aspectly-labs/Mikka', '359279274', '9999999999', 'refs/heads/main', false],
  ]) {
    assert.equal(
      allowed({ repository, repository_owner_id, repository_id, ref }),
      expected,
      `${repository}:${repository_owner_id}:${repository_id}:${ref}`,
    )
  }

  assert.ok(!workflowText.includes('--channel production'), 'workflow must never target production channel')
  assert.ok(!workflowText.includes('--branch production'), 'workflow must never target production branch')

  // Every remote action must be pinned to a full 40-char commit SHA.
  const usesMatches = [...workflowText.matchAll(/^\s+(?:-\s+)?uses:\s+([^\s#]+)/gm)]
  assert.ok(usesMatches.length >= 6, 'expected pinned checkout, Infisical, pnpm, and setup-node actions')
  for (const [, actionRef] of usesMatches) {
    if (!actionRef.startsWith('./')) {
      assert.match(actionRef, /^[^@]+@[0-9a-f]{40}$/, `action must be pinned to 40-char SHA: ${actionRef}`)
    }
  }

  // Verify strict fail-closed step order (OIDC credential custody itself is owned by mobile-ota-credentials.test.mjs).
  const orderedSteps = [
    'Validate dispatch inputs',
    'Verify the OTA credential and isolation boundary before credential access',
    'Validate the selected private UI owner before credential access',
    'Read existing HOSTED_UI_READ_KEY through OIDC',
    'Check out the private app revision',
    'Resolve and verify the private revision is on main',
    'Pin the private UI revision',
    'Verify mobile-next layout and next-channel isolation',
    'Install mobile-next dependencies',
    'Verify mobile-next resolved config, typecheck and tests',
    'Read existing EXPO_TOKEN through OIDC',
    'Require the authorized Expo credential',
    'Publish EAS Update to next channel',
    'Clear credentials and temporary logs',
  ]
  let previousIndex = -1
  for (const name of orderedSteps) {
    const idx = workflowText.indexOf(`- name: ${name}`)
    assert.ok(idx > previousIndex, `step out of order or missing: ${name}`)
    previousIndex = idx
  }

  // Verify private checkout isolation, verifyOverlayMain, recordOverlay scrub, and resolved config verification.
  const checkout = stepBlock('Check out the private app revision')
  for (const required of ['path: .hosted-ui', 'ref: ${{ env.HOSTED_UI_REF }}', 'ssh-key: ${{ env.HOSTED_UI_READ_KEY }}', 'persist-credentials: false']) {
    assert.ok(checkout.includes(required), `checkout missing ${required}`)
  }
  assert.ok(!checkout.includes('token:'))

  const verifyMain = stepBlock('Resolve and verify the private revision is on main')
  assert.ok(verifyMain.includes('verifyOverlayMain'))
  assert.ok(verifyMain.includes('github-known-hosts'))
  assert.ok(stepBlock('Pin the private UI revision').includes('node scripts/release/hosted-ui.mjs record .hosted-ui'))

  const resolvedStep = stepBlock('Verify mobile-next resolved config, typecheck and tests')
  assert.ok(resolvedStep.includes('APP_VARIANT: production'))
  assert.ok(resolvedStep.includes('expo config --type public --json'))
  assert.ok(resolvedStep.includes('verify-resolved-config'))

  // Verify publish step verifies channel->branch mapping BEFORE publishing explicitly to --branch "$verified_branch".
  const publish = stepBlock('Publish EAS Update to next channel')
  for (const required of [
    'working-directory: .hosted-ui/mobile-next/apps/mobile',
    'APP_VARIANT: production',
    '[[ "$EAS_CHANNEL" == "next" ]]',
    'eas-cli@${EAS_CLI_VERSION}',
    'channel:view "$EAS_CHANNEL"',
    'channel:create "$EAS_CHANNEL"',
    'channel:view production',
    'mobile-next-update.mjs" verify-channel',
    '--branch "$verified_branch"',
    '--platform ios',
    '--non-interactive',
    '--json',
    'mobile-next-update.mjs" summarize',
  ]) {
    assert.ok(publish.includes(required), `publish step missing ${required}`)
  }
  assert.ok(
    publish.indexOf('verify-channel') < publish.indexOf('--branch "$verified_branch"'),
    'channel mapping verification must precede eas update invocation',
  )

  const cleanup = stepBlock('Clear credentials and temporary logs')
  assert.ok(cleanup.includes('if: always()'))
  assert.ok(cleanup.includes("echo 'HOSTED_UI_READ_KEY='"))
  assert.ok(cleanup.includes("echo 'EXPO_TOKEN='"))
  assert.ok(cleanup.includes('expo-config.json'))
})
