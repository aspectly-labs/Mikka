import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  clearRuntimeConfigOverrides,
  getRuntimeConfig,
  overrideRuntimeConfig,
  resetRuntimeConfig,
} from '@/lib/runtime-config'
import { deploymentMode } from './edition'
import {
  ORGANIZATION_MODEL_PROVIDERS,
  PLAN_CAPABILITY_PROFILES,
  WORKSPACE_CAPABILITY_OWNERS,
  csvCell,
  resolveEntitlements,
  resolveWorkspaceCapabilities,
  seatAdmissionAllowed,
  workspaceCapabilitiesSchema,
} from './policy'

test('governance follows the canonical deployment edition, independent of hosting and billing', () => {
  assert.equal(deploymentMode({}), 'selfhost')
  assert.equal(deploymentMode({ VERCEL_ENV: 'production' }), 'selfhost')
  assert.equal(deploymentMode({ VERCEL_ENV: 'preview' }), 'selfhost')
  assert.equal(deploymentMode({ VERCEL_ENV: 'production', MIKKA_EDITION: 'community', STRIPE_SECRET_KEY: 'configured' }), 'selfhost')
  assert.equal(deploymentMode({ MIKKA_EDITION: 'cloud' }), 'cloud')
  assert.equal(deploymentMode({ MIKKA_EDITION: ' cloud ' }), 'cloud')
  assert.equal(deploymentMode({ MIKKA_EDITION: '   ', VERCEL_ENV: 'production' }), 'selfhost')
  assert.throws(() => deploymentMode({ MIKKA_EDITION: 'other' }), /MIKKA_EDITION_INVALID/)
})

test('shared plans admit unlimited members and retain capacity limits', () => {
  const cloud = resolveEntitlements({ mode: 'cloud', kind: 'team' })
  const community = resolveEntitlements({ mode: 'selfhost', kind: 'team' })
  assert.equal(cloud.activeHumanLimit, null)
  assert.equal(cloud.approvalTemplates, false)
  assert.equal(cloud.hostedMaxInFlight, 8)
  assert.equal(community.activeHumanLimit, null)
  assert.equal(community.usageExport, true)
  assert.equal(seatAdmissionAllowed({ current: 5, limit: 5, alreadyActive: false }), false)
  assert.equal(seatAdmissionAllowed({ current: 5, limit: 5, alreadyActive: true }), true)
  assert.equal(seatAdmissionAllowed({ current: 999, limit: null, alreadyActive: false }), true)
})

test('paid grants have bounded expiry, deployment source and personal isolation', () => {
  const now = new Date('2026-11-07T00:00:00Z')
  const grant = { plan: 'pro' as const, source: 'cloud' as const, seatLimit: 20, expiresAt: new Date('2026-11-08T00:00:00Z') }
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant, now }).activeHumanLimit, null)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'personal', grant, now }).activeHumanLimit, 1)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant, now }).approvalTemplateLimit, 100)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant, now }).hostedMaxInFlight, 32)
  assert.equal(resolveEntitlements({ mode: 'selfhost', kind: 'team', grant, now }).edition, 'community')
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'personal', grant, now }).edition, 'personal')
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant: { ...grant, expiresAt: now }, now }).edition, 'team_free')
  assert.equal(resolveEntitlements({ mode: 'selfhost', kind: 'team', grant: { ...grant, plan: 'enterprise', source: 'license' }, now }).edition, 'enterprise')
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant: { ...grant, source: 'license' }, now }).edition, 'team_free')
})

test('downgrade changes capacity without refusing member admission', () => {
  const free = resolveEntitlements({ mode: 'cloud', kind: 'team' })
  assert.equal(seatAdmissionAllowed({ current: 12000, limit: free.activeHumanLimit, alreadyActive: false }), true)
  assert.equal(free.hostedMaxInFlight, 8)
})

test('Stripe projection combines with operator grants, expires independently, and cannot grant self-hosted access', () => {
  const now = new Date('2026-11-10T00:00:00Z'), future = new Date('2026-12-10T00:00:00Z')
  const billing = { plan: 'free' as const, source: 'cloud' as const, seatLimit: null, expiresAt: null,
    billingPlan: 'pro' as const, billingExpiresAt: future }
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant: billing, now }).hostedMaxInFlight, 32)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant: { ...billing, billingExpiresAt: null }, now }).hostedMaxInFlight, 8)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant: billing, now: future }).hostedMaxInFlight, 8)
  assert.equal(resolveEntitlements({ mode: 'selfhost', kind: 'team', grant: billing, now }).hostedMaxInFlight, 8)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'personal', grant: billing, now }).hostedMaxInFlight, 8)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grants: [billing, { ...billing, plan: 'enterprise', billingPlan: 'free' }], now }).hostedMaxInFlight, 128)
})

