import 'server-only'
import {
  OPEN_ARTIFACT_ENGINE_TYPES,
  buildOpenArtifactEmbedUrl,
  isRichArtifactType,
  normalizeOpenArtifactOrigin,
  type ArtifactEngine,
  type OpenArtifactConfigResponse,
  type RichArtifactType,
} from '@mikka/protocol/open-artifact'
import { runtimeEnv, type EnvMap } from '@/lib/env/server'

/**
 * Typed runtime configuration for the Cloudflare-hosted Open Artifact rich
 * engine (`aspectly-labs/Mikka#3343`, reading through `@/lib/env/server` per `#3342`).
 *
 * Fail-closed invariants:
 * - Never hardcode production origins or secrets.
 * - Require BOTH a valid HTTPS (or loopback HTTP) `OPEN_ARTIFACT_HOST_ORIGIN`
 *   AND a sufficiently strong `OPEN_ARTIFACT_BRIDGE_SECRET` (>= 16 chars) before
 *   reporting `enabled: true`.
 * - Enforce `OPEN_ARTIFACT_ENABLED_TYPES` in both config advertisement and
 *   embed URL / catalog admission checks.
 * - Never expose `bridgeSecret` through public/client config views.
 */

export const OPEN_ARTIFACT_BRIDGE_SECRET_MIN_LENGTH = 16

export interface OpenArtifactServerConfig {
  enabled: boolean
  hostOrigin: string | null
  bridgeSecret: string | null
  enabledTypes: RichArtifactType[]
  embedOrigins: string[]
}

function parseEnabledTypes(raw: string | undefined): RichArtifactType[] {
  if (!raw || !raw.trim()) return [...OPEN_ARTIFACT_ENGINE_TYPES]
  const seen = new Set<RichArtifactType>()
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (isRichArtifactType(trimmed)) seen.add(trimmed)
  }
  return [...seen]
}

function parseEmbedOrigins(raw: string | undefined, hostOrigin: string | null): string[] {
  const origins = new Set<string>()
  if (hostOrigin) origins.add(hostOrigin)
  if (raw) {
    for (const part of raw.split(',')) {
      const normalized = normalizeOpenArtifactOrigin(part)
      if (normalized) origins.add(normalized)
    }
  }
  return [...origins]
}

function parseBridgeSecret(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length >= OPEN_ARTIFACT_BRIDGE_SECRET_MIN_LENGTH ? trimmed : null
}

export function readOpenArtifactConfig(env: EnvMap = runtimeEnv()): OpenArtifactServerConfig {
  const hostOrigin = normalizeOpenArtifactOrigin(env.OPEN_ARTIFACT_HOST_ORIGIN)
  const bridgeSecret = parseBridgeSecret(env.OPEN_ARTIFACT_BRIDGE_SECRET)
  const enabled = Boolean(hostOrigin && bridgeSecret)
  const enabledTypes = enabled ? parseEnabledTypes(env.OPEN_ARTIFACT_ENABLED_TYPES) : []
  const embedOrigins = enabled ? parseEmbedOrigins(env.OPEN_ARTIFACT_EMBED_ORIGINS, hostOrigin) : []
  return {
    enabled,
    hostOrigin: enabled ? hostOrigin : null,
    bridgeSecret,
    enabledTypes,
    embedOrigins,
  }
}

export function readPublicOpenArtifactConfig(env: EnvMap = runtimeEnv()): OpenArtifactConfigResponse {
  const config = readOpenArtifactConfig(env)
  return {
    enabled: config.enabled,
    hostOrigin: config.hostOrigin,
    enabledTypes: config.enabledTypes,
  }
}

export function isOpenArtifactTypeEnabled(
  artifactType: RichArtifactType | string | null | undefined,
  env: EnvMap = runtimeEnv(),
): boolean {
  if (!isRichArtifactType(artifactType)) return false
  const config = readOpenArtifactConfig(env)
  return config.enabled && config.enabledTypes.includes(artifactType)
}

export function openArtifactEmbedUrl(
  engine: ArtifactEngine | string | null | undefined,
  externalId: string | null | undefined,
  options: {
    artifactType?: RichArtifactType | string | null
    shareToken?: string | null
    env?: EnvMap
  } = {},
): string | null {
  if (engine !== 'open_artifact' || !externalId) return null
  const config = readOpenArtifactConfig(options.env)
  if (!config.enabled || !config.hostOrigin) return null
  if (
    options.artifactType !== undefined
    && options.artifactType !== null
    && (!isRichArtifactType(options.artifactType) || !config.enabledTypes.includes(options.artifactType))
  ) {
    return null
  }
  return buildOpenArtifactEmbedUrl(config.hostOrigin, externalId, {
    embed: true,
    shareToken: options.shareToken,
  })
}
