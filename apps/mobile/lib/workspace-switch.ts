import { mobileMessages } from './messages'

/**
 * Switching workspace (设置 › 工作区): save the pick, read settings back, and
 * keep the old workspace when the server did not take it or could not be
 * reached. Returns null on success, else the line to show.
 */
export async function switchWorkspace(target: { id: string; name: string }, previous: string | null, deps: {
  /** Its result is not read: a guarded save (lib/task-push.ts) throws instead of writing into a context it lost. */
  save: (id: string) => Promise<unknown>
  current: () => Promise<string>
}): Promise<string | null> {
  try {
    await deps.save(target.id)
    if (await deps.current() === target.id) return null
    if (previous) await deps.save(previous)
    return mobileMessages.MobileCore.workspaceSwitch.notMember.replace('{name}', () => target.name)
  } catch {
    if (previous) await deps.save(previous).catch(() => undefined)
    return mobileMessages.MobileCore.workspaceSwitch.unreachable.replace('{name}', () => target.name)
  }
}
