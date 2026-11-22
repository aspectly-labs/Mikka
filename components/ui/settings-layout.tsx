import type { ComponentProps, ReactNode } from 'react'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@/components/ui/field'
import { cn } from '@/lib/utils'

/**
 * Settings content column (#3118):
 * - Standard pages: 564px inner width (`612px` with 24px horizontal padding).
 * - Wide table pages: 776px inner width (`824px` with 24px horizontal padding).
 * - Minimum 24px (`px-6`) right padding so the right edge stays `<= 1076` inside the 1100px shell.
 */
export function SettingsContent({ wide = false, className, ...props }: ComponentProps<'div'> & { wide?: boolean }) {
  return <div data-wide={wide ? 'true' : undefined} className={cn('mx-auto flex w-full flex-col gap-6 px-6 py-8 sm:py-10', wide ? 'max-w-[824px]' : 'max-w-[612px]', className)} {...props} />
}

export function SettingsGroup({ className, ...props }: ComponentProps<typeof FieldGroup>) {
  return <FieldGroup className={cn('gap-0 rounded-lg border bg-muted/30 px-4', className)} {...props} />
}

export function SettingsRow({ title, description, htmlFor, descriptionId, children, ...props }: Omit<ComponentProps<typeof Field>, 'title' | 'children'> & { title: string; description?: ReactNode; htmlFor?: string; descriptionId?: string; children: ReactNode }) {
  return <Field orientation="responsive" className="min-h-14 gap-3 py-3.5 @md/field-group:has-[>[data-slot=field-content]]:items-center" {...props}>
    <FieldContent className="min-w-0 gap-0.5">{htmlFor ? <FieldLabel htmlFor={htmlFor}>{title}</FieldLabel> : <FieldTitle>{title}</FieldTitle>}{description && <FieldDescription id={descriptionId}>{description}</FieldDescription>}</FieldContent>
    <div data-slot="settings-control" className="flex min-w-0 items-center gap-2 @md/field-group:shrink-0">{children}</div>
  </Field>
}

/** Borderless settings table (#3118): muted header band (`r=8`) + flat rows (`r=0`) + thin row dividers. */
export function SettingsTable({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-settings-table
      className={cn(
        '[&_thead_tr]:border-b-0 [&_thead_th]:bg-muted/60 [&_thead_th:first-child]:rounded-l-lg [&_thead_th:last-child]:rounded-r-lg [&_tbody_tr]:rounded-none [&_tbody_tr]:border-border/70',
        className,
      )}
      {...props}
    />
  )
}
