import { gatewayLiteLlm } from './model-gateway/config'
import { runtimeEnv } from '@/lib/env/server'

type Env = Record<string, string | undefined>

/** Configuration readiness without making a model request. */
export function defaultModelConfigured(env: Env = runtimeEnv()): boolean {
  return gatewayLiteLlm(env) !== null
}
