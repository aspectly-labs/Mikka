/**
 * Unsent drafts and scoped browsing state belong to the authenticated person
 * (drafts and prompt history in localStorage, the rest in the window's session). A successful logout clears them without removing browser preferences.
 */
export const CHAT_DRAFT_PREFIX = 'mikka:draft:'
export const VIEW_STATE_PREFIX = 'mikka:view:'
export const CLEAR_VIEW_STATE_EVENT = 'mikka:clear-view-state'

export function clearChatDrafts() {
  // Logout awaits read-cache cleanup before navigation can unmount the current
  // views. Retire their writers synchronously before removing their stored state.
  if (typeof window !== 'undefined') window.dispatchEvent(new window.Event(CLEAR_VIEW_STATE_EVENT))
  // Drafts and prompt history are kept in localStorage so they survive a closed window; logout removes them too.
  for (const storage of [() => sessionStorage, () => localStorage]) {
    try {
      const store = storage()
      for (const key of Object.keys(store)) {
        if (key.startsWith(CHAT_DRAFT_PREFIX) || key.startsWith(VIEW_STATE_PREFIX)) store.removeItem(key)
      }
    } catch { /* storage may be unavailable */ }
  }
}
