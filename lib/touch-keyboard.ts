/**
 * A touch keyboard is in use: Enter there starts a new line and Send stays the button (as in every mature chat app's
 * phone composer). A coarse pointer, or a shown virtual keyboard; no user-agent sniffing.
 */
export function touchKeyboard(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(pointer: coarse)').matches) return true
  const keyboard = (navigator as Navigator & { virtualKeyboard?: { boundingRect?: DOMRect } }).virtualKeyboard
  return (keyboard?.boundingRect?.height ?? 0) > 0
}
