import { getClientConfiguration } from './client-configuration'

export function daemonPackageName() { return getClientConfiguration().daemonPackageName }

/** The desktop build of `@/lib/platform/client-config` exports what the web one does: shared components
 * (components/devices/connect-device-dialog.tsx) import both names. The desktop app is already installed, so it
 * shows no download offer, but the release page is the same canonical address (lib/server-info.ts). */
export function desktopReleasesUrl() { return 'https://github.com/alexj11324/Mikka/releases/latest' }
