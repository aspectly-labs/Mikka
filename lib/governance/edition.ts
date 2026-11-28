import { getEdition } from '@/lib/edition'
import { runtimeEnv } from '@/lib/env/server'
import type { DeploymentMode } from './policy'

/** Use the deployment's canonical edition, independent of billing and request headers. */
export function deploymentMode(env: Readonly<Record<string, string | undefined>> = runtimeEnv()): DeploymentMode {
  return getEdition(env) === 'cloud' ? 'cloud' : 'selfhost'
}
