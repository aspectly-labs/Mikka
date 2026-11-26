import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPEN_ARTIFACT_BRIDGE_SECRET_MIN_LENGTH,
  openArtifactEmbedUrl,
  readOpenArtifactConfig,
  readPublicOpenArtifactConfig,
} from './open-artifact-config'

const VALID_SECRET = 'test-bridge-secret-value-0123456789'

test('open-artifact config fails closed when host origin or bridge secret is absent or weak', () => {
  assert.deepEqual(readPublicOpenArtifactConfig({}), {
    enabled: false,
    hostOrigin: null,
    enabledTypes: [],
  })

  // Host origin without bridge secret must stay disabled fail-closed.
  assert.deepEqual(
    readPublicOpenArtifactConfig({ OPEN_ARTIFACT_HOST_ORIGIN: 'https://artifacts.mikka.dev' }),
    {
      enabled: false,
      hostOrigin: null,
      enabledTypes: [],
    },
  )

  // Short bridge secret (< 16 chars) fails closed.
  const shortSecret = 'x'.repeat(OPEN_ARTIFACT_BRIDGE_SECRET_MIN_LENGTH - 1)
  const weak = readOpenArtifactConfig({
    OPEN_ARTIFACT_HOST_ORIGIN: 'https://artifacts.mikka.dev',
    OPEN_ARTIFACT_BRIDGE_SECRET: shortSecret,
  })
  assert.equal(weak.enabled, false)
  assert.equal(weak.bridgeSecret, null)

  // Non-HTTPS non-loopback origin fails closed.
  const insecure = readOpenArtifactConfig({
    OPEN_ARTIFACT_HOST_ORIGIN: 'http://artifacts.mikka.dev',
    OPEN_ARTIFACT_BRIDGE_SECRET: VALID_SECRET,
  })
  assert.equal(insecure.enabled, false)
  assert.equal(insecure.hostOrigin, null)
})

test('open-artifact config parses valid HTTPS/loopback origins, types, and never leaks bridgeSecret', () => {
  const server = readOpenArtifactConfig({
    OPEN_ARTIFACT_HOST_ORIGIN: 'https://artifacts.mikka.dev/',
    OPEN_ARTIFACT_BRIDGE_SECRET: VALID_SECRET,
    OPEN_ARTIFACT_ENABLED_TYPES: 'slides, design, bogus_type, whiteboard, slides',
    OPEN_ARTIFACT_EMBED_ORIGINS: 'https://app.mikka.dev, http://localhost:3000, http://bad.example',
  })
  assert.equal(server.enabled, true)
  assert.equal(server.hostOrigin, 'https://artifacts.mikka.dev')
  assert.equal(server.bridgeSecret, VALID_SECRET)
  assert.deepEqual(server.enabledTypes, ['slides', 'design', 'whiteboard'])
  assert.deepEqual(server.embedOrigins, [
    'https://artifacts.mikka.dev',
    'https://app.mikka.dev',
    'http://localhost:3000',
  ])

  const pub = readPublicOpenArtifactConfig({
    OPEN_ARTIFACT_HOST_ORIGIN: 'http://localhost:8787/',
    OPEN_ARTIFACT_BRIDGE_SECRET: VALID_SECRET,
  })
  assert.equal(pub.enabled, true)
  assert.equal(pub.hostOrigin, 'http://localhost:8787')
  assert.ok(pub.enabledTypes.includes('slides'))
  assert.ok(pub.enabledTypes.includes('docs'))
  assert.equal('bridgeSecret' in pub, false)
})

test('openArtifactEmbedUrl computes URL only for enabled open_artifact rows with valid externalId', () => {
  const env = {
    OPEN_ARTIFACT_HOST_ORIGIN: 'https://artifacts.mikka.dev',
    OPEN_ARTIFACT_BRIDGE_SECRET: VALID_SECRET,
  }
  assert.equal(openArtifactEmbedUrl('native', 'art_1', { env }), null)
  assert.equal(openArtifactEmbedUrl('open_artifact', null, { env }), null)
  assert.equal(openArtifactEmbedUrl('open_artifact', '../escape', { env }), null)
  assert.equal(openArtifactEmbedUrl('open_artifact', 'art_1', { env: {} }), null)
  assert.equal(
    openArtifactEmbedUrl('open_artifact', 'art_1', { env }),
    'https://artifacts.mikka.dev/a/art_1?embed=1',
  )
  assert.equal(
    openArtifactEmbedUrl('open_artifact', 'art_1', { env, shareToken: 'mks_token123' }),
    'https://artifacts.mikka.dev/a/art_1?embed=1&share=mks_token123',
  )
})
