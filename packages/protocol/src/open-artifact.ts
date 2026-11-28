import { z } from 'zod'

/**
 * Shared protocol for unified Mikka Artifacts + Open Artifact rich-engine
 * integration (`aspectly-labs/Mikka#3343`).
 *
 * Keeps engine identifiers, rich artifact types, dual-container wide-document
 * heuristics, the 16 `--open-artifact-*` runtime theme tokens, HMAC bridge
 * headers, and bridge/wake payload schemas in one dependency-free contract
 * consumed by public `Mikka`, private `mikka-hosted-ui`, and private
 * `mikka-cloud`.
 */

export const ARTIFACT_ENGINES = ['native', 'open_artifact'] as const
export type ArtifactEngine = (typeof ARTIFACT_ENGINES)[number]

export const RICH_ARTIFACT_TYPES = [
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
] as const
export type RichArtifactType = (typeof RICH_ARTIFACT_TYPES)[number]

export const OPEN_ARTIFACT_ENGINE_TYPES = [
  'docs',
  'slides',
  'design',
  'design-system',
  'whiteboard',
  'sheets',
  'data',
  'motion',
  'page',
] as const satisfies readonly RichArtifactType[]

const RICH_ARTIFACT_TYPE_SET = new Set<string>(RICH_ARTIFACT_TYPES)
const NARROW_ARTIFACT_TYPES = new Set<string>(['markdown', 'docs'])

export function isRichArtifactType(value: unknown): value is RichArtifactType {
  return typeof value === 'string' && RICH_ARTIFACT_TYPE_SET.has(value)
}

/**
 * Mirrors Claude Desktop's `wideDoc` heuristic for Artifact Dialog layout:
 * narrow prose documents (`markdown`, `docs`) default to a 1/3 chat split,
 * while visual canvases (`html`, `slides`, `design`, `whiteboard`, `sheets`,
 * `data`, `motion`, `page`, `design-system`) default to a narrower 25% chat
 * split so the artifact gets 75% of the dialog width.
 */
export function isWideArtifactType(type: RichArtifactType | string | null | undefined): boolean {
  if (!type) return false
  return !NARROW_ARTIFACT_TYPES.has(type)
}

/**
 * The 16 `--open-artifact-*` semantic CSS variables supported by Open Artifact
 * Shell's runtime theme override. Mikka maps these dynamically at runtime from
 * computed Mikka design tokens — never hardcoding palette literals.
 */
export const OPEN_ARTIFACT_THEME_KEYS = [
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
] as const
export type OpenArtifactThemeKey = (typeof OPEN_ARTIFACT_THEME_KEYS)[number]

export const OPEN_ARTIFACT_THEME_MESSAGE_TYPE = 'mikka_theme' as const
export const OPEN_ARTIFACT_THEME_PROTOCOL = 1 as const

export interface OpenArtifactThemeMessage {
  openArtifact: typeof OPEN_ARTIFACT_THEME_MESSAGE_TYPE
  protocol: typeof OPEN_ARTIFACT_THEME_PROTOCOL
  scheme: 'light' | 'dark'
  tokens: Partial<Record<OpenArtifactThemeKey, string>>
}

const THEME_KEY_SET = new Set<string>(OPEN_ARTIFACT_THEME_KEYS)

export function isOpenArtifactThemeMessage(value: unknown): value is OpenArtifactThemeMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.openArtifact !== OPEN_ARTIFACT_THEME_MESSAGE_TYPE) return false
  if (record.protocol !== OPEN_ARTIFACT_THEME_PROTOCOL) return false
  if (record.scheme !== 'light' && record.scheme !== 'dark') return false
  if (!record.tokens || typeof record.tokens !== 'object' || Array.isArray(record.tokens)) return false
  for (const [key, tokenValue] of Object.entries(record.tokens as Record<string, unknown>)) {
    if (!THEME_KEY_SET.has(key)) return false
    if (tokenValue !== undefined && typeof tokenValue !== 'string') return false
  }
  return true
}

// --- HMAC Bridge Auth Constants ----------------------------------------------

export const OPEN_ARTIFACT_BRIDGE_TIMESTAMP_HEADER = 'x-mikka-bridge-timestamp' as const
export const OPEN_ARTIFACT_BRIDGE_SIGNATURE_HEADER = 'x-mikka-bridge-signature' as const
export const OPEN_ARTIFACT_BRIDGE_SIGNATURE_PREFIX = 'sha256=' as const
export const OPEN_ARTIFACT_BRIDGE_MAX_SKEW_SECONDS = 300 as const

/** Safe slug/id format for Open Artifact external IDs (URL path segment safe). */
export const OPEN_ARTIFACT_EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isValidOpenArtifactExternalId(value: unknown): value is string {
  return typeof value === 'string' && OPEN_ARTIFACT_EXTERNAL_ID_PATTERN.test(value)
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/**
 * Validates and normalizes an Open Artifact host origin (`https://...` or
 * loopback `http://...`). Rejects credentials, paths, query strings, and
 * fragments so callers cannot inject path traversal or open redirects.
 */
export function normalizeOpenArtifactOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.username || parsed.password) return null
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null
  if (parsed.search || parsed.hash) return null
  if (parsed.protocol === 'https:') return parsed.origin
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return parsed.origin
  return null
}

