import { Pool } from 'pg'
import { deploymentAttestation, environmentFingerprint, loadEnvironment, readIdentityMaterial } from '@/scripts/test-accounts/environment.mjs'
import { defineRoute } from '@/lib/primitives/define-route'
import { getTestBuildSha } from '@/lib/env/public'
import { readEnv } from '@/lib/env/server'


// Read-only proof for a runner-owned disposable environment. There is no login,
// session creation, reset, provisioning or mutation operation on this endpoint.
async function handleGET(request: Request) {
  let pool: Pool | undefined
  try {
    const environment = await loadEnvironment()
    if (getTestBuildSha() !== environment.deploymentSha) throw new Error('build mismatch')
    const url = new URL(request.url)
    if (url.origin !== environment.origin) throw new Error('origin mismatch')
    const challenge = url.searchParams.get('challenge')
    if (!challenge || !/^[a-f0-9]{64}$/.test(challenge)) throw new Error('invalid challenge')
    pool = new Pool({ connectionString: readEnv('E2E_DATABASE_URL'), max: 1, connectionTimeoutMillis: 3000, statement_timeout: 3000 })
    const key = await readIdentityMaterial(pool, environment)
    return Response.json({
      environmentId: environment.id, instanceId: environment.instanceId,
      deploymentSha: environment.deploymentSha, origin: environment.origin,
      fingerprint: environmentFingerprint(environment),
      proof: deploymentAttestation(environment, challenge, key),
    }, { headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
  } catch {
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
  } finally { await pool?.end() }
}

export const GET = defineRoute(
  {
    route: '/api/test-environment',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request }) => handleGET(request),
)
