import 'server-only'

export class LinearApiError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number, readonly credentialRejected = false) {
    super(message)
    this.name = 'LinearApiError'
  }
}

export function sanitizeLinearError(value: string) {
  return Array.from(value, character => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127 ? ' ' : character
  }).join('').slice(0, 300)
}

/** How long one Linear request may take. Production never changes it;
 * tests/issue-scope-detachment.db.test.ts shortens it where a held request
 * has to time out, instead of waiting the full 12 s. */
export const linearRequestTimeout = { ms: 12_000 }

export async function linearGraphQL<T>(accessToken: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(linearRequestTimeout.ms),
    })
  } catch (error) {
    throw Object.assign(new LinearApiError('Linear could not be reached', true), { cause: error })
  }

  let result: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] }
  try {
    result = await response.json()
  } catch (error) {
    throw Object.assign(new LinearApiError('Linear returned an invalid response', response.status >= 500, response.status), { cause: error })
  }

  const error = result.errors?.[0]
  if (!response.ok || error || result.data === undefined) {
    const code = error?.extensions?.code
    const message = sanitizeLinearError(error?.message ?? `Linear request failed (${response.status})`)
    throw new LinearApiError(message, response.status >= 500 || response.status === 429 || code === 'RATELIMITED', response.status, response.status === 401 || (response.ok && code === 'AUTHENTICATION_ERROR'))
  }
  return result.data
}
