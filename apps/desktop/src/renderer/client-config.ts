import { DESKTOP_RELEASES_URL } from '@/lib/platform/desktop-releases'
import { getClientConfiguration } from './client-configuration'

export function daemonPackageName() { return getClientConfiguration().daemonPackageName }

/** Exported as the web module does (scripts/alias-exports.test.mjs); the desktop app shows no download offer. */
export function desktopReleasesUrl() { return DESKTOP_RELEASES_URL }
