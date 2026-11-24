import { createContext, useContext } from 'react'

/**
 * Opens the sidebar trial's drawer from a tab root's bar button (features/shell/components/sidebar.tsx provides it);
 * null where there is no sidebar: the trial is off, the platform is not iOS, or the page is pushed over the tabs.
 * Kept apart from the drawer so screens can read it without loading the drawer.
 */
export const SidebarOpener = createContext<(() => void) | null>(null)
export const useOpenSidebar = () => useContext(SidebarOpener)
