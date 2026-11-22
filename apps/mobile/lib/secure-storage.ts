// Unsigned simulator builds cannot use the keychain: expo-secure-store
// fails every call with a missing-entitlement error, so dev builds on the
// iOS simulator fall back to a JSON file in the app sandbox. Release builds
// and real devices always use SecureStore.
import * as Device from 'expo-device'
import { File, Paths } from 'expo-file-system'
import * as ExpoSecureStore from 'expo-secure-store'
import { Platform } from 'react-native'

type JsonMap = Record<string, string>

// Lazy: Paths.document is undefined on web and the Directory constructor
// throws before secureStorage's platform guard can run.
function file() {
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

export const secureStorage = __DEV__ && Platform.OS === 'ios' && !Device.isDevice
  ? devFileStorage
  : ExpoSecureStore
