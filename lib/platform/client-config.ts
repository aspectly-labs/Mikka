import { DESKTOP_RELEASES_URL } from './desktop-releases'
import { getPublicDaemonPackageName } from '@/lib/env/public'

/** Existing public deployment override, read when a client builds its commands. */
export function daemonPackageName() {
  return getPublicDaemonPackageName()
}

/** Where a person on the web can get the desktop app, which adds its own computer as a device without a terminal. */
export function desktopReleasesUrl() {
  return DESKTOP_RELEASES_URL
}
