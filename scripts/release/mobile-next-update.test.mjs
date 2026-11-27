import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  formatStepSummary,
  formatUpdateMessage,
  mobilePolicyMode,
  parseEasUpdateOutput,
  readOperationsPolicy,
  requirePromoterDispatch,
  requirePhaseAllowed,
  stageReceipt,
  STAGING_BRANCH,
  validateHostedUiRef,
  validatePhase,
  verifiedStage,
  verifyChannelMapping,
  verifyMobileNextConfig,
  verifyResolvedExpoConfig,
  verifyStagedGroup,
  verifyStagingTarget,
} from './mobile-next-update.mjs'
import { committedPromoters } from './release-policy.mjs'

const PROMOTERS = committedPromoters()
const promotersFile = JSON.parse(readFileSync(new URL('../../config/release-promoters.json', import.meta.url), 'utf8')).promoters
const POLICY = { version: 1, autoProduction: false, mobileProduction: false, promoters: promotersFile,
  requiredChecks: { production: [], desktop: [], mobile: [] } }

const WORKFLOW_URL = new URL('../../.github/workflows/mobile-next-update.yml', import.meta.url)
const HELPER_PATH = new URL('./mobile-next-update.mjs', import.meta.url).pathname
const workflowText = readFileSync(WORKFLOW_URL, 'utf8')
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

const RUNTIME_CONST = ['MIKKA_NEXT', 'RUNTIME_VERSION'].join('_')

