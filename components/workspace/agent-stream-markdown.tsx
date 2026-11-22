'use client'

import { Streamdown, type StreamdownProps } from '@lobehub/streamdown'
import { STREAM_TAIL_HANDLERS } from '@/lib/stream-markdown'

/** remend's pass over the open tail: Mikka's handlers first; raw HTML is dropped anyway, so no tag is completed. */
const REMEND: NonNullable<StreamdownProps['remend']> = { htmlTags: false, handlers: [...STREAM_TAIL_HANDLERS] }

export type AgentStreamMarkdownProps = Pick<StreamdownProps, 'components' | 'remarkPlugins' | 'rehypePlugins'> & {
  text: string
  /** The reply has formulas: hold the last frame while the newest one is still incomplete. */
  math?: boolean
}

/**
 * A reply while it arrives, through LobeHub's streaming engine (@lobehub/streamdown, as lobe-ui's chat): the text is
 * revealed at the pace it arrives (the `balanced` preset), the open tail is closed before parsing so a half-written
 * `**`, link, code fence or table never shows its markers, each new character fades in, and a block once finished is
 * parsed and drawn once, not again on every token. Loaded only for a reply that streams (agent-markdown.tsx).
 */
export function AgentStreamMarkdown({ text, math = false, components, remarkPlugins, rehypePlugins }: AgentStreamMarkdownProps) {
  return <Streamdown content={text} components={components} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} skipHtml
    remend={REMEND} latexGuard={math} smoothing="balanced" granularity="char" />
}
