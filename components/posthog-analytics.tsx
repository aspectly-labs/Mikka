'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from '@/lib/client-runtime/navigation'
import { withPostHog } from '@/lib/analytics/posthog'
import { authClient } from '@/lib/auth-client'
import { analyticsPath } from '@/lib/analytics-policy'
import { isSmokeAccountEmail } from '@/lib/smoke-account'

export function PostHogAnalytics() {
  const pathname = usePathname()
  const { data: session, isPending } = authClient.useSession()
  const userId = session?.user.id
  const previousIdentity = useRef<string | undefined>(undefined)
  const previousPage = useRef('')

  useEffect(() => {
    if (isPending) return
    const signedOut = Boolean(previousIdentity.current && previousIdentity.current !== userId)
    const smoke = isSmokeAccountEmail(session?.user.email)
    previousIdentity.current = userId
    const pageKey = `${userId ?? 'anonymous'}:${pathname}`
    const newPage = Boolean(pathname) && previousPage.current !== pageKey
    if (newPage) previousPage.current = pageKey
    // PostHog loads after first paint (lib/analytics/posthog.ts); these run in order once it has.
    withPostHog(posthog => {
      if (signedOut) {
        posthog.reset(true)
        posthog.register({ app: 'mikka', environment: process.env.NODE_ENV, runtime: window.mikka?.app?.runtime === 'electron' ? 'electron' : 'browser' })
      }
      if (userId && posthog.get_distinct_id() !== userId) posthog.identify(userId)
      // Smoke accounts still load their flags like anyone else; their events are tagged so dashboards can drop them.
      if (smoke) posthog.register({ test_account: true })
      if (!newPage) return
      posthog.capture('$pageview', { $current_url: `${window.location.origin}${analyticsPath(pathname!)}` })
      posthog.reloadFeatureFlags()
    })
  }, [pathname, userId, isPending])

  return null
}
