const OAUTH_SCOPE_TOKEN = /^[A-Za-z0-9._:/-]+$/
const MAX_OAUTH_SCOPE_PARAM_LENGTH = 1024
const MAX_OAUTH_SCOPES = 32

/** Parse, deduplicate, and validate the OAuth 2.0 `scope` query parameter. */
export function parseRequestedOAuthScopes(query: URLSearchParams): string[] | null {
  const rawValues = query.getAll('scope')
  if (rawValues.length > 1) return null
  const raw = rawValues[0]
  if (!raw) return []
  if (raw.length > MAX_OAUTH_SCOPE_PARAM_LENGTH) return null
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  if (tokens.length > MAX_OAUTH_SCOPES) return null
  const unique: string[] = []
  for (const token of tokens) {
    if (!OAUTH_SCOPE_TOKEN.test(token)) return null
    if (!unique.includes(token)) unique.push(token)
  }
  return unique
}
