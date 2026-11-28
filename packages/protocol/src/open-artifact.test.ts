import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_ENGINES,
  OPEN_ARTIFACT_BRIDGE_MAX_SKEW_SECONDS,
  OPEN_ARTIFACT_BRIDGE_SIGNATURE_HEADER,
  OPEN_ARTIFACT_BRIDGE_SIGNATURE_PREFIX,
  OPEN_ARTIFACT_BRIDGE_TIMESTAMP_HEADER,
  OPEN_ARTIFACT_ENGINE_TYPES,
  OPEN_ARTIFACT_THEME_KEYS,
  RICH_ARTIFACT_TYPES,
  buildOpenArtifactEmbedUrl,
  isOpenArtifactThemeMessage,
  isRichArtifactType,
  isValidOpenArtifactExternalId,
  isWideArtifactType,
  normalizeOpenArtifactOrigin,
  openArtifactBridgeRequestSchema,
  openArtifactWakeRequestSchema,
} from './open-artifact'

describe('open-artifact protocol', () => {
  it('exposes the locked engine, artifact type, and 16 theme key sets', () => {
    expect(ARTIFACT_ENGINES).toEqual(['native', 'open_artifact'])
    expect(RICH_ARTIFACT_TYPES).toEqual([
      'markdown',
      'html',
      'docs',
      'slides',
      'design',
      'design-system',
      'whiteboard',
      'sheets',
      'data',
      'motion',
      'page',
    ])
    expect(OPEN_ARTIFACT_ENGINE_TYPES).toHaveLength(9)
    expect(OPEN_ARTIFACT_THEME_KEYS).toEqual([
      'canvas',
      'surface',
      'surface-2',
      'hover',
      'line',
      'line-strong',
      'fg',
      'fg-muted',
      'fg-subtle',
      'accent',
      'accent-fg',
      'accent-soft',
      'danger',
      'warning',
      'success',
      'select',
    ])
    expect(OPEN_ARTIFACT_BRIDGE_TIMESTAMP_HEADER).toBe('x-mikka-bridge-timestamp')
    expect(OPEN_ARTIFACT_BRIDGE_SIGNATURE_HEADER).toBe('x-mikka-bridge-signature')
    expect(OPEN_ARTIFACT_BRIDGE_SIGNATURE_PREFIX).toBe('sha256=')
    expect(OPEN_ARTIFACT_BRIDGE_MAX_SKEW_SECONDS).toBe(300)
  })

  it('classifies narrow vs wide artifact types consistently', () => {
    expect(isWideArtifactType('markdown')).toBe(false)
    expect(isWideArtifactType('docs')).toBe(false)
    expect(isWideArtifactType(null)).toBe(false)
    expect(isWideArtifactType(undefined)).toBe(false)
    for (const wide of ['html', 'slides', 'design', 'design-system', 'whiteboard', 'sheets', 'data', 'motion', 'page'] as const) {
      expect(isRichArtifactType(wide)).toBe(true)
      expect(isWideArtifactType(wide)).toBe(true)
    }
    expect(isRichArtifactType('unknown')).toBe(false)
  })

  it('validates theme postMessage payloads strictly', () => {
    expect(
      isOpenArtifactThemeMessage({
        openArtifact: 'mikka_theme',
        protocol: 1,
        scheme: 'dark',
        tokens: { canvas: 'rgb(10, 10, 10)', accent: 'rgb(59, 130, 246)' },
      }),
    ).toBe(true)

    expect(
      isOpenArtifactThemeMessage({
        openArtifact: 'mikka_theme',
        protocol: 2,
        scheme: 'light',
        tokens: {},
      }),
    ).toBe(false)

    expect(
      isOpenArtifactThemeMessage({
        openArtifact: 'mikka_theme',
        protocol: 1,
        scheme: 'light',
        tokens: { bogus: '#fff' },
      }),
    ).toBe(false)
  })

  it('normalizes origins and builds embed URLs fail-closed', () => {
    expect(normalizeOpenArtifactOrigin('https://artifacts.mikka.dev/')).toBe('https://artifacts.mikka.dev')
    expect(normalizeOpenArtifactOrigin('http://localhost:8787')).toBe('http://localhost:8787')
    expect(normalizeOpenArtifactOrigin('http://artifacts.mikka.dev')).toBeNull()
    expect(normalizeOpenArtifactOrigin('https://artifacts.mikka.dev/path')).toBeNull()
    expect(normalizeOpenArtifactOrigin('https://user:pass@artifacts.mikka.dev')).toBeNull()
    expect(normalizeOpenArtifactOrigin('javascript:alert(1)')).toBeNull()

    expect(isValidOpenArtifactExternalId('art_123-abc.v1')).toBe(true)
    expect(isValidOpenArtifactExternalId('../escape')).toBe(false)
    expect(isValidOpenArtifactExternalId('a/b')).toBe(false)

    expect(buildOpenArtifactEmbedUrl('https://artifacts.mikka.dev', 'art_123')).toBe(
      'https://artifacts.mikka.dev/a/art_123?embed=1',
    )
    expect(buildOpenArtifactEmbedUrl('https://artifacts.mikka.dev', 'art_123', { shareToken: 'mks_abc123' })).toBe(
      'https://artifacts.mikka.dev/a/art_123?embed=1&share=mks_abc123',
    )
    expect(buildOpenArtifactEmbedUrl('http://evil.example', 'art_123')).toBeNull()
    expect(buildOpenArtifactEmbedUrl('https://artifacts.mikka.dev', '../etc')).toBeNull()
  })

  it('validates bridge and wake schemas', () => {
    const sync = openArtifactBridgeRequestSchema.safeParse({
      action: 'sync',
      event: 'created',
      subject: 'user_1',
      externalId: 'art_1',
      title: 'Q4 Deck',
      artifactType: 'slides',
      version: 1,
    })
    expect(sync.success).toBe(true)

    const badExternalId = openArtifactBridgeRequestSchema.safeParse({
      action: 'authorize',
      subject: 'user_1',
      externalId: '../../secret',
    })
    expect(badExternalId.success).toBe(false)

    const wake = openArtifactWakeRequestSchema.safeParse({
      externalId: 'art_1',
      reason: 'comment',
      from: { kind: 'collaborator', subject: 'user_2', name: 'Bob', role: 'commenter' },
      text: 'Please clarify slide 3',
    })
    expect(wake.success).toBe(true)
  })
})
