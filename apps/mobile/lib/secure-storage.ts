// Unsigned simulator builds cannot use the keychain: expo-secure-store
// fails every call with a missing-entitlement error, so dev builds on the
// iOS simulator fall back to a JSON file in the app sandbox. Release builds
// and real devices always use SecureStore.
import * as ExpoSecureStore from 'expo-secure-store'
import { Platform } from 'react-native'

type JsonMap = Record<string, string>

// expo-device and expo-file-system are lazily required: statically importing
// them pulls in the Expo runtime, which crashes under Node test runners (and
// Paths.document is undefined on web, where Directory's constructor throws)
// before the platform guard can run. Metro and tsx both supply `require`.
declare const require: (id: string) => unknown
function isSimulator() {
  return (require('expo-device') as typeof import('expo-device')).isDevice === false
}
function file() {
  const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system')
  return new File(Paths.document, 'mikka-dev-storage.json')
}

function read(): JsonMap {
  try {
    const target = file()
    if (!target.exists) return {}
    const parsed: unknown = JSON.parse(target.textSync())
    return parsed && typeof parsed === 'object' ? parsed as JsonMap : {}
  } catch {
    return {}
  }
}

function write(map: JsonMap) {
  try {
    const target = file()
    if (!target.exists) target.create({ intermediates: true })
    target.write(JSON.stringify(map))
  } catch { /* ignore */ }
}

const devFileStorage = {
  getItemAsync: async (key: string) => read()[key] ?? null,
  setItemAsync: async (key: string, value: string) => { const map = read(); map[key] = value; write(map) },
  deleteItemAsync: async (key: string) => { const map = read(); delete map[key]; write(map) },
  getItem: (key: string) => read()[key] ?? null,
  setItem: (key: string, value: string) => { const map = read(); map[key] = value; write(map) },
  deleteItem: (key: string) => { const map = read(); delete map[key]; write(map) },
  isAvailableAsync: async () => true,
}

// __DEV__ is a Metro-injected global absent under Node test runners.
const isDev = (globalThis as { __DEV__?: boolean }).__DEV__ === true
export const secureStorage = isDev && Platform.OS === 'ios' && isSimulator()
  ? devFileStorage
  : ExpoSecureStore
