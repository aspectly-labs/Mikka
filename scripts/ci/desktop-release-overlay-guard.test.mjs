// The signed Desktop release must never run code from the private UI checkout while signing or notarization
// credentials are in the job: the renderer (which compiles the checkout) is built before the first credential,
// packaging only wraps that output, and MIKKA_TRACK_OWNER (the switch that imports the checkout's Vite plugin,
// apps/frontend/vite.config.mjs trackOwnerPlugins) is never set in the release.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const source = read('.github/workflows/desktop-release.yml')
const workflow = yaml.load(source)
const steps = workflow.jobs.macos.steps
const desktopScripts = JSON.parse(read('apps/desktop/package.json')).scripts

// Credentials that sign, notarize or upload the Desktop app.
const CREDENTIAL = /^(?:APPLE_|ASC_|CSC_)/
const readsCredential = step => CREDENTIAL.test(step.with?.['secret-name'] ?? '') ||
  /\b(?:CSC_LINK|CSC_KEY_PASSWORD|APPLE_API_KEY|AuthKey\.p8|APPLE_APP_SPECIFIC_PASSWORD)\b/.test(step.run ?? '')
// Commands that compile or load the private checkout's code.
const BUILDS_CHECKOUT = /scripts\/build\.mjs|build-renderer|apps\/frontend\/scripts\/build|\bvite\b|--filter @mikka\/desktop (?:build|package(?::mac|:dir)?)(?=\s|$)|\.hosted-ui\//

test('the Desktop release builds the renderer before the first signing credential and never after', () => {
  const firstCredential = steps.findIndex(readsCredential)
  assert.ok(firstCredential > 0, 'the job reads signing credentials')
  const build = steps.findIndex(step => step.name === 'Build the desktop app and renderer before any signing credential')
  assert.ok(build >= 0 && build < firstCredential, 'the renderer is built before any credential')
  assert.match(steps[build].run, /pnpm --filter @mikka\/desktop build /)
  for (const [index, step] of steps.entries()) {
    if (index < firstCredential) continue
    assert.doesNotMatch(step.run ?? '', BUILDS_CHECKOUT, `step after credentials loads checkout code: ${step.name}`)
  }
  const pack = steps.find(step => step.name === 'Package signed macOS app')
  assert.match(pack.run, /pnpm --filter @mikka\/desktop package:mac:prebuilt /)
})

test('packaging only wraps the prebuilt output', () => {
  const prebuilt = desktopScripts['package:mac:prebuilt']
  assert.match(prebuilt, /^electron-builder /)
  assert.doesNotMatch(prebuilt, /build\.mjs|&&|;|vite|hosted-ui/)
  // electron-builder's own hooks are this repository's scripts, not the checkout's.
  const builder = yaml.load(read('apps/desktop/electron-builder.yml'))
  for (const hook of ['afterSign', 'afterPack', 'beforeBuild', 'beforePack', 'afterAllArtifactBuild', 'artifactBuildCompleted', 'onNodeModuleFile']) {
    if (builder[hook] === undefined) continue
    assert.match(builder[hook], /^\.\/scripts\/[\w-]+\.mjs$/, hook)
  }
})

test('no Desktop release step or job sets MIKKA_TRACK_OWNER', () => {
  assert.doesNotMatch(source, /MIKKA_TRACK_OWNER/)
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.env?.MIKKA_TRACK_OWNER, undefined)
    for (const step of job.steps ?? []) assert.equal(step.env?.MIKKA_TRACK_OWNER, undefined, step.name)
  }
  assert.equal(workflow.env?.MIKKA_TRACK_OWNER, undefined)
})
