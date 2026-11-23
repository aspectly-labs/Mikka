'use client'

import type { WorkspaceEntryProps } from '@/components/slots/workspace-entry-contract'

/**
 * Public headless fallback for the hosted workspace entry point.
 * Official web and desktop builds bind `@ui-slot/workspace-entry` to `.hosted-ui/slots/workspace-entry.tsx`.
 */
export function Workspace(_props: WorkspaceEntryProps): never {
  throw new Error('SERVER_DOCUMENT_CANNOT_LOAD_WORKSPACE')
}