test('CSV contains literal data, not spreadsheet formulas', () => {
  assert.equal(csvCell('hello,"world"'), '"hello,""world"""')
  for (const prefix of ['=', '+', '-', '@', ' \t=']) assert.equal(csvCell(`${prefix}SUM(A1:A2)`), `"'${prefix}SUM(A1:A2)"`)
  assert.equal(csvCell(123), '"123"')
  assert.equal(csvCell(null), '""')
})

test('organization policy offers each model source, including LiteLLM, in both settings languages', () => {
  assert.ok(ORGANIZATION_MODEL_PROVIDERS.includes('litellm'))
  for (const locale of ['en', 'zh-CN']) {
    const catalog = JSON.parse(readFileSync(new URL(`../../messages/${locale}.json`, import.meta.url), 'utf8'))
    const names = catalog.Organization.policy.providers.names
    assert.deepEqual(Object.keys(names).sort(), [...ORGANIZATION_MODEL_PROVIDERS].sort())
    for (const provider of ORGANIZATION_MODEL_PROVIDERS) assert.ok(names[provider]?.trim(), `${locale}: ${provider}`)
  }
})

test('WORKSPACE_CAPABILITY_OWNERS registers every schema field with non-empty owner and description', () => {
  const schemaKeys = Object.keys(workspaceCapabilitiesSchema.shape).sort()
  const ownerKeys = Object.keys(WORKSPACE_CAPABILITY_OWNERS).sort()
  assert.deepEqual(ownerKeys, schemaKeys)
  for (const key of schemaKeys as Array<keyof typeof WORKSPACE_CAPABILITY_OWNERS>) {
    const entry = WORKSPACE_CAPABILITY_OWNERS[key]
    assert.ok(entry.owner.trim().length > 0, `${key}: owner must be non-empty`)
    assert.ok(entry.description.trim().length > 0, `${key}: description must be non-empty`)
  }
  assert.deepEqual(Object.keys(PLAN_CAPABILITY_PROFILES).sort(), ['enterprise', 'free', 'pro'])
})

