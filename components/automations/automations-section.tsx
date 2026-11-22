'use client'

import { useSearchParams } from '@/lib/client-runtime/navigation'
import { goToHref } from '@/components/workspace/workspace-navigation'
import { AutomationEditor } from './automation-editor'
import { AutomationsPage } from './automations-page'
import { isAutomationTemplate } from './automation-templates'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 自动化: the list, or one automation when the address names it (`automation=<id>`, `automation=new`,
 * `automation=new:<template>`, or `automation=thread:<thread id>` for a new one that runs in that thread, #2936).
 */
export function AutomationsSection({ workspaceId, userId, onAskBot }: { workspaceId: string | null; userId: string; onAskBot: (text: string) => void }) {
  const params = useSearchParams()
  const value = params.get('automation')
  const named = value?.startsWith('new:') ? value.slice(4) : null
  const template = named && isAutomationTemplate(named) ? named : undefined
  const thread = value?.startsWith('thread:') && UUID.test(value.slice(7)) ? value.slice(7) : undefined
  const open = value === 'new' || template || thread || (value && UUID.test(value)) ? value : null
  const href = (next: string | null) => {
    // From the params React renders with, so the server render and the first client render agree.
    const query = new URLSearchParams(params.toString())
    query.set('section', 'automations')
    if (next) query.set('automation', next)
    else query.delete('automation')
    return `?${query.toString()}`
  }
  const go = (next: string | null, mode: 'push' | 'replace' = 'push') => goToHref(href(next), mode)
  if (open) return <AutomationEditor key={open} workspaceId={workspaceId} userId={userId} id={template || thread ? 'new' : open} template={template} fromThread={thread} onBack={() => go(null)} onOpen={id => go(id, 'replace')} />
  return <AutomationsPage workspaceId={workspaceId} userId={userId} href={href} onOpen={id => go(id)} onAskBot={onAskBot} />
}
