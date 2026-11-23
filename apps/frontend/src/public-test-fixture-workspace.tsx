'use client'

import { syncCoordinatorChat } from '@/app/actions/coordinator'
import { loadEarlierIssueActivity, pollIssue, pollIssueActivityPage, syncIssueList } from '@/app/actions/issues'
import { syncThreadList } from '@/app/actions/task-runs'
import type { WorkspaceEntryProps } from '@/components/slots/workspace-entry-contract'

/**
 * Measured read RPC actions kept reachable in `--public-test-fixture` builds
 * when `.hosted-ui/` is absent, so `renderer-actions.json` preserves the
 * contract verified by read-cache acceptance without exposing a real workspace.
 */
export const PUBLIC_TEST_FIXTURE_READ_ACTIONS = Object.freeze({
  syncCoordinatorChat,
  syncIssueList,
  syncThreadList,
  pollIssue,
  pollIssueActivityPage,
  loadEarlierIssueActivity,
})

export function Workspace(_props: WorkspaceEntryProps): never {
  void PUBLIC_TEST_FIXTURE_READ_ACTIONS
  throw new Error('SERVER_DOCUMENT_CANNOT_LOAD_WORKSPACE')
}
