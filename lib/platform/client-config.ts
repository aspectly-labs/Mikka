import { DESKTOP_RELEASES_URL } from './desktop-releases'
import { publicEnv } from '@/lib/public-env.mjs'

/** Existing public deployment override, read when a client builds its commands. */
export function daemonPackageName() {
  return process.env.MIKKA_DAEMON_PACKAGE_NAME ?? publicEnv('MIKKA_DAEMON_PACKAGE_NAME', undefined, '@aspectlylabs/mikka')
}

/** Where a person on the web can get the desktop app, which adds its own computer as a device without a terminal. */
export function desktopReleasesUrl() {
  return DESKTOP_RELEASES_URL
}
