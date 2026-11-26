import { definePlugin } from 'nitro'
import { resolveAppOrigin } from '../../../lib/auth-config'
import { readEnv, runtimeEnv } from '../../../lib/env/server'
import { withNodeRequestAuthority } from '../runtime/request-authority'

export default definePlugin(application => {
  application.fetch = withNodeRequestAuthority(application.fetch, {
    origin: resolveAppOrigin(runtimeEnv()),
    legacyHost: readEnv('MIKKA_LEGACY_APP_HOST'),
  })
})
