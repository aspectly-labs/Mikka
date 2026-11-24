import { publicEnv } from './public-env.mjs'

// PostHog project tokens are public ingestion identifiers; keep them in deployment configuration.
// The browser build inlines the process.env literals (apps/frontend/vite.config.mjs);
// the server reads its configuration, legacy NEXT_PUBLIC_* names included.
export const posthogConfig = {
  token: process.env.MIKKA_PUBLIC_POSTHOG_KEY ?? publicEnv('MIKKA_PUBLIC_POSTHOG_KEY', undefined, ''),
  apiHost: (process.env.POSTHOG_HOST || publicEnv('POSTHOG_HOST') || 'https://us.i.posthog.com').replace(/\/+$/, ''),
  uiHost: 'https://us.posthog.com',
} as const
