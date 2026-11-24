import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { frontendConfig } from '../vite.config.mjs'
import { browserModule } from './test-module.mjs'
import { LEGACY_PUBLIC_ENV } from '../../../lib/public-env.mjs'

const checkout = process.cwd()
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

async function overlayFixture(run) {
  await mkdir(join(checkout, 'node_modules/.cache'), { recursive: true })
  const fixture = await mkdtemp(join(checkout, 'node_modules/.cache/mikka-ui-overlay-fixture-'))
  try {
    await cp(join(repoRoot, 'components/slots'), join(fixture, 'slots'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: fixture })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: fixture })
    execFileSync('git', ['config', 'user.name', 'Overlay Fixture'], { cwd: fixture })
    execFileSync('git', ['add', '.'], { cwd: fixture })
    execFileSync('git', ['commit', '-qm', 'test fixture'], { cwd: fixture })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim()
    return await run({ dir: fixture, sha })
  } finally { await rm(fixture, { recursive: true, force: true }) }
}

async function environment(values, run) {
  const saved = new Map(Object.keys(values).map(key => [key, process.env[key]]))
  try { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } return await run() }
  finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}

const PUBLIC_KEYS = [
  'MIKKA_PUBLIC_BUILD',
  'MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'MIKKA_PUBLIC_TURNSTILE_SITE_KEY',
  'POSTHOG_HOST',
  'MIKKA_PUBLIC_POSTHOG_KEY',
  'MIKKA_PUBLIC_COMPUTER_ACCEPTANCE',
  'MIKKA_PUBLIC_COMPUTER_DEPLOYMENT',
  'MIKKA_PUBLIC_COMPUTER_ENABLED',
  'MIKKA_PUBLIC_COMPUTER_MOCK',
  'MIKKA_DAEMON_PACKAGE_NAME',
]

test('only the existing explicit public configuration is defined for the web graph', async () => environment({ PRIVATE_SOURCE_CANARY: 'not-public', NEXT_PUBLIC_UNLISTED_CANARY: 'not-public', MIKKA_DEPLOYMENT_ID: 'release-1', MIKKA_PUBLIC_BUILD: 'a'.repeat(40) }, async () => {
  const config = await frontendConfig()
  assert.equal(config.envDir, false)
  assert.deepEqual(config.envPrefix, [])
  assert.equal(config.define['process.env'], '{}')
  assert.equal(config.define['process.env.MIKKA_PUBLIC_BUILD'], JSON.stringify('a'.repeat(40)))
  assert.equal(config.define['process.env.MIKKA_DEPLOYMENT_ID'], '"release-1"')
  assert.equal(JSON.stringify(config.define).includes('not-public'), false)
  // Every public setting is the table's new name, and only the legacy aliases of
  // those names are inlined, each with the same value, until phase 2.
  assert.deepEqual(Object.keys(LEGACY_PUBLIC_ENV).sort(), [...PUBLIC_KEYS].sort())
  for (const key of PUBLIC_KEYS) assert.equal(typeof config.define[`process.env.${key}`], 'string', key)
  const legacy = Object.keys(config.define).filter(key => key.startsWith('process.env.NEXT_PUBLIC_'))
  assert.deepEqual(legacy.sort(), PUBLIC_KEYS.map(key => `process.env.${LEGACY_PUBLIC_ENV[key]}`).sort())
  for (const key of PUBLIC_KEYS) assert.equal(config.define[`process.env.${LEGACY_PUBLIC_ENV[key]}`], config.define[`process.env.${key}`], key)
}))

test('the web graph still takes a public setting from its legacy name, and the new name wins', async () => environment({ ...Object.fromEntries(PUBLIC_KEYS.flatMap(key => [[key, undefined], [LEGACY_PUBLIC_ENV[key], undefined]])), [LEGACY_PUBLIC_ENV.MIKKA_PUBLIC_POSTHOG_KEY]: 'legacy-analytics', [LEGACY_PUBLIC_ENV.MIKKA_PUBLIC_TURNSTILE_SITE_KEY]: 'legacy-widget', MIKKA_PUBLIC_TURNSTILE_SITE_KEY: 'current-widget' }, async () => {
  const config = await frontendConfig()
  assert.equal(config.define['process.env.MIKKA_PUBLIC_POSTHOG_KEY'], '"legacy-analytics"')
  assert.equal(config.define['process.env.MIKKA_PUBLIC_TURNSTILE_SITE_KEY'], '"current-widget"')
  assert.equal(config.define[`process.env.${LEGACY_PUBLIC_ENV.MIKKA_PUBLIC_TURNSTILE_SITE_KEY}`], '"current-widget"')
  assert.equal(config.define['process.env.MIKKA_DAEMON_PACKAGE_NAME'], '"@aspectlylabs/mikka"')
}))

