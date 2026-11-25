import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  formatStepSummary,
  formatUpdateMessage,
  parseEasUpdateOutput,
  validateHostedUiRef,
  verifyMobileNextConfig,
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

function stepBlock(name) {
  const marker = `- name: ${name}`
  const start = workflowText.indexOf(marker)
  assert.ok(start >= 0, `missing workflow step: ${name}`)
  const next = workflowText.indexOf('\n      - ', start + marker.length)
  return workflowText.slice(start, next < 0 ? workflowText.length : next)
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

test('verifyMobileNextConfig enforces next channel and mikka-next-* runtime isolation', () => {
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
    () => parseEasUpdateOutput(arrayPayload.replace('"ios"', '"android"'), { expectedRuntimeVersion: 'mikka-next-1', overlaySha: SHA }),
    /mobileNextUpdate:platformMissing/,
  )
})

test('CLI subcommands verify config, format messages, and summarize EAS output cleanly', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-next-update-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'app.config.ts'), validAppConfig)
  writeFileSync(join(dir, 'eas.json'), validEasJson)
  const envFile = join(dir, 'github-env')
  const summaryFile = join(dir, 'github-summary')
  const easJsonFile = join(dir, 'eas-update.json')
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

  const msg = execFileSync(process.execPath, [HELPER_PATH, 'format-message'], {
    env: { ...process.env, UPDATE_MESSAGE: '', OVERLAY_SHA: SHA },
    encoding: 'utf8',
  })
  assert.equal(msg, `mobile-next OTA (${SHA.slice(0, 12)})`)

  const summary = JSON.parse(execFileSync(process.execPath, [HELPER_PATH, 'summarize', easJsonFile], {
    env: {
      ...process.env,
      EAS_CHANNEL: 'next',
      MOBILE_NEXT_RUNTIME_VERSION: 'mikka-next-1',
      OVERLAY_SHA: SHA,
      GITHUB_STEP_SUMMARY: summaryFile,
    },
    encoding: 'utf8',
  }))
  assert.equal(summary.updateGroupId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  assert.equal(summary.channel, 'next')
  assert.equal(summary.runtimeVersion, 'mikka-next-1')
  assert.equal(summary.overlaySha, SHA)
  assert.ok(readFileSync(summaryFile, 'utf8').includes('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'))
})

test('mobile-next-update.yml enforces fail-closed repo/main guard, pinned actions, OIDC-only secrets, and strict next-channel isolation', () => {
  // Dispatch-only trigger on ubuntu-24.04 with main-only trusted repo guard.
  assert.match(workflowText, /^on:\n  workflow_dispatch:\n/m)
  assert.ok(!workflowText.includes('\n  pull_request:'), 'workflow must not trigger on pull_request')
  assert.ok(!workflowText.includes('\n  push:'), 'workflow must not trigger on push')
  assert.ok(workflowText.includes('runs-on: ubuntu-24.04'))
  assert.ok(workflowText.includes('id-token: write'))
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

  // Zero static GitHub Actions secrets; never target production channel/branch.
  assert.ok(!workflowText.includes('secrets.'), 'workflow must not read static GitHub secrets')
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

  // Verify strict fail-closed step order.
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
    'Verify mobile-next typecheck and tests',
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

  // Verify both Infisical OIDC secret steps match canonical prod:/platform identity.
  for (const secretName of ['HOSTED_UI_READ_KEY', 'EXPO_TOKEN']) {
    const block = stepBlock(`Read existing ${secretName} through OIDC`)
    for (const required of [
      'uses: Infisical/secrets-action@d2e351f16c6ca20d17c85e6c992e04bdeb64e87d',
      'method: oidc',
      'identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac',
      'oidc-audience: mikka-infisical',
      'project-id: 89850d6a-f020-4936-863e-df77380dfe40',
      'env-slug: prod',
      'secret-path: /platform',
      `secret-name: ${secretName}`,
      'recursive: false',
      'include-imports: false',
    ]) {
      assert.ok(block.includes(required), `${secretName}: missing ${required}`)
    }
  }

  // Verify private checkout isolation, verifyOverlayMain, and recordOverlay scrub.
  const checkout = stepBlock('Check out the private app revision')
  for (const required of ['path: .hosted-ui', 'ref: ${{ env.HOSTED_UI_REF }}', 'ssh-key: ${{ env.HOSTED_UI_READ_KEY }}', 'persist-credentials: false']) {
    assert.ok(checkout.includes(required), `checkout missing ${required}`)
  }
  assert.ok(!checkout.includes('token:'))

  const verifyMain = stepBlock('Resolve and verify the private revision is on main')
  assert.ok(verifyMain.includes('verifyOverlayMain'))
  assert.ok(verifyMain.includes('github-known-hosts'))
  assert.ok(stepBlock('Pin the private UI revision').includes('node scripts/release/hosted-ui.mjs record .hosted-ui'))

  // Verify publish step enforces APP_VARIANT=production, next channel, iOS, non-interactive JSON.
  const publish = stepBlock('Publish EAS Update to next channel')
  for (const required of [
    'working-directory: .hosted-ui/mobile-next/apps/mobile',
    'APP_VARIANT: production',
    '[[ "$EAS_CHANNEL" == "next" ]]',
    'eas-cli@${EAS_CLI_VERSION}',
    'channel:view "$EAS_CHANNEL"',
    'channel:create "$EAS_CHANNEL"',
    '--channel "$EAS_CHANNEL"',
    '--platform ios',
    '--non-interactive',
    '--json',
    'mobile-next-update.mjs" summarize',
  ]) {
    assert.ok(publish.includes(required), `publish step missing ${required}`)
  }

  const cleanup = stepBlock('Clear credentials and temporary logs')
  assert.ok(cleanup.includes('if: always()'))
  assert.ok(cleanup.includes("echo 'HOSTED_UI_READ_KEY='"))
  assert.ok(cleanup.includes("echo 'EXPO_TOKEN='"))
})
