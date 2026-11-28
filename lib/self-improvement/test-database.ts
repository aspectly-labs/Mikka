import { isLoopbackHost, LOCALHOST_HOSTNAME } from '@/lib/env/hosts'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
/** Test-only target resolution. Never use either application's database fallback. */
export function improvementTestDatabase(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const required = env.REQUIRE_DB === '1'
  const explicit = env.IMPROVEMENT_TEST_URL
  const disposable = required && disposableDatabase(env)
  const value = explicit ?? (disposable ? env.E2E_DATABASE_URL : undefined)
  if (!value) {
    if (required) throw new Error('Self-improvement database is required; refusing to skip')
    return undefined
  }
  const target = new URL(value)
  const local = isLoopbackHost(target.hostname)
  const standalone = target.pathname === '/mikka_improvement'
  const shared = !explicit && disposable && value === env.E2E_DATABASE_URL
    && value === env.MIKKA_DATABASE_URL && value === env.DATABASE_URL
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !local || target.search || target.hash
    || (!standalone && !shared)) throw new Error(`Self-improvement tests require an isolated ${LOCALHOST_HOSTNAME} test database`)
  return value
}
