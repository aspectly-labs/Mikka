import { auth } from '@/lib/auth'
import { buildAccountExport, claimExport, isExportCurrent } from '@/lib/account/export'
import { accountExportBody, accountExportFiles } from '@/lib/account/export-files'
import { defineRoute } from '@/lib/primitives/define-route'


const privateHeaders = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

/**
 * `GET /api/account/export/:token`: the 「导出我的数据」 file the email links to.
 * It opens only for the signed-in account that asked for it and only until
 * the link expires (lib/account/export.ts); the file is built at download time.
 */
// Browser-only download link using @/lib/auth with disableRefresh: true and plain-text 401 instructions;
// must never invoke @/lib/api-auth (enforced by tests/account-export-route.test.ts).
export const GET = defineRoute<'public', 'none', { token: string }>(
  { auth: 'public', origin: 'any', workspace: 'none', freshSession: true, desktop: true },
  async ({ request, params }) => {
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
    if (!session?.user) return new Response('Sign in to Mikka with the account that asked for this export, then open the link again.', { status: 401, headers: privateHeaders })
    const { token } = params
    if (!await claimExport(session.user.id, token)) return new Response('This export link has expired or belongs to another account.', { status: 404, headers: privateHeaders })
    const now = new Date()
    const data = await buildAccountExport(session.user.id, now)
    const files = await accountExportFiles(session.user.id)
    const assertCurrent = async () => {
      const current = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
      if (current?.user.id !== session.user.id || !await isExportCurrent(session.user.id, token)) throw new Error('Account export authorization expired')
    }
    return new Response(accountExportBody(data, files, session.user.id, { assertCurrent, signal: request.signal }), {
      headers: {
        ...privateHeaders,
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="mikka-export-${now.toISOString().slice(0, 10)}.json"`,
        'content-security-policy': "sandbox; default-src 'none'",
      },
    })
  },
)
