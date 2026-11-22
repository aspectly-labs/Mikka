/** Existing public deployment override, read when a client builds its commands. */
export function daemonPackageName() {
  return process.env.NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME ?? '@aspectlylabs/mikka'
}

/** Where a person on the web can get the desktop app, which adds its own computer
 * as a device without a terminal. The canonical GitHub release page (server-info.ts
 * serves the same address to installed clients). */
export function desktopReleasesUrl() {
  return 'https://github.com/alexj11324/Mikka/releases/latest'
}