test('an empty new name counts as unset in the web graph, so the legacy host and Stripe key still apply', async () => environment({ POSTHOG_HOST: '', [LEGACY_PUBLIC_ENV.POSTHOG_HOST]: 'https://eu.i.posthog.com', MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY: '', [LEGACY_PUBLIC_ENV.MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY]: 'pk_test_legacy' }, async () => {
  const config = await frontendConfig()
  assert.equal(config.define['process.env.POSTHOG_HOST'], '"https://eu.i.posthog.com"')
  assert.equal(config.define['process.env.MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY'], '"pk_test_legacy"')
  const posthog = await browserModule('export { posthogConfig } from "./lib/posthog-config.ts"', config.define)
  assert.equal(posthog.posthogConfig.apiHost, 'https://eu.i.posthog.com')
  await environment({ [LEGACY_PUBLIC_ENV.POSTHOG_HOST]: '', [LEGACY_PUBLIC_ENV.MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY]: undefined }, async () => {
    const off = await frontendConfig()
    assert.equal(off.define['process.env.POSTHOG_HOST'], '""')
    assert.equal(off.define['process.env.MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY'], '""')
  })
}))

test('public build identity uses the explicit project revision instead of legacy deployment metadata', async () => environment({ MIKKA_PUBLIC_BUILD: undefined, [LEGACY_PUBLIC_ENV.MIKKA_PUBLIC_BUILD]: undefined }, async () => {
  // applicationBuild() is cached per process; observe a fresh one.
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { frontendConfig } from ${JSON.stringify(fileURLToPath(new URL('../vite.config.mjs', import.meta.url)))};` +
    `const c = await frontendConfig(); console.log(c.define['process.env.MIKKA_PUBLIC_BUILD'])`],
    { encoding: 'utf8', env: { ...process.env, MIKKA_BUILD_REVISION: 'b'.repeat(40), VERCEL_DEPLOYMENT_ID: 'dpl_old', VERCEL_GIT_COMMIT_SHA: 'c'.repeat(40) } }).trim()
  assert.equal(output, JSON.stringify('b'.repeat(40)))
}))

test('the production explicit computer rollout follows the app deployment stage without requiring PostHog', async () => overlayFixture(({ dir, sha }) => environment({ MIKKA_DEPLOYMENT_STAGE: 'production', MIKKA_UI_OVERLAY_DIR: dir, MIKKA_UI_OVERLAY_SHA: sha, MIKKA_PUBLIC_COMPUTER_DEPLOYMENT: undefined, MIKKA_PUBLIC_COMPUTER_ENABLED: '1', MIKKA_PUBLIC_POSTHOG_KEY: undefined }, async () => {
  const config = await frontendConfig()
  const flags = await browserModule('export { computerProductionEnabled } from "./lib/feature-flags.ts"', config.define)
  assert.equal(JSON.parse(config.define['process.env.MIKKA_PUBLIC_COMPUTER_DEPLOYMENT']), 'production')
  assert.equal(flags.computerProductionEnabled(JSON.parse(config.define['process.env.MIKKA_PUBLIC_COMPUTER_DEPLOYMENT']), JSON.parse(config.define['process.env.MIKKA_PUBLIC_COMPUTER_ENABLED'])), true)
  assert.equal(JSON.parse(config.define['process.env.MIKKA_PUBLIC_POSTHOG_KEY']), '')
})))

test('desktop remains unpinned and does not initialize browser analytics or browser auth configuration', async () => environment({ MIKKA_DEPLOYMENT_ID: 'release-1', MIKKA_PUBLIC_BUILD: 'a'.repeat(40), MIKKA_PUBLIC_POSTHOG_KEY: 'public-canary', MIKKA_PUBLIC_TURNSTILE_SITE_KEY: 'public-widget' }, async () => {
  const config = await frontendConfig({ target: 'desktop', publicTestFixture: true })
  for (const key of ['MIKKA_DEPLOYMENT_ID', 'MIKKA_PUBLIC_BUILD', 'MIKKA_PUBLIC_POSTHOG_KEY', 'MIKKA_PUBLIC_TURNSTILE_SITE_KEY']) assert.equal(config.define[`process.env.${key}`], '""')
  assert.deepEqual(config.experimental, {})
}))

test('the actual web flag graph follows the explicit deployment stage while desktop remains server-owned', async () => overlayFixture(async ({ dir, sha }) => {
  for (const stage of ['production', 'preview', 'development']) await environment({ MIKKA_DEPLOYMENT_STAGE: stage, MIKKA_UI_OVERLAY_DIR: dir, MIKKA_UI_OVERLAY_SHA: sha, MIKKA_PUBLIC_COMPUTER_ENABLED: '1' }, async () => {
    const web = await frontendConfig()
    const deployment = JSON.parse(web.define['process.env.MIKKA_PUBLIC_COMPUTER_DEPLOYMENT'])
    assert.equal(deployment, stage)
    const flags = await browserModule('export { computerProductionEnabled } from "./lib/feature-flags.ts"', web.define)
    assert.equal(flags.computerProductionEnabled(deployment, '1'), stage === 'production')
    // Exercise the public test renderer without representing a release with a
    // missing private checkout. The explicit application stage remains set.
    const desktop = await environment({ MIKKA_DEPLOYMENT_STAGE: undefined, MIKKA_UI_OVERLAY_DIR: undefined, MIKKA_UI_OVERLAY_SHA: undefined }, () => frontendConfig({ target: 'desktop', publicTestFixture: true }))
    assert.equal(desktop.define['process.env.MIKKA_PUBLIC_COMPUTER_DEPLOYMENT'], '""')
  })
  await environment({ MIKKA_DEPLOYMENT_STAGE: 'prod' }, async () => assert.rejects(frontendConfig(), /MIKKA_DEPLOYMENT_STAGE_INVALID/))
}))

test('Vite development keeps the actual development React runtime and Fast Refresh plugin', async () => {
  const config = await frontendConfig({ command: 'serve' })
  assert.equal(config.define['process.env.NODE_ENV'], '"development"')
  assert.equal(config.define['process.env.MIKKA_DEPLOYMENT_ID'], '""')
  assert.ok(config.plugins.flat(Infinity).some(plugin => /react/.test(plugin.name)))
  await assert.rejects(frontendConfig({ target: 'server' }), /FRONTEND_TARGET_INVALID/)
})

test('a server-pages build cannot package a private release or a desktop renderer', async () => {
  await assert.rejects(frontendConfig({ target: 'desktop', serverPages: true }), /SERVER_PAGES_REQUIRE_PUBLIC_WEB_BUILD/)
  for (const key of ['MIKKA_UI_OVERLAY_DIR', 'MIKKA_UI_OVERLAY_SHA']) {
    await environment({ [key]: 'configured' }, async () => {
      await assert.rejects(frontendConfig({ serverPages: true }), /SERVER_PAGES_REQUIRE_PUBLIC_WEB_BUILD/)
    })
  }
})

test('standalone package entry points require a private revision for official Desktop and Web', async () => {
  await environment({ MIKKA_UI_OVERLAY_DIR: undefined, MIKKA_UI_OVERLAY_SHA: undefined, MIKKA_DEPLOYMENT_STAGE: undefined }, async () => {
    await assert.rejects(frontendConfig({ target: 'desktop' }), /OFFICIAL_DESKTOP_UI_CHECKOUT_REQUIRED/)
    await frontendConfig({ target: 'desktop', publicTestFixture: true })
    await environment({ MIKKA_DEPLOYMENT_STAGE: 'production' }, async () => {
      await assert.rejects(frontendConfig(), /OFFICIAL_UI_CHECKOUT_AND_REVISION_REQUIRED/)
      await assert.rejects(frontendConfig({ publicTestFixture: true }), /PUBLIC_FIXTURE_REQUIRES_NON_RELEASE_BUILD/)
    })
    await environment({ MIKKA_UI_OVERLAY_DIR: '.missing-official-checkout' }, async () => {
      await assert.rejects(frontendConfig({ target: 'desktop' }), /OFFICIAL_UI_CHECKOUT_AND_REVISION_REQUIRED/)
      await assert.rejects(frontendConfig({ publicTestFixture: true }), /PUBLIC_FIXTURE_REQUIRES_NON_RELEASE_BUILD/)
    })
  })
})