const validAppConfig = `
const MIKKA_EAS_PROJECT_ID = "902ffab1-ed16-482e-8b83-2b7535079810";
export const ${RUNTIME_CONST} = "mikka-next-1";
export const MIKKA_NEXT_UPDATES_CHANNEL = "next";
const config = {
  runtimeVersion: APP_VARIANT === "development" ? { policy: "appVersion" } : ${RUNTIME_CONST},
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
  assert.equal(readFileSync(envFile, 'utf8'), 'MOBILE_OTA_CHANNEL=next\nMOBILE_OTA_RUNTIME_VERSION=mikka-next-1\n')

  const resolved = JSON.parse(execFileSync(process.execPath, [HELPER_PATH, 'verify-resolved-config', expoCfgFile], {
    env: { ...process.env, EAS_CHANNEL: 'next', MOBILE_OTA_RUNTIME_VERSION: 'mikka-next-1' },
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
      MOBILE_OTA_RUNTIME_VERSION: 'mikka-next-1',
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
        MOBILE_OTA_RUNTIME_VERSION: 'mikka-next-1',
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
  const allowed = github => new Function('github', 'inputs', 'contains', 'fromJSON', `return ${guardMatch[1]}`)(github, {}, () => false, JSON.parse)
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

const channel = (name, branches) => JSON.stringify({ currentPage: { id: 'ch-' + name, name,
  branchMapping: JSON.stringify({ version: 0, data: branches.map(branch => ({ branchId: 'b-' + branch, branchMappingLogic: 'true' })) }),
  updateBranches: branches.map(branch => ({ id: 'b-' + branch, name: branch })) } })

test('mobileProduction false pauses direct OTA publication: only staging and an owner promotion remain', () => {
  assert.equal(mobilePolicyMode({ version: 1, autoProduction: false, mobileProduction: true }), 'automatic')
  assert.equal(mobilePolicyMode({ version: 1, autoProduction: false, mobileProduction: false }), 'manual')
  for (const policy of [null, {}, [], { version: 1 }, { version: 2, mobileProduction: true }, { version: 1, mobileProduction: 'true' }])
    assert.equal(mobilePolicyMode(policy), 'unreadable', JSON.stringify(policy))
  assert.equal(validatePhase(undefined), 'stage')
  assert.equal(validatePhase(''), 'stage')
  assert.throws(() => validatePhase('production'), /invalidPhase/)
  for (const mode of ['automatic', 'manual', 'unreadable']) requirePhaseAllowed('stage', mode)
  requirePhaseAllowed('publish', 'automatic')
  assert.throws(() => requirePhaseAllowed('publish', 'manual'), /productionOtaPaused/)
  assert.throws(() => requirePhaseAllowed('publish', 'unreadable'), /productionPolicyUnreadable/)
  requirePhaseAllowed('promote', 'automatic')
  requirePhaseAllowed('promote', 'manual')
  assert.throws(() => requirePhaseAllowed('promote', 'unreadable'), /productionPolicyUnreadable/)
  const checked = { promoters: PROMOTERS }
  const dispatch = (id, login, triggering = login) => ({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTOR_ID: id, GITHUB_ACTOR: login, GITHUB_TRIGGERING_ACTOR: triggering })
  requirePromoterDispatch(dispatch('183887963', 'alexj11324'), checked)
  requirePromoterDispatch(dispatch('158243242', 'devin-ai-integration[bot]'), checked)
  for (const env of [dispatch('118344674', 'github-merge-queue[bot]'), dispatch('7', 'outsider'), dispatch('158243242', 'devin-ai-integration[bot]', 'outsider'),
    dispatch('183887963', 'renamed'), { ...dispatch('183887963', 'alexj11324'), GITHUB_EVENT_NAME: 'push' }, {}])
    assert.throws(() => requirePromoterDispatch(env, checked), /dispatchNeedsPromoter/, JSON.stringify(env))
  assert.throws(() => requirePromoterDispatch(dispatch('183887963', 'alexj11324'), undefined), /dispatchNeedsPromoter/)
})

test('the release policy is read from private main and every read failure counts as unreadable', async () => {
  const record = (policy, patch = {}) => {
    const bytes = Buffer.from(JSON.stringify(policy))
    return { type: 'file', path: 'docs/operations/releases/deploy-pipeline.json', encoding: 'base64', size: bytes.length,
      content: bytes.toString('base64'), sha: createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex'), ...patch }
  }
  const seen = []
  const serve = (body, status = 200) => async (url, init) => {
    seen.push([url, init.headers.authorization])
    return Response.json(body, { status })
  }
  const token = 'ghs_fixture_token_value'
  const paused = POLICY
  assert.equal((await readOperationsPolicy({ owner: 'aspectly-labs', token, fetchImpl: serve(record(paused)) })).mode, 'manual')
  // A private list that differs from the committed public gate list admits nobody.
  assert.equal((await readOperationsPolicy({ owner: 'aspectly-labs', token,
    fetchImpl: serve(record({ ...paused, promoters: promotersFile.slice(0, 1) })) })).mode, 'unreadable')
  for (const broken of [{ ...paused, promoters: undefined }, { ...paused, requiredChecks: undefined },
    { ...paused, promoters: [...promotersFile, { id: 118344674, login: 'github-merge-queue[bot]', note: 'merge' }] }])
    assert.equal((await readOperationsPolicy({ owner: 'aspectly-labs', token, fetchImpl: serve(record(broken)) })).mode, 'unreadable')
  assert.deepEqual(seen[0], ['https://api.github.com/repos/aspectly-labs/mikka-cloud/contents/docs/operations/releases/deploy-pipeline.json?ref=main', 'Bearer ' + token])
  assert.equal((await readOperationsPolicy({ owner: 'alexj11324', token, fetchImpl: serve(record({ ...paused, mobileProduction: true })) })).mode, 'automatic')
  for (const fetchImpl of [serve(record(paused, { sha: '0'.repeat(40) })), serve(record(paused, { size: 1 })), serve(record(paused), 404),
    serve(record(paused, { type: 'dir' })), serve({ ...record(paused), content: Buffer.from('{nope').toString('base64'), size: 5,
      sha: createHash('sha1').update('blob 5\0').update('{nope').digest('hex') }), async () => { throw new Error('network') }])
    assert.equal((await readOperationsPolicy({ owner: 'aspectly-labs', token, fetchImpl })).mode, 'unreadable')
  seen.length = 0
  for (const options of [{ owner: 'someone-else', token }, { owner: 'aspectly-labs', token: '' }, { owner: 'aspectly-labs' }])
    assert.equal((await readOperationsPolicy({ ...options, fetchImpl: serve(record(paused)) })).mode, 'unreadable')
  assert.equal(seen.length, 0, 'no request without an allowed owner and token')
  // The CLI exits non-zero for publish without a readable policy, and allows a stage with none.
  const cli = phase => execFileSync(process.execPath, [HELPER_PATH, 'policy', phase], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  assert.throws(() => cli('publish'))
  assert.throws(() => cli('promote'))
  assert.deepEqual(JSON.parse(cli('stage')), { phase: 'stage', mode: 'unreadable' })
})

test('a staged update lands only on a branch that no user channel serves', () => {
  assert.deepEqual(verifyStagingTarget(channel('next', ['next']), channel('production', ['production'])), { branch: STAGING_BRANCH, nextBranch: 'next' })
  assert.throws(() => verifyStagingTarget(channel('next', [STAGING_BRANCH]), channel('production', ['production'])), /stagingBranchServesUsers/)
  assert.throws(() => verifyStagingTarget(channel('next', ['next']), channel('production', ['production', STAGING_BRANCH])), /stagingBranchServesUsers/)
  assert.throws(() => verifyStagingTarget(channel('next', ['production']), channel('production', ['production'])))
  const summary = { updateGroupId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', branch: STAGING_BRANCH, platform: 'ios', runtimeVersion: 'mikka-next-1', overlaySha: SHA }
  assert.deepEqual(stageReceipt(summary, { runId: '77', runAttempt: '1' }), { version: 1, phase: 'stage', runId: '77', runAttempt: '1',
    branch: STAGING_BRANCH, platform: 'ios', runtimeVersion: 'mikka-next-1', overlaySha: SHA, updateGroupId: summary.updateGroupId })
  assert.throws(() => stageReceipt({ ...summary, branch: 'next' }, { runId: '77', runAttempt: '1' }), /stageBranchMismatch/)
})

function stageFixture(change = {}) {
  const repository = { id: 1427517699, full_name: 'aspectly-labs/Mikka', fork: false }
  const run = { id: 77, run_attempt: 1, path: '.github/workflows/mobile-next-update.yml', event: 'workflow_dispatch', head_branch: 'main',
    status: 'completed', conclusion: 'success', head_sha: 'c'.repeat(40), repository, head_repository: repository,
    actor: { id: 158243242, login: 'devin-ai-integration[bot]' }, triggering_actor: { id: 158243242, login: 'devin-ai-integration[bot]' }, ...change.run }
  const receipt = { version: 1, phase: 'stage', runId: '77', runAttempt: '1', branch: STAGING_BRANCH, platform: 'ios',
    runtimeVersion: 'mikka-next-1', overlaySha: SHA, updateGroupId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ...change.receipt }
  const bytes = execFileSync('python3', ['-c', 'import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z: z.writestr("receipt.json",sys.argv[1])\nsys.stdout.buffer.write(b.getvalue())', JSON.stringify(receipt)])
  const artifact = { id: 901, name: change.artifactName ?? 'mobile-ota-stage-77-1', expired: false, size_in_bytes: bytes.length,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    workflow_run: { id: 77, head_sha: run.head_sha, head_branch: 'main', repository_id: 1427517699, head_repository_id: 1427517699 } }
  const read = async path => {
    if (path === 'actions/runs/77') return run
    if (path === 'actions/runs/77/artifacts?per_page=100') return { total_count: 1, artifacts: [artifact] }
    if (path === 'actions/artifacts/901/zip') return bytes
    if (path === `compare/${run.head_sha}...main`) return { status: change.compare ?? 'ahead', merge_base_commit: { sha: run.head_sha } }
    assert.fail('unexpected read ' + path)
  }
  return { read, stageRun: change.stageRun ?? '77', hostedUiRef: change.hostedUiRef ?? SHA, checked: { promoters: PROMOTERS } }
}

test('a promoter promotion republishes only an update group a promoter staged from that exact commit on main', async () => {
  assert.deepEqual(await verifiedStage(stageFixture()), { runId: '77', runAttempt: '1', updateGroupId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    runtimeVersion: 'mikka-next-1', overlaySha: SHA })
  for (const [change, code] of [
    [{ stageRun: '' }, /stageRunRequired/],
    [{ hostedUiRef: 'main' }, /promoteNeedsExactSha/],
    [{ hostedUiRef: 'f'.repeat(40) }, /stageOverlayMismatch/],
    [{ run: { conclusion: 'failure' } }, /stageRunUnsuccessful/],
    [{ run: { status: 'in_progress' } }, /stageRunUnsuccessful/],
    [{ run: { head_branch: 'feature' } }, /stageRunUnsuccessful/],
    [{ run: { path: '.github/workflows/mobile-next-ios.yml' } }, /stageRunUnsuccessful/],
    [{ run: { event: 'push' } }, /stageRunUnsuccessful/],
    [{ run: { repository: { id: 1, full_name: 'fork/Mikka', fork: true } } }, /stageRunRepository/],
    [{ artifactName: 'mobile-ota-stage-76-1' }, /stageReceiptMissing/],
    [{ receipt: { phase: 'publish' } }, /stageReceiptInvalid/],
    [{ receipt: { branch: 'next' } }, /stageReceiptInvalid/],
    [{ receipt: { runId: '76' } }, /stageReceiptInvalid/],
    [{ receipt: { runtimeVersion: 'mikka-1' } }, /stageReceiptInvalid/],
    [{ run: { actor: { id: 7, login: 'outsider' } } }, /stageRunNotPromoter/],
    [{ run: { triggering_actor: { id: 7, login: 'outsider' } } }, /stageRunNotPromoter/],
    [{ compare: 'diverged' }, /stageRunOffMain/],
  ]) await assert.rejects(verifiedStage(stageFixture(change)), code, JSON.stringify(change))
})

test('workflow phases: staging never reaches users, publish and promote are promoter-only, promote republishes the staged group', t => {
  const guard = /if:\s*>-\n\s+([^\n]+)\n\s+([^\n]+)/.exec(workflowText)
  const allowed = (github, inputs) => new Function('github', 'inputs', 'contains', 'fromJSON', `return ${guard[1]} ${guard[2]}`)(
    github, inputs, (list, item) => list.includes(item), JSON.parse)
  const github = { repository: 'aspectly-labs/Mikka', repository_owner_id: '359279274', repository_id: '1427517699', ref: 'refs/heads/main' }
  const outsider = { actor_id: '7', actor: 'outsider', triggering_actor: 'outsider' }
  const devin = { actor_id: '158243242', actor: 'devin-ai-integration[bot]', triggering_actor: 'devin-ai-integration[bot]' }
  // Staging stays open to repository writers; publish and promote start only for a promoter, before any secret.
  assert.equal(allowed({ ...github, ...outsider }, { phase: 'stage' }), true)
  for (const phase of ['publish', 'promote']) {
    assert.equal(allowed({ ...github, ...outsider }, { phase }), false)
    assert.equal(allowed({ ...github, ...devin, triggering_actor: 'outsider' }, { phase }), false, 're-run by a non-promoter')
    assert.equal(allowed({ ...github, ...devin }, { phase }), true)
    assert.equal(allowed({ ...github, actor_id: '183887963', actor: 'alexj11324', triggering_actor: 'alexj11324' }, { phase }), true)
  }
  assert.ok(workflowText.includes("MOBILE_OTA_PHASE: ${{ inputs.phase || 'stage' }}"), 'a dispatch without a phase only stages')

  const order = name => { const index = workflowText.indexOf(`- name: ${name}`); assert.ok(index >= 0, name); return index }
  // The staged-update check runs before any credential; the policy read precedes the Expo credential.
  assert.ok(order('Require the reviewed mobile production policy') < order('Verify the staged update before credential access'))
  assert.ok(order('Verify the staged update before credential access') < order('Read existing HOSTED_UI_READ_KEY through OIDC'))
  assert.ok(order('Verify mobile-next resolved config, typecheck and tests') < order('Recheck the release policy and run the required mobile checks'))
  assert.ok(order('Recheck the release policy and run the required mobile checks') < order('Read existing EXPO_TOKEN through OIDC'))
  assert.match(stepBlock('Recheck the release policy and run the required mobile checks'), /policy-recheck "\$MOBILE_OTA_PHASE"\n\s+node scripts\/release\/release-checks\.mjs run mobile/)
  assert.match(stepBlock('Verify the staged update before credential access'), /if: env\.MOBILE_OTA_PHASE == 'promote'/)
  assert.match(stepBlock('Require the reviewed mobile production policy'), /if: env\.MOBILE_OTA_PHASE != 'stage'/)
  assert.match(stepBlock('Mint a short-lived read-only release policy token'), /repositories: mikka-cloud\n\s+permission-contents: read/)
  assert.match(stepBlock('Publish EAS Update to next channel'), /if: env\.MOBILE_OTA_PHASE == 'publish'/)
  assert.match(stepBlock('Stage EAS Update on the staging branch'), /if: env\.MOBILE_OTA_PHASE == 'stage'/)
  assert.match(stepBlock('Promote the staged update to next channel'), /if: env\.MOBILE_OTA_PHASE == 'promote'/)
  assert.match(stepBlock('Upload the public-safe stage receipt'), /name: mobile-ota-stage-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)

  const run = (name, mode, extraEnv = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'mobile-next-phase-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const bin = join(dir, 'bin'), temp = join(dir, 'temp'), log = join(dir, 'npx.log')
    execFileSync('mkdir', ['-p', bin, temp])
    writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
if [[ "$*" == *"channel:view next"* ]]; then echo '${mode === 'staging-serves' ? channel('next', [STAGING_BRANCH]) : channel('next', ['next'])}'; exit 0; fi
if [[ "$*" == *"channel:view production"* ]]; then echo '${channel('production', ['production'])}'; exit 0; fi
if [[ "$*" == *"update:view"* ]]; then echo '${mode === 'view-moved' ? '[{"id":"u1","group":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","branch":"next","runtimeVersion":"mikka-next-1","platform":"ios"}]' : '[{"id":"u1","group":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","branch":"next-staging","runtimeVersion":"mikka-next-1","platform":"ios"}]'}'; exit 0; fi
if [[ "$*" == *"update:republish"* ]]; then echo '[{"id":"11111111-2222-4333-8444-555555555555","group":"ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee","runtime":{"id":"rt1","version":"mikka-next-1"},"platform":"ios","branch":{"id":"b-next","name":"next"}}]'; exit 0; fi
if [[ "$*" == *" update "* ]]; then echo '[{"id":"11111111-2222-4333-8444-555555555555","group":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","runtimeVersion":"mikka-next-1","platform":"ios","branch":"${STAGING_BRANCH}"}]'; exit 0; fi
exit 99
`)
    chmodSync(join(bin, 'npx'), 0o755)
    const exec = () => execFileSync('bash', ['--noprofile', '--norc', '-c', extractStepRun(name)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: temp, GITHUB_WORKSPACE: new URL('../../', import.meta.url).pathname,
        EAS_CHANNEL: 'next', EAS_CLI_VERSION: '27.2.0', MOBILE_OTA_RUNTIME_VERSION: 'mikka-next-1', OVERLAY_SHA: SHA, UPDATE_MESSAGE: '',
        GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1', ...extraEnv } })
    return { exec, calls: () => readFileSync(log, 'utf8'), temp }
  }
  const staged = run('Stage EAS Update on the staging branch', 'ok')
  const receipt = JSON.parse(staged.exec().trim())
  assert.equal(receipt.branch, STAGING_BRANCH)
  assert.ok(staged.calls().includes(`update --branch ${STAGING_BRANCH} --platform ios`))
  assert.ok(!/update --branch next /.test(staged.calls()), 'staging never publishes to the next branch')
  assert.deepEqual(JSON.parse(readFileSync(join(staged.temp, 'mobile-ota-stage/receipt.json'), 'utf8')), receipt)
  const serving = run('Stage EAS Update on the staging branch', 'staging-serves')
  assert.throws(serving.exec)
  assert.ok(!serving.calls().includes(' update '), 'no staging publish when a user channel serves the staging branch')

  const promoted = run('Promote the staged update to next channel', 'ok', { STAGED_UPDATE_GROUP: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', STAGED_RUNTIME_VERSION: 'mikka-next-1' })
  const promotedLines = promoted.exec().trim().split('\n')
  assert.equal(JSON.parse(promotedLines[0]).branch, STAGING_BRANCH, 'EAS confirmed the staged group first')
  assert.equal(JSON.parse(promotedLines.at(-1)).branch, 'next')
  assert.ok(promoted.calls().includes('update:republish --group aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --destination-branch next --platform ios'))
  // EAS must still show the staged group on the staging branch before anything is republished.
  const moved = run('Promote the staged update to next channel', 'view-moved', { STAGED_UPDATE_GROUP: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', STAGED_RUNTIME_VERSION: 'mikka-next-1' })
  assert.throws(moved.exec)
  assert.ok(!moved.calls().includes('update:republish'), 'no republish when EAS does not show the group on next-staging')
  const unverified = run('Promote the staged update to next channel', 'ok', { STAGED_UPDATE_GROUP: '', STAGED_RUNTIME_VERSION: 'mikka-next-1' })
  assert.throws(unverified.exec)
  const otherRuntime = run('Promote the staged update to next channel', 'ok', { STAGED_UPDATE_GROUP: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', STAGED_RUNTIME_VERSION: 'mikka-next-2' })
  assert.throws(otherRuntime.exec)
  for (const blocked of [unverified, otherRuntime]) assert.throws(blocked.calls, /ENOENT/, 'no EAS call before the staged group is verified')
})

test('the republish and update:view JSON shapes of eas-cli 27.2.0 are both understood', () => {
  const republished = JSON.stringify([{ id: 'u2', group: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee', platform: 'ios',
    runtime: { id: 'rt1', version: 'mikka-next-1' }, branch: { id: 'b-next', name: 'next' } }])
  const parsed = parseEasUpdateOutput(republished, { expectedBranch: 'next', expectedRuntimeVersion: 'mikka-next-1', overlaySha: SHA })
  assert.equal(parsed.branch, 'next')
  assert.equal(parsed.runtimeVersion, 'mikka-next-1')
  assert.throws(() => parseEasUpdateOutput(republished.replace('"name":"next"', '"name":"production"'), { expectedRuntimeVersion: 'mikka-next-1', overlaySha: SHA }), /forbiddenBranch/)
  assert.throws(() => parseEasUpdateOutput(republished, { expectedBranch: 'next', expectedRuntimeVersion: 'mikka-next-2', overlaySha: SHA }), /runtimeVersionMismatch/)
  const view = JSON.stringify([{ id: 'u1', group: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', branch: STAGING_BRANCH, runtimeVersion: 'mikka-next-1', platform: 'ios' }])
  assert.deepEqual(verifyStagedGroup(view, { groupId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', runtimeVersion: 'mikka-next-1' }),
    { groupId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', branch: STAGING_BRANCH, runtimeVersion: 'mikka-next-1' })
  for (const [raw, groupId, runtime] of [[view, 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'mikka-next-1'], [view, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'mikka-next-2'],
    [view.replace(STAGING_BRANCH, 'next'), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'mikka-next-1'], [view.replace('"ios"', '"android"'), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'mikka-next-1'],
    ['[]', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'mikka-next-1']])
    assert.throws(() => verifyStagedGroup(raw, { groupId, runtimeVersion: runtime }))
})
