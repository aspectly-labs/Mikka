import { getClientConfiguration } from './client-configuration'

export function daemonPackageName() { return getClientConfiguration().daemonPackageName }

/** Same canonical release page as lib/platform/client-config.ts; the dialog only
 * offers it on the web runtime, but the shared import must resolve here too. */
export function desktopReleasesUrl() { return 'https://github.com/alexj11324/Mikka/releases/latest' }
