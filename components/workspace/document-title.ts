'use client'

import { useEffect } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'

/** The tab's name when no chat names it. */
export const APP_TITLE = 'Mikka'

/**
 * The window's title names the chat in the centre (UX audit 2026-11-22 #3): the Bot's chat, the group or the
 * thread, then Mikka — 「工程 Bot · Mikka」. Any other page, or a chat whose name has not loaded yet, is Mikka.
 */
export function useDocumentTitle(name: string | null | undefined) {
  const t = useTranslations('Workspace')
  const title = name?.trim() ? t('documentTitle', { name: name.trim() }) : APP_TITLE
  useEffect(() => { document.title = title }, [title])
}
