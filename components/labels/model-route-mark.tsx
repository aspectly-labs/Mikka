'use client'

import { KeyRound } from '@/components/icons'
import type { BotModelRoute } from '@/lib/bot-model-menu-view'
import { ClaudeMark, CodexMark } from './brand-marks'
import { ModelVendorMark } from './model-vendor-mark'


/**
 * A model as the picker draws it by its route (Figma 1318:71, #2925, as Capy's model-picker-lab): Mikka 额度 shows
 * the model's vendor; a subscription shows the service's own mark (Claude, or Codex for a ChatGPT plan), with no badge;
 * the person's own key shows the vendor with a key in a notch at its bottom-right corner, in the foreground colour.
 */
export function ModelRouteMark({ model, route }: { model: string; route?: Pick<BotModelRoute, 'source' | 'service'> }) {
  if (route?.source === 'subscription') {
    const Mark = route.service === 'codex' ? CodexMark : ClaudeMark
    return <Mark aria-hidden="true" data-route="subscription" className="size-4 shrink-0" />
  }
  if (route?.source === 'byok') return <span aria-hidden="true" data-route="byok" className="relative inline-flex size-4 shrink-0">
    {/* The vendor mark's bottom-right corner is cut away, so the key sits clear of it on any surface colour. */}
    <span className="inline-flex size-4 [mask-image:radial-gradient(circle_at_100%_100%,transparent_7px,black_7.5px)]"><ModelVendorMark model={model} /></span>
    <KeyRound className="absolute -right-0.5 -bottom-0.5 size-2.5 text-foreground" />
  </span>
  return <ModelVendorMark model={model} />
}
