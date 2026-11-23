/**
 * A dialog whose code loads the first time it opens, then stays mounted so its
 * close (and any later open) animates as before. Until then it renders nothing,
 * which is what a closed dialog renders anyway.
 */
import { lazy, Suspense, useState, type ComponentType } from 'react'

export function lazyDialog<Props extends { open?: boolean }>(loader: () => Promise<ComponentType<Props>>) {
  let loading: Promise<{ default: ComponentType<Props> }> | null = null
  const load = () => loading ??= loader().then(component => ({ default: component }))
  const Component = lazy(load)
  function LazyDialog(props: Props) {
    const [opened, setOpened] = useState(Boolean(props.open))
    if (props.open && !opened) setOpened(true)
    return opened ? <Suspense fallback={null}><Component {...props} /></Suspense> : null
  }
  /** Starts loading the dialog's code without opening it (e.g. on hover of what opens it). */
  LazyDialog.preload = () => { void load().catch(() => {}) }
  return LazyDialog
}
