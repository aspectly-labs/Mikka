import 'server-only'
import { isDevelopmentEnv, readEnv } from '@/lib/env'

export function isAcceptanceEnabled() {
  return isDevelopmentEnv() && readEnv('VERCEL_ENV') !== 'production'
}
