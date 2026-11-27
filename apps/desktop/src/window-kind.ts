/** One spelling for the renderer window-kind flag, shared by the main writer and the preload reader. */
export const WINDOW_KIND_ARGUMENT = '--mikka-window-kind='

export type WindowKind = 'main' | 'child'

export function windowKindArgument(kind: WindowKind): string {
  return `${WINDOW_KIND_ARGUMENT}${kind}`
}

export function windowKindFromArgv(argv: readonly string[]): WindowKind | null {
  const value = argv.find(argument => argument.startsWith(WINDOW_KIND_ARGUMENT))?.slice(WINDOW_KIND_ARGUMENT.length)
  return value === 'main' || value === 'child' ? value : null
}

/** Only the main renderer owns tray state, including its sign-out reset. */
export function trayBridge(kind: WindowKind | null, update: (state: unknown) => Promise<void>) {
  return kind === 'main' ? { update } : undefined
}
