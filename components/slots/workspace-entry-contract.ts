import type { DesktopBootstrap } from '@/apps/desktop/src/renderer/bootstrap'
import type { DesktopSession } from '@/apps/desktop/src/renderer/host'
import type { PreparedLiveChannels } from '@/lib/live/preparation'

export type WorkspaceEntryProps = {
  user: DesktopSession['user']
  bootstrap: DesktopBootstrap
  livePreparation?: PreparedLiveChannels
}