/**
 * Builds the canonical embedded view URL for an Open Artifact document.
 * Returns null fail-closed if either the origin or externalId is invalid.
 */
export function buildOpenArtifactEmbedUrl(
  hostOrigin: string | null | undefined,
  externalId: string | null | undefined,
  options: { embed?: boolean; shareToken?: string | null } = {},
): string | null {
  const origin = normalizeOpenArtifactOrigin(hostOrigin)
  if (!origin || !isValidOpenArtifactExternalId(externalId)) return null
  const url = new URL(`/a/${encodeURIComponent(externalId)}`, `${origin}/`)
  if (options.embed !== false) url.searchParams.set('embed', '1')
  if (options.shareToken && /^[A-Za-z0-9._-]{1,160}$/.test(options.shareToken)) {
    url.searchParams.set('share', options.shareToken)
  }
  return url.toString()
}

// --- Bridge, Config & Wake Wire Schemas --------------------------------------

export const OPEN_ARTIFACT_ROLES = ['owner', 'editor', 'commenter', 'viewer'] as const
export type OpenArtifactRole = (typeof OPEN_ARTIFACT_ROLES)[number]

export const OPEN_ARTIFACT_WAKE_REASONS = ['comment', 'request', 'task'] as const
export type OpenArtifactWakeReason = (typeof OPEN_ARTIFACT_WAKE_REASONS)[number]

export const OPEN_ARTIFACT_WAKE_SENDER_KINDS = ['owner', 'collaborator', 'system'] as const
export type OpenArtifactWakeSenderKind = (typeof OPEN_ARTIFACT_WAKE_SENDER_KINDS)[number]

export const OPEN_ARTIFACT_WAKE_CLASSIFICATIONS = ['owner_turn', 'fenced_notice'] as const
export type OpenArtifactWakeClassification = (typeof OPEN_ARTIFACT_WAKE_CLASSIFICATIONS)[number]

export interface OpenArtifactConfigResponse {
  enabled: boolean
  hostOrigin: string | null
  enabledTypes: RichArtifactType[]
}

export interface OpenArtifactIdentity {
  subject: string
  email?: string
  emailVerified?: boolean
  name?: string
  avatar?: string
  groups?: string[]
}

export const openArtifactBridgeRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('authenticate'),
    cookieHeader: z.string().max(16384).optional(),
    authorizationHeader: z.string().max(4096).optional(),
  }),
  z.object({
    action: z.literal('authorize'),
    subject: z.string().min(1).max(256).nullable().optional(),
    externalId: z.string().regex(OPEN_ARTIFACT_EXTERNAL_ID_PATTERN),
    shareToken: z.string().min(1).max(160).nullable().optional(),
  }),
  z.object({
    action: z.literal('guard'),
    subject: z.string().min(1).max(256).nullable().optional(),
    externalId: z.string().regex(OPEN_ARTIFACT_EXTERNAL_ID_PATTERN).nullable().optional(),
    guardAction: z.string().min(1).max(64),
    detail: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    action: z.literal('sync'),
    event: z.enum(['created', 'updated', 'deleted']),
    subject: z.string().min(1).max(256),
    workspaceId: z.uuid().nullable().optional(),
    externalId: z.string().regex(OPEN_ARTIFACT_EXTERNAL_ID_PATTERN),
    title: z.string().max(300).optional(),
    artifactType: z.enum(RICH_ARTIFACT_TYPES).optional(),
    version: z.number().int().min(1).max(100_000).optional(),
    runId: z.uuid().nullable().optional(),
    issueId: z.uuid().nullable().optional(),
  }),
])

export type OpenArtifactBridgeRequest = z.infer<typeof openArtifactBridgeRequestSchema>

export const openArtifactWakeSenderSchema = z.object({
  kind: z.enum(OPEN_ARTIFACT_WAKE_SENDER_KINDS),
  subject: z.string().min(1).max(256).nullable().optional(),
  name: z.string().max(160).nullable().optional(),
  role: z.string().max(64).nullable().optional(),
})
export type OpenArtifactWakeSender = z.infer<typeof openArtifactWakeSenderSchema>

export const openArtifactWakeRequestSchema = z.object({
  externalId: z.string().regex(OPEN_ARTIFACT_EXTERNAL_ID_PATTERN),
  artifactId: z.uuid().nullable().optional(),
  reason: z.enum(OPEN_ARTIFACT_WAKE_REASONS),
  from: openArtifactWakeSenderSchema,
  text: z.string().min(1).max(8000),
  summary: z.string().max(1000).nullable().optional(),
  threads: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  requests: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  dedupeKey: z.string().min(1).max(200).optional(),
})
export type OpenArtifactWakeRequest = z.infer<typeof openArtifactWakeRequestSchema>

export interface OpenArtifactWakeResponse {
  ok: true
  delivered: boolean
  classification: OpenArtifactWakeClassification
  artifactId: string
  eventId?: string | null
}
