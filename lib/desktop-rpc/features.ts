import 'server-only'
import { CLIENT_FLAG_KEYS, computerAcceptancePreview, computerProductionEnabled, gatedFeatures } from '@/lib/feature-flags'
import { serverFlagEnabled } from '@/lib/posthog-server'
import type { DesktopFeatures } from './wire'
import { publicEnv } from '@/lib/public-env.mjs'
import { runtimeEnv } from '@/lib/env/server'

// The flags clients read (CLIENT_FLAG_KEYS), evaluated for the same person and
// project as the web's browser client. Never send arbitrary PostHog flags,
// project configuration or server environment values.
const publicKeys = CLIENT_FLAG_KEYS

/** A bootstrap snapshot, using the web's user identity and strict-true rules. */
export async function desktopFeatures(userId?: string, {
  evaluate = serverFlagEnabled,
  env = runtimeEnv(),
}: {
  evaluate?: (key: string, userId: string) => Promise<boolean>
  env?: Readonly<Record<string, string | undefined>>
} = {}): Promise<DesktopFeatures> {
  const flags = Object.fromEntries(await Promise.all(publicKeys.map(async key => [key, userId ? await evaluate(key, userId) : false])))
  return {
    flags,
    cloudComputer: flags[gatedFeatures.cloudComputer.key]
      || publicEnv('MIKKA_PUBLIC_COMPUTER_MOCK', env) === '1'
      || computerAcceptancePreview(publicEnv('MIKKA_PUBLIC_COMPUTER_DEPLOYMENT', env), publicEnv('MIKKA_PUBLIC_COMPUTER_ACCEPTANCE', env))
      || computerProductionEnabled(publicEnv('MIKKA_PUBLIC_COMPUTER_DEPLOYMENT', env), publicEnv('MIKKA_PUBLIC_COMPUTER_ENABLED', env)),
  }
}
