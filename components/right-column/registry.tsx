'use client'

import { useCallback, useMemo, type ReactNode } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import type { ThreadPanelGroup, ThreadPanelTab, ThreadPanelTabId } from '@/components/slots/thread-contract'
import { ChangesTab } from './changes-tab'
import dynamic from '@/lib/client-runtime/dynamic'
import { SetupTab } from './setup-tab'
import { RightColumnNavigation, type RightColumnScope } from './scope'

// The file tree (@pierre/trees) loads when the Files tab opens.
const FilesTab = dynamic(() => import('./files-tab').then(module => module.FilesTab))

export { RightColumnNavigation, useRightColumnNavigation, type RightColumnScope } from './scope'

/** A message by its full key (`messages/*.json`). */
type Translate = (key: string) => string

/**
 * One tab the right column can open (#2927). The ＋ menu lists the definitions available in the conversation, in this
 * order, under their group (Figma 1318:11: 常用, 相关, Crew, 终端); picking one opens it once and brings it to the front.
 *
 * To add a tab (the PR tab of #2929, the Coordinator's Tasks of #2930, a terminal), add a definition here:
 * - `id`: a `ThreadPanelTabId` (thread-contract.ts); widen that union for a new kind of id;
 * - `group` and `shortcut` (shown in the menu, and bound by the hosted screen: ⇧⌘G, ⌘P, ⇧⌘B);
 * - `available(scope)`: whether this conversation offers it (a thread, a Bot's chat, the Coordinator's);
 * - `title(t)`: its name, from `messages/*.json`;
 * - `render(scope)`: its content, or leave it out for a tab whose content the page hands in (`useRightColumnTabs`'s
 *   `page`: the Overview and the browser, which need the page's own state).
 * `meta(scope)` adds muted words on the right of its menu row. Ids the chat opens itself (`task:`, `thread:`) are not here.
 */
export type RightColumnTabDefinition = {
  id: ThreadPanelTabId
  group: ThreadPanelGroup
  shortcut?: string
  available?: (scope: RightColumnScope) => boolean
  title: (t: Translate) => string
  render?: (scope: RightColumnScope) => ReactNode
  meta?: (scope: RightColumnScope, t: Translate) => string | undefined
}

const thread = (scope: RightColumnScope) => scope.kind === 'thread'

export const RIGHT_COLUMN_TABS: readonly RightColumnTabDefinition[] = [
  { id: 'overview', group: 'common', title: t => t('Shell.panel.overview') },
  { id: 'changes', group: 'common', shortcut: '⇧⌘G', available: thread, title: t => t('RightColumn.tabs.changes'),
    render: scope => scope.kind === 'thread' ? <ChangesTab key={scope.runId} scope={scope} /> : null },
  { id: 'files', group: 'common', shortcut: '⌘P', title: t => t('RightColumn.tabs.files'), render: scope => <FilesTab key={scopeKey(scope)} scope={scope} /> },
  { id: 'setup', group: 'common', title: t => t('RightColumn.tabs.setup'), render: scope => <SetupTab key={scopeKey(scope)} scope={scope} /> },
  { id: 'browser', group: 'common', shortcut: '⇧⌘B', title: t => t('Browser.label') },
]

const scopeKey = (scope: RightColumnScope) => scope.kind === 'thread' ? `thread:${scope.runId}` : `bot:${scope.botId ?? 'coordinator'}`

/**
 * The right column's tabs for a conversation: every available definition, with the page's own content where the page
 * supplies it (`page`, by id). A definition with neither `render` nor page content is left out.
 */
export function useRightColumnTabs(scope: RightColumnScope | null, page: Partial<Record<ThreadPanelTabId, { content: ReactNode; title?: string }>>,
  /** Brings a tab to the front; each tab's content gets it (useRightColumnNavigation), since it renders in the frame's column. */
  show: (id: ThreadPanelTabId) => void): ThreadPanelTab[] {
  const translate = useTranslations()
  const t = useCallback<Translate>(key => translate(key as never), [translate])
  const navigation = useMemo(() => ({ show }), [show])
  return useMemo(() => !scope ? [] : RIGHT_COLUMN_TABS.flatMap((definition): ThreadPanelTab[] => {
    if (definition.available && !definition.available(scope)) return []
    const given = page[definition.id]
    const content = given?.content ?? definition.render?.(scope)
    if (content === undefined || content === null) return []
    return [{ id: definition.id, title: given?.title ?? definition.title(t), content: <RightColumnNavigation value={navigation}>{content}</RightColumnNavigation>,
      menu: { group: definition.group, ...(definition.shortcut ? { shortcut: definition.shortcut } : {}), ...(definition.meta?.(scope, t) ? { meta: definition.meta(scope, t) } : {}) } }]
  }), [scope, page, t, navigation])
}
