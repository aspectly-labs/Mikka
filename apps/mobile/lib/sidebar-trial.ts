import { useSyncExternalStore } from 'react'
import { Platform } from 'react-native'
import { secureStorage as SecureStore } from './secure-storage'

/**
 * 试用侧边栏: a switch in 设置, off by default and kept on this phone, that puts the bot sidebar around the tabs so
 * Alex can try its feel on TestFlight (2026-11-24). Off, the app is exactly as before.
 */
const KEY = 'mikka.sidebar_trial'

let enabled = false
let loaded = false
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }

const read = async () => Platform.OS === 'web' ? globalThis.localStorage?.getItem(KEY) ?? null : SecureStore.getItemAsync(KEY)
const write = async (value: string) => {
  if (Platform.OS === 'web') globalThis.localStorage?.setItem(KEY, value)
  else await SecureStore.setItemAsync(KEY, value)
}

function load() {
  if (loaded) return
  loaded = true
  read().then(raw => {
    // A tap on the switch can land before this read; the tap wins.
    if (raw === '1' && !enabled) { enabled = true; emit() }
  }, () => undefined)
}

function subscribe(listener: () => void) {
  load()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function setSidebarTrial(next: boolean) {
  loaded = true
  if (enabled === next) return
  enabled = next
  emit()
  void write(next ? '1' : '0').catch(() => undefined)
}

/** Whether the sidebar trial is on for this phone. */
export function useSidebarTrial(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => false)
}

/** The bot whose chat the trial's 聊天 tab shows: null is the Coordinator. Kept for this launch only. */
let sidebarBot: string | null = null
const botListeners = new Set<() => void>()

export function setSidebarBot(id: string | null) {
  if (sidebarBot === id) return
  sidebarBot = id
  for (const listener of botListeners) listener()
}

export function useSidebarBot(): string | null {
  return useSyncExternalStore(listener => { botListeners.add(listener); return () => { botListeners.delete(listener) } }, () => sidebarBot, () => null)
}
