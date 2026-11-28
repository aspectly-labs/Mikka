import assert from 'node:assert/strict'
import test from 'node:test'
import { telemetryBuildConfig } from './telemetry-build-config.mjs'
import { getPublicPosthogHost } from '../../../lib/env/public.ts'

const key = 'phc_testProjectKeyForTheCaptureStub0000'

test('a build without a key sends nothing and never checks the host', () => {
  for (const POSTHOG_HOST of [undefined, '', 'https://eu.i.posthog.com/', 'not a url', 'http://capture.example']) {
    assert.deepEqual(telemetryBuildConfig({ POSTHOG_HOST }), { key: '', host: 'https://us.i.posthog.com' })
  }
})

test('the host is normalized as the web normalizes it, under either name', () => {
  for (const env of [
    { MIKKA_PUBLIC_POSTHOG_KEY: key, POSTHOG_HOST: 'https://eu.i.posthog.com/' },
    { MIKKA_PUBLIC_POSTHOG_KEY: key, POSTHOG_HOST: ' https://eu.i.posthog.com// ' },
    { NEXT_PUBLIC_POSTHOG_KEY: key, NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com/' },
  ]) {
    assert.deepEqual(telemetryBuildConfig(env), { key, host: 'https://eu.i.posthog.com' })
    assert.equal(getPublicPosthogHost(env), telemetryBuildConfig(env).host, 'the web reads the same host')
  }
  assert.deepEqual(telemetryBuildConfig({ MIKKA_PUBLIC_POSTHOG_KEY: key }), { key, host: 'https://us.i.posthog.com' })
  assert.equal(telemetryBuildConfig({ MIKKA_PUBLIC_POSTHOG_KEY: key, POSTHOG_HOST: 'http://127.0.0.1:8010/' }).host, 'http://127.0.0.1:8010')
})

test('with a key, a malformed key or a host that is not an HTTPS origin stops the build', () => {
  assert.throws(() => telemetryBuildConfig({ MIKKA_PUBLIC_POSTHOG_KEY: 'not-a-key' }), /not a PostHog project key/)
  for (const POSTHOG_HOST of ['http://capture.example', 'https://eu.i.posthog.com/capture', 'https://user@eu.i.posthog.com', 'ftp://eu.i.posthog.com']) {
    assert.throws(() => telemetryBuildConfig({ MIKKA_PUBLIC_POSTHOG_KEY: key, POSTHOG_HOST }), /HTTPS origin/, POSTHOG_HOST)
  }
})
