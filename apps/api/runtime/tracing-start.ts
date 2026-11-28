import { startTracing } from '@/lib/tracing/node'
import { runtimeEnv } from '@/lib/env/server'

// The build's Node and Vercel entry wrappers load this module before dynamically
// importing the application, including Workflow handlers. A Nitro plugin alone
// is too late: static route/step imports can already have loaded pg by then.
// Keep the same best-effort diagnostics policy as instrumentation.ts.
export function startBuildTracing(revision?: string): void {
  try {
    const env = runtimeEnv()
    // Release artifacts use the same immutable source revision as mikka-build.json.
    // The dev launcher has no artifact revision and retains its runtime settings.
    startTracing(revision ? { ...env, MIKKA_BUILD_REVISION: revision } : env)
  } catch (error) {
    console.error('Tracing did not start', error instanceof Error ? error.name : 'unknown')
  }
}
