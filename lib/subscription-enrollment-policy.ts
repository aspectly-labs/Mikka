import { runtimeEnv } from './env/runtime.mjs'

// Test-record retention is not product authorization. Production always keeps
// its normal owner-requested disconnect/delete and retry lifecycle.
export function retainEnrollmentSourcesForAcceptance(env: Record<string, string | undefined> = runtimeEnv()): boolean {
  return env.VERCEL_ENV === 'preview' && env.MIKKA_BYOS_ACCEPTANCE_RETAIN_SOURCES === '1'
}
