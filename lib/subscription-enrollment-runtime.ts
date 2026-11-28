import 'server-only'
import { retainEnrollmentSourcesForAcceptance } from './subscription-enrollment-policy'
import type { EnrollmentConfiguration } from './subscription-enrollment'
import { readEnv } from '@/lib/env/server'

// No DB/auth/reader dependency: first consent remains a custody-only operation.
export function enrollmentConfiguration(): EnrollmentConfiguration {
  const config = {
    binary: readEnv('MIKKA_BYOS_ENROLLMENT_BINARY'),
    infisicalOrigin: readEnv('MIKKA_BYOS_INFISICAL_ORIGIN'),
    project: readEnv('MIKKA_BYOS_INFISICAL_PROJECT'),
    environment: readEnv('MIKKA_BYOS_INFISICAL_ENVIRONMENT'),
    workloadToken: readEnv('MIKKA_BYOS_INFISICAL_TOKEN'),
    attemptPath: readEnv('MIKKA_BYOS_ENROLLMENT_ATTEMPT_PATH'),
    claimPath: readEnv('MIKKA_BYOS_ENROLLMENT_CLAIM_PATH'),
    grantPath: readEnv('MIKKA_BYOS_ENROLLMENT_GRANT_PATH'),
  }
  if (Object.values(config).some(value => !value)) throw new Error('subscription_enrollment_unavailable')
  // The isolated acceptance deployment retains its test records pending approval.
  return { ...config, retainSources: retainEnrollmentSourcesForAcceptance() } as EnrollmentConfiguration
}
