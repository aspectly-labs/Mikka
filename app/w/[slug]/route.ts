import { getTranslations } from '@/lib/intl/i18n-server'
import { RouteRequest, RouteResponse } from '@/lib/server-runtime/server'
import { auth } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { resolveSlugRedirect } from '@/lib/workspace-admin/general'
import { readWorkspaceSlug } from '@/lib/workspace-admin/links'
import { envExact } from '@/lib/env/server'

export async function GET(request: RouteRequest, { params }: { params: Promise<{ slug: string }> }) {
  const i18nText = await getTranslations();
  const { slug } = await params
  if (!/^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/.test(slug)) return new RouteResponse(i18nText("FeatureCopy.c_5893c8c0"), { status: 404 })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return RouteResponse.redirect(new URL(withBasePath(`/sign-in?next=${encodeURIComponent(`/w/${slug}`)}`), request.url))
  const workspace = await readWorkspaceSlug(session.user.id, slug)
  if (!workspace) {
    // A renamed workspace keeps its old slugs: send members on to the current address.
    const current = await resolveSlugRedirect(slug, session.user.id)
    if (current && current !== slug) {
      const moved = RouteResponse.redirect(new URL(withBasePath(`/w/${current}`), request.url), 308)
      moved.headers.set('Cache-Control', 'private, no-store')
      return moved
    }
  }
  if (!workspace) return new RouteResponse(i18nText("FeatureCopy.c_5893c8c0"), { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
  const response = RouteResponse.redirect(new URL(withBasePath('/'), request.url))
  response.headers.set('Cache-Control', 'private, no-store')
  response.cookies.set('mikka-workspace', workspace.id, { httpOnly: true, sameSite: envExact('NODE_ENV', 'development') ? 'none' : 'lax', secure: true, path: '/', maxAge: 31536000 })
  return response
}
