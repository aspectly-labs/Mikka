import { RouteResponse } from '@/lib/server-runtime/server'
import { defineRoute } from '@/lib/primitives/define-route'

import { APP_BUILD, minDesktopVersion } from '@/lib/app-build'
import { MIN_MOBILE_BUILD, MOBILE_UPDATE_URL } from '@/lib/mobile-min-build'
import { HOSTED_API_FLOOR, HOSTED_API_VERSION, HOSTED_API_VERSION_HEADER, hostedApiUpgradeRequired } from '@mikka/protocol/version'
import { getPublicUiOverlaySha } from '@/lib/env/public'
import { readEnv } from '@/lib/env/server'


/**
 * The build this deployment serves, so an open page can tell it is out of
 * date; for the iOS app's launch, the oldest native build it accepts and
 * where to get a newer one; and the oldest desktop app it still serves
 * (MIN_CLIENT_VERSION). Read before sign-in, so it needs no session.
 */
export const GET = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none', route: '/api/version', desktop: true },
  ({ request }) => {
    // Released Web Workers require the original five-field document. New readers
    // opt into the additional metadata using the same compatibility header.
    const compatibility = request.headers.has(HOSTED_API_VERSION_HEADER) && hostedApiUpgradeRequired(request.headers, 1) === null
    return RouteResponse.json(
      { build: APP_BUILD, overlaySha: getPublicUiOverlaySha() || null, minMobileBuild: MIN_MOBILE_BUILD, mobileUpdateUrl: MOBILE_UPDATE_URL, minDesktopVersion: minDesktopVersion(readEnv('MIN_CLIENT_VERSION')),
        ...(compatibility ? { apiVersion: HOSTED_API_VERSION, minApiVersion: HOSTED_API_FLOOR } : {}) },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    )
  },
)
