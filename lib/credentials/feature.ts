import { deploymentSwitch } from '@/lib/deployment-switches'
import { runtimeEnv, type EnvMap } from '@/lib/env/server'
/** Availability is not a credential grant. Current owner/run authorization,
 * page binding and the configured KMS/broker remain required by the runtime. */
export function credentialVaultEnabled(env: EnvMap = runtimeEnv()): boolean {
  return deploymentSwitch('credentialVault', env)
}
