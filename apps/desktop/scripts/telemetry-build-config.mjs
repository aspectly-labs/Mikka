// The PostHog project and host a desktop build sends to (src/main/telemetry.ts).
// Both are read the way the web reads them: the public names in
// lib/public-env.mjs (with their legacy names), and the host normalized by the
// same boundary as lib/env/public.ts, so `https://eu.i.posthog.com/` is the
// same host there and here.

import { DEFAULT_POSTHOG_API_HOST, normalizedPublicUrl, publicEnv } from '../../../lib/public-env.mjs'
const PROJECT_KEY = /^ph[a-z]_[A-Za-z0-9]{20,80}$/
const HOST = /^https:\/\/[a-z0-9.-]+(?::\d+)?$|^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/

/**
 * A build without a key sends nothing, so its host is never used and never
 * checked. With a key, the key must be a PostHog project key and the host an
 * HTTPS origin (or a loopback HTTP one for a local capture stub).
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {{ key: string, host: string }}
 */
export function telemetryBuildConfig(env) {
  const key = publicEnv('MIKKA_PUBLIC_POSTHOG_KEY', env, '').trim()
  if (!key) return { key: '', host: DEFAULT_POSTHOG_API_HOST }
  if (!PROJECT_KEY.test(key)) throw new Error('MIKKA_PUBLIC_POSTHOG_KEY is not a PostHog project key')
  const host = normalizedPublicUrl(publicEnv('POSTHOG_HOST', env, '')) || DEFAULT_POSTHOG_API_HOST
  if (!HOST.test(host)) throw new Error('POSTHOG_HOST must be an HTTPS origin')
  return { key, host }
}
