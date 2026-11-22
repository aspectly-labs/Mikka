/**
 * How full a conversation's context is, as a small ring beside the composer (Figma `1318:2` sections 01 and 14, as
 * Capy draws it): the share at a glance, the figures on hover and in the panel it opens. It replaces the words
 * 「上下文 23.4K / 100K」, which Alex found noisy (#2921, 2026-11-22).
 */
export function ContextRing({ share }: { /** 0–100 */ share: number }) {
  const value = Number.isFinite(share) ? Math.min(100, Math.max(0, share)) : 0
  const radius = 5.5, circumference = 2 * Math.PI * radius
  return <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden="true" data-slot="context-ring" data-share={Math.round(value)}>
    <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-25" />
    <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value / 100)} />
  </svg>
}
