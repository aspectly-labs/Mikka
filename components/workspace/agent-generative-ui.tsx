'use client'

import { lazy, Suspense, useMemo } from 'react'
import type { ActionEvent } from '@openuidev/react-lang'
import { detectAgentUISource, isAgentUISourcePrefix } from '@/lib/agent-ui-source'
import { AgentMarkdown } from './agent-markdown'
import { AgentTextBubble } from './agent-text-bubble'

export { actionPrompt } from './agent-ui-action'

// The OpenUI renderer and its library (react-ui, every lucide icon, charts,
// tables, syntax highlighting) load only when a reply holds a card. Once
// loaded it renders in place, without a Suspense boundary.
type OpenUIModule = typeof import('./agent-openui')
let loaded: OpenUIModule['AgentOpenUI'] | null = null
let loading: Promise<OpenUIModule> | null = null
/** Starts (once) and resolves the OpenUI renderer module. */
export function preloadAgentOpenUI() {
  loading ??= import('./agent-openui').then(module => {
    loaded = module.AgentOpenUI
    return module
  })
  return loading
}
const LazyOpenUI = lazy(() => preloadAgentOpenUI().then(module => ({ default: module.AgentOpenUI })))

export function AgentGenerativeUI({ response, isStreaming, onAction, showErrors = true, onRetry }: {
  response: string
  isStreaming: boolean
  onAction: (event: ActionEvent) => void
  showErrors?: boolean
  onRetry?: () => void
}) {
  const detected = useMemo(() => detectAgentUISource(response), [response])

  if (!detected.isOpenUI) return isStreaming && isAgentUISourcePrefix(response) ? null : <AgentTextBubble><AgentMarkdown text={response} isStreaming={isStreaming} /></AgentTextBubble>

  const props = { response, normalizedResponse: detected.source, isStreaming, onAction, showErrors, onRetry }
  const Loaded = loaded
  return Loaded ? <Loaded {...props} /> : <Suspense fallback={null}><LazyOpenUI {...props} /></Suspense>
}