test('WorkspaceCapabilities resolves consistently across every edition, deployment mode, and plan', () => {
  const now = new Date('2026-11-15T00:00:00Z')
  const future = new Date('2026-12-15T00:00:00Z')

  const cloudPersonal = resolveEntitlements({ mode: 'cloud', kind: 'personal', now })
  assert.equal(cloudPersonal.edition, 'personal')
  assert.deepEqual(cloudPersonal.capabilities, {
    isPaidPlan: false,
    canUseUsageExport: false,
    canUseApprovalTemplates: false,
    approvalTemplateLimit: 0,
    hostedMaxInFlight: 8,
    canUseEnterpriseGovernance: false,
    canUseSso: false,
    canUseScim: false,
    canUseResourcePolicy: false,
    canManageOrgBilling: false,
    activeHumanLimit: 1,
  })

  const cloudFree = resolveEntitlements({ mode: 'cloud', kind: 'team', now })
  assert.equal(cloudFree.edition, 'team_free')
  assert.deepEqual(cloudFree.capabilities, {
    isPaidPlan: false,
    canUseUsageExport: false,
    canUseApprovalTemplates: false,
    approvalTemplateLimit: 0,
    hostedMaxInFlight: 8,
    canUseEnterpriseGovernance: false,
    canUseSso: false,
    canUseScim: false,
    canUseResourcePolicy: false,
    canManageOrgBilling: true,
    activeHumanLimit: null,
  })

  const cloudPro = resolveEntitlements({
    mode: 'cloud',
    kind: 'team',
    grant: { plan: 'pro', source: 'cloud', seatLimit: null, expiresAt: future },
    now,
  })
  assert.equal(cloudPro.edition, 'team_pro')
  assert.deepEqual(cloudPro.capabilities, {
    isPaidPlan: true,
    canUseUsageExport: true,
    canUseApprovalTemplates: true,
    approvalTemplateLimit: 100,
    hostedMaxInFlight: 32,
    canUseEnterpriseGovernance: false,
    canUseSso: false,
    canUseScim: false,
    canUseResourcePolicy: false,
    canManageOrgBilling: true,
    activeHumanLimit: null,
  })

  const cloudEnterprise = resolveEntitlements({
    mode: 'cloud',
    kind: 'team',
    grant: { plan: 'enterprise', source: 'cloud', seatLimit: null, expiresAt: future },
    now,
  })
  assert.equal(cloudEnterprise.edition, 'enterprise')
  assert.deepEqual(cloudEnterprise.capabilities, {
    isPaidPlan: true,
    canUseUsageExport: true,
    canUseApprovalTemplates: true,
    approvalTemplateLimit: 1000,
    hostedMaxInFlight: 128,
    canUseEnterpriseGovernance: true,
    canUseSso: true,
    canUseScim: true,
    canUseResourcePolicy: true,
    canManageOrgBilling: true,
    activeHumanLimit: null,
  })

  const community = resolveEntitlements({ mode: 'selfhost', kind: 'team', now })
  assert.equal(community.edition, 'community')
  assert.deepEqual(community.capabilities, {
    isPaidPlan: false,
    canUseUsageExport: true,
    canUseApprovalTemplates: true,
    approvalTemplateLimit: 100,
    hostedMaxInFlight: 8,
    canUseEnterpriseGovernance: false,
    canUseSso: false,
    canUseScim: false,
    canUseResourcePolicy: false,
    canManageOrgBilling: false,
    activeHumanLimit: null,
  })

  const selfhostEnterprise = resolveEntitlements({
    mode: 'selfhost',
    kind: 'team',
    grant: { plan: 'enterprise', source: 'license', seatLimit: null, expiresAt: future },
    now,
  })
  assert.equal(selfhostEnterprise.edition, 'enterprise')
  assert.deepEqual(selfhostEnterprise.capabilities, {
    isPaidPlan: true,
    canUseUsageExport: true,
    canUseApprovalTemplates: true,
    approvalTemplateLimit: 1000,
    hostedMaxInFlight: 128,
    canUseEnterpriseGovernance: true,
    canUseSso: true,
    canUseScim: true,
    canUseResourcePolicy: true,
    canManageOrgBilling: false,
    activeHumanLimit: null,
  })
})

test('WorkspaceCapabilities honors active planEntitlementOverrides from runtime-config and ignores expired windows', () => {
  const now = new Date('2026-11-20T12:00:00Z')
  const env = { NODE_ENV: 'test' }
  try {
    overrideRuntimeConfig('planEntitlementOverrides', {
      approvalTemplateLimit: { free: 5, pro: 250, enterprise: 2000, community: 150 },
      hostedMaxInFlight: { free: 12, pro: 48, enterprise: 256 },
      startAt: '2026-11-20T00:00:00Z',
      endAt: '2026-11-21T00:00:00Z',
    }, env)
    const activeOverride = getRuntimeConfig('planEntitlementOverrides', { env, now: now.getTime() })
    assert.ok(activeOverride)

    const free = resolveEntitlements({ mode: 'cloud', kind: 'team', now, capabilityOverrides: activeOverride })
    assert.equal(free.approvalTemplateLimit, 5)
    assert.equal(free.approvalTemplates, true)
    assert.equal(free.capabilities.approvalTemplateLimit, 5)
    assert.equal(free.capabilities.canUseApprovalTemplates, true)
    assert.equal(free.hostedMaxInFlight, 12)
    assert.equal(free.capabilities.hostedMaxInFlight, 12)

    const pro = resolveEntitlements({
      mode: 'cloud',
      kind: 'team',
      grant: { plan: 'pro', source: 'cloud', seatLimit: null, expiresAt: null },
      now,
      capabilityOverrides: activeOverride,
    })
    assert.equal(pro.approvalTemplateLimit, 250)
    assert.equal(pro.hostedMaxInFlight, 48)

    const community = resolveEntitlements({ mode: 'selfhost', kind: 'team', now, capabilityOverrides: activeOverride })
    assert.equal(community.approvalTemplateLimit, 150)
    assert.equal(community.hostedMaxInFlight, 12)

    const expired = resolveWorkspaceCapabilities({
      plan: 'pro',
      mode: 'cloud',
      kind: 'team',
      overrides: activeOverride,
      now: new Date('2026-11-22T00:00:00Z'),
    })
    assert.equal(expired.approvalTemplateLimit, 100)
    assert.equal(expired.hostedMaxInFlight, 32)
  } finally {
    clearRuntimeConfigOverrides(env)
    resetRuntimeConfig()
  }
})

