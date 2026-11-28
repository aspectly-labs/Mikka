import { watchRemovedActions } from '@/lib/app-build'
import { posthogConfig } from '@/lib/posthog-config'
import { loadPostHogAfterIdle } from '@/lib/analytics/posthog'

// Obsolete actions stop old traffic and offer a refresh without discarding the page.
watchRemovedActions(window)

// PostHog (about 300 KB) starts once the page is idle after first paint
// (lib/analytics/posthog-init.ts holds its configuration). Calls made earlier
// wait for it; feature flags read as not yet loaded until then.
if (posthogConfig.token) loadPostHogAfterIdle(window)
