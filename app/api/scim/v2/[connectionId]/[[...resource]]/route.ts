import { pool } from '@/lib/db'
import { ScimStore } from '@/lib/enterprise/scim-store'
import { createScimHandler } from '@/lib/enterprise/scim-http'
import { auditDirectoryGroup, synchronizeDirectoryUser } from '@/lib/enterprise/lifecycle'
import { defineRoute } from '@/lib/primitives/define-route'

const handle = createScimHandler(new ScimStore(pool, synchronizeDirectoryUser, auditDirectoryGroup))
// SCIM 2.0 (RFC 7644) authenticates via per-connection bearer tokens inside createScimHandler.
const route = defineRoute<'public', 'none', { connectionId: string; resource?: string[] }>(
  { auth: 'public', origin: 'any', workspace: 'none' },
  async ({ request, params }) => handle(request, params.connectionId, params.resource ?? []),
)
export { route as GET, route as POST, route as PUT, route as PATCH, route as DELETE }
