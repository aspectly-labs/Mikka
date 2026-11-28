import { DEFAULT_POSTHOG_UI_HOST, getPublicPosthogHost, getPublicPosthogKey } from './env/public.ts'

// PostHog project tokens are public ingestion identifiers; keep them in deployment configuration.
// The browser build inlines the process.env literals (apps/frontend/vite.config.mjs);
// the server reads its configuration, legacy NEXT_PUBLIC_* names included.
// An empty value counts as unset (lib/public-env.mjs).
export const posthogConfig = {
  token: getPublicPosthogKey(),
  apiHost: getPublicPosthogHost(),
  uiHost: DEFAULT_POSTHOG_UI_HOST,
} as const
