'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { Search } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { ShortcutKeys } from '@/components/shortcut-keys'

/** The search pill centered in the window bar (Comma's shell); it opens the results below it. */
export function SearchPill({ onSearch }: { onSearch: () => void }) {
  const t = useTranslations('Shell')
  return <Button variant="outline" size="sm" aria-label={t('searchLabel')} aria-keyshortcuts="Control+k Meta+k" onClick={onSearch} className="h-7 w-full min-w-0 justify-center gap-2 rounded-full px-3 text-xs font-normal text-muted-foreground hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
    <Search data-icon="inline-start" />
    <span className="truncate">{t('searchPlaceholder')}</span>
    {/* Keycaps a step off the pill, so Ctrl and K read as keys in light mode too (chat-12, work-15). */}
    <ShortcutKeys keys={['mod', 'K']} className="*:data-[slot=kbd]:bg-muted" />
  </Button>
}
