/** Shortcuts and tray clicks go to the update window while the server requires an update. */
export function guardAppAction<T extends unknown[]>(blocked: () => boolean, showGate: () => void, action: (...args: T) => void) {
  return (...args: T) => { if (blocked()) showGate(); else action(...args) }
}

export function closeWindowTarget(main: boolean, appPage: boolean, closeTab: () => void, closeWindow: () => void) {
  if (!main) closeWindow()
  else if (appPage) closeTab()
}
