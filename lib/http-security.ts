import { desktopSameOriginRequest } from '@/lib/desktop-auth'
import { tokenWorkspace } from '@/lib/tokens/principal'
import type { WorkspaceError } from '@/lib/workspace-error'

type SessionLike = {
  tokenId?: string | null
  tokenWorkspaceId?: string | null
  user?: { [tokenWorkspace]?: string } | null
} | null | undefined

/** True when the authenticated session came from a workspace-scoped Personal Access Token (`mkp_`). */
export function isPatSession(session: SessionLike): boolean {
  return Boolean(session?.tokenId || session?.tokenWorkspaceId || session?.user?.[tokenWorkspace])
}

/** True when the request explicitly presents a Personal Access Token bearer credential. */
export function hasPatAuthorizationHeader(request: Request): boolean {
  return /^Bearer\s+mkp_/i.test(request.headers.get('authorization') ?? '')
}

/**
 * Enforces same-origin CSRF protection for state-changing requests.
 * - Rejects any foreign/null `Origin` or cross-site/same-site `Sec-Fetch-Site`.
 * - For cookie-authenticated requests (or whenever `allowNativeWithoutOrigin` is false),
 *   requires an explicit `Origin` header matching the request URL's origin.
 */
export function sameOriginMutationAllowed(
  request: Request,
  options: { allowNativeWithoutOrigin?: boolean } = {},
): boolean {
  if (!desktopSameOriginRequest(request)) return false
  if (request.headers.has('cookie') || !options.allowNativeWithoutOrigin) {
    return request.headers.get('origin') === new URL(request.url).origin
  }
  return true
}

/** Maps a `WorkspaceError` to its canonical HTTP status (403 for access denial, 409 for policy/state conflicts). */
export function workspaceErrorStatus(error: WorkspaceError): 403 | 409 {
  return error.code === 'workspaceAccessDenied' ? 403 : 409
}
