import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import {
  checkConfigContracts,
  checkConfigContractsMarkdown,
  loadTsModuleSync,
  renderConfigContractsDocument,
  renderConfigContractsMarkdown,
  validateConfigContracts,
} from './config-contract-sync.mjs'

const SCRIPT_PATH = fileURLToPath(new URL('./config-contract-sync.mjs', import.meta.url))

function createValidContracts() {
  const runtimeConfigs = {
    announcementBanner: {
      key: 'announcementBanner',
      flag: 'mikka-config-announcement-banner',
      owner: 'platform-ops',
      description: 'Workspace-wide announcement banner.',
      schema: z.object({ enabled: z.boolean(), message: z.string() }).strict(),
      fallback: { enabled: false, message: '' },
    },
    billingActiveOffer: {
      key: 'billingActiveOffer',
      flag: 'mikka-config-billing-active-offer',
      owner: 'billing',
      description: 'Active intro billing offer payload.',
      schema: z.object({ id: z.string().min(1) }).nullable(),
      fallback: null,
    },
  }

  const capabilitiesSchema = z.object({
    canExportUsage: z.boolean(),
    canUseEnterpriseGovernance: z.boolean(),
  })

  const capabilityOwners = {
    canExportUsage: {
      owner: 'governance',
      description: 'Allows exporting workspace usage history.',
    },
    canUseEnterpriseGovernance: {
      owner: 'enterprise',
      description: 'Allows enterprise organization governance controls.',
    },
  }

  return { runtimeConfigs, capabilitiesSchema, capabilityOwners }
}

test('G6 validateConfigContracts accepts valid runtime configs and capability owners', () => {
  const contracts = createValidContracts()
  assert.deepEqual(validateConfigContracts(contracts), [])
})

test('G6 validateConfigContracts rejects missing owner, description, key mismatch, and invalid flag', () => {
  const contracts = createValidContracts()
  contracts.runtimeConfigs.announcementBanner.owner = '   '
  contracts.runtimeConfigs.announcementBanner.description = ''
  contracts.runtimeConfigs.billingActiveOffer.flag = 'mikka-billing-offer'
  contracts.runtimeConfigs.billingActiveOffer.key = 'wrongKey'

  const problems = validateConfigContracts(contracts)
  assert.ok(problems.some(p => p.includes('announcementBanner: "owner"')))
  assert.ok(problems.some(p => p.includes('announcementBanner: "description"')))
  assert.ok(problems.some(p => p.includes('billingActiveOffer: "flag"')))
  assert.ok(problems.some(p => p.includes('must match definition property name "billingActiveOffer"')))
})

test('G6 validateConfigContracts rejects invalid fallback, missing fallback, and non-Zod schema', () => {
  const invalidFallback = createValidContracts()
  invalidFallback.runtimeConfigs.announcementBanner.fallback = { enabled: 'not-a-boolean', message: '' }
  const fallbackProblems = validateConfigContracts(invalidFallback)
  assert.equal(fallbackProblems.length, 1)
  assert.ok(fallbackProblems[0].includes('fails schema validation'))

  const missingFallback = createValidContracts()
  delete missingFallback.runtimeConfigs.announcementBanner.fallback
  const missingProblems = validateConfigContracts(missingFallback)
  assert.equal(missingProblems.length, 1)
  assert.ok(missingProblems[0].includes('"fallback" is required'))

  const nonZod = createValidContracts()
  nonZod.runtimeConfigs.announcementBanner.schema = { parse: () => ({}) }
  const schemaProblems = validateConfigContracts(nonZod)
  assert.equal(schemaProblems.length, 1)
  assert.ok(schemaProblems[0].includes('must be a Zod schema exposing safeParse()'))
})

test('G6 validateConfigContracts rejects duplicate PostHog flags', () => {
  const contracts = createValidContracts()
  contracts.runtimeConfigs.billingActiveOffer.flag = contracts.runtimeConfigs.announcementBanner.flag
  const problems = validateConfigContracts(contracts)
  assert.ok(problems.some(p => p.includes('duplicate PostHog flag')))
})

test('G6 validateConfigContracts validates optional runtime config environments field', () => {
  const validEnvs = createValidContracts()
  validEnvs.runtimeConfigs.announcementBanner.environments = ['production', 'preview', 'local']
  validEnvs.runtimeConfigs.billingActiveOffer.environments = ['production']
  assert.deepEqual(validateConfigContracts(validEnvs), [])

  const emptyEnvs = createValidContracts()
  emptyEnvs.runtimeConfigs.announcementBanner.environments = []
  const emptyProblems = validateConfigContracts(emptyEnvs)
  assert.equal(emptyProblems.length, 1)
  assert.ok(emptyProblems[0].includes('"environments" must be a non-empty array'))

  const nonArrayEnvs = createValidContracts()
  nonArrayEnvs.runtimeConfigs.announcementBanner.environments = 'production'
  const nonArrayProblems = validateConfigContracts(nonArrayEnvs)
  assert.equal(nonArrayProblems.length, 1)
  assert.ok(nonArrayProblems[0].includes('"environments" must be a non-empty array'))

  const invalidEntry = createValidContracts()
  invalidEntry.runtimeConfigs.announcementBanner.environments = ['production', 'staging']
  const invalidProblems = validateConfigContracts(invalidEntry)
  assert.equal(invalidProblems.length, 1)
  assert.ok(invalidProblems[0].includes('invalid entry "staging"'))

  const duplicateEntry = createValidContracts()
  duplicateEntry.runtimeConfigs.announcementBanner.environments = ['production', 'production']
  const duplicateProblems = validateConfigContracts(duplicateEntry)
  assert.equal(duplicateProblems.length, 1)
  assert.ok(duplicateProblems[0].includes('duplicate entry "production"'))
})

test('G6 validateConfigContracts rejects undocumented capability fields and orphaned capability owners', () => {
  const undocumented = createValidContracts()
  delete undocumented.capabilityOwners.canUseEnterpriseGovernance
  const undocumentedProblems = validateConfigContracts(undocumented)
  assert.equal(undocumentedProblems.length, 1)
  assert.ok(undocumentedProblems[0].includes('missing owner metadata for capability field "canUseEnterpriseGovernance"'))

  const orphaned = createValidContracts()
  orphaned.capabilityOwners.legacyDeadFlag = { owner: 'governance', description: 'Should fail as orphaned.' }
  const orphanedProblems = validateConfigContracts(orphaned)
  assert.equal(orphanedProblems.length, 1)
  assert.ok(orphanedProblems[0].includes('orphaned entry does not exist in workspaceCapabilitiesSchema.shape'))

  const emptyOwnerMeta = createValidContracts()
  emptyOwnerMeta.capabilityOwners.canExportUsage.owner = ''
  emptyOwnerMeta.capabilityOwners.canUseEnterpriseGovernance.description = '  '
  const emptyProblems = validateConfigContracts(emptyOwnerMeta)
  assert.equal(emptyProblems.length, 2)
  assert.ok(emptyProblems.some(p => p.includes('canExportUsage: "owner"')))
  assert.ok(emptyProblems.some(p => p.includes('canUseEnterpriseGovernance: "description"')))
})

test('G6 renderConfigContractsMarkdown is deterministic regardless of key insertion order and detects stale markdown', () => {
  const a = createValidContracts()
  const b = {
    runtimeConfigs: {
      billingActiveOffer: a.runtimeConfigs.billingActiveOffer,
      announcementBanner: a.runtimeConfigs.announcementBanner,
    },
    capabilitiesSchema: z.object({
      canUseEnterpriseGovernance: z.boolean(),
      canExportUsage: z.boolean(),
    }),
    capabilityOwners: {
      canUseEnterpriseGovernance: a.capabilityOwners.canUseEnterpriseGovernance,
      canExportUsage: a.capabilityOwners.canExportUsage,
    },
  }

  const mdA = renderConfigContractsMarkdown(a)
  const mdB = renderConfigContractsMarkdown(b)
  assert.equal(mdA, mdB)
  assert.ok(mdA.includes('| `announcementBanner` | `mikka-config-announcement-banner` | `platform-ops` |'))
  assert.ok(mdA.includes('| `canExportUsage` | `governance` |'))

  const template = '# Config Contracts\n\n<!-- generated:config-contracts -->\n<!-- /generated:config-contracts -->\n'
  const syncedDoc = renderConfigContractsDocument(template, mdA)
  assert.deepEqual(checkConfigContractsMarkdown(syncedDoc, mdA), [])

  const staleDoc = '# Config Contracts\n\n<!-- generated:config-contracts -->\nstale content\n<!-- /generated:config-contracts -->\n'
  const staleProblems = checkConfigContractsMarkdown(staleDoc, mdA)
  assert.equal(staleProblems.length, 1)
  assert.ok(staleProblems[0].includes('is stale; run pnpm docs:generate'))

  const brokenDoc = '# Config Contracts\n\nno markers here\n'
  const brokenProblems = checkConfigContractsMarkdown(brokenDoc, mdA)
  assert.equal(brokenProblems.length, 1)
  assert.ok(brokenProblems[0].includes('is missing or broken'))
})

test('G6 checkConfigContracts loads real TypeScript modules and docs end-to-end under plain Node 24 and tsx', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikka-g6-sync-'))
  try {
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(dir, 'node_modules'))
    fs.mkdirSync(path.join(dir, 'lib/runtime-config'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'lib/governance'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'docs/operations'), { recursive: true })

    fs.writeFileSync(
      path.join(dir, 'lib/runtime-config/schema.ts'),
      `import { z } from 'zod'
export type EnvName = 'production' | 'preview' | 'local'
export const RUNTIME_CONFIG_DEFINITIONS = {
  sampleBanner: {
    key: 'sampleBanner',
    flag: 'mikka-config-sample-banner',
    owner: 'platform-ops',
    description: 'Sample banner contract ($1 safe check).',
    schema: z.object({ enabled: z.boolean() }).strict(),
    fallback: { enabled: false },
  },
} as const
`,
    )

    fs.writeFileSync(
      path.join(dir, 'lib/governance/capabilities.ts'),
      `import { z } from 'zod'
export const workspaceCapabilitiesSchema = z.object({
  canUseSampleFeature: z.boolean(),
})
export type WorkspaceCapabilities = z.infer<typeof workspaceCapabilitiesSchema>
export const WORKSPACE_CAPABILITY_OWNERS: Record<keyof WorkspaceCapabilities, { owner: string; description: string }> = {
  canUseSampleFeature: {
    owner: 'governance',
    description: 'Allows the sample capability.',
  },
}
`,
    )

    const markdown = renderConfigContractsMarkdown({ rootDir: dir })
    const docAbs = path.join(dir, 'docs/operations/config-contracts.md')
    fs.writeFileSync(
      docAbs,
      `# Runtime Config Contracts\n\n<!-- generated:config-contracts -->\n${markdown}\n<!-- /generated:config-contracts -->\n`,
    )

    assert.deepEqual(checkConfigContracts({ rootDir: dir }), [])

    // Stale doc must fail
    fs.writeFileSync(
      docAbs,
      '# Runtime Config Contracts\n\n<!-- generated:config-contracts -->\noutdated\n<!-- /generated:config-contracts -->\n',
    )
    const staleProblems = checkConfigContracts({ rootDir: dir })
    assert.equal(staleProblems.length, 1)
    assert.ok(staleProblems[0].includes('is stale'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('G6 validates real repo lib/runtime-config/schema.ts and lib/governance/capabilities.ts when present', () => {
  const repoRoot = process.cwd()
  const schemaPath = path.join(repoRoot, 'lib/runtime-config/schema.ts')
  const capabilitiesPath = path.join(repoRoot, 'lib/governance/capabilities.ts')
  if (!fs.existsSync(schemaPath) || !fs.existsSync(capabilitiesPath)) return

  const runtimeMod = loadTsModuleSync(schemaPath, repoRoot)
  const capMod = loadTsModuleSync(capabilitiesPath, repoRoot)
  assert.ok(runtimeMod.RUNTIME_CONFIG_DEFINITIONS, 'RUNTIME_CONFIG_DEFINITIONS should be exported')
  assert.ok(capMod.workspaceCapabilitiesSchema, 'workspaceCapabilitiesSchema should be exported')
  assert.ok(capMod.WORKSPACE_CAPABILITY_OWNERS, 'WORKSPACE_CAPABILITY_OWNERS should be exported')

  assert.deepEqual(
    validateConfigContracts({
      runtimeConfigs: runtimeMod.RUNTIME_CONFIG_DEFINITIONS,
      capabilitiesSchema: capMod.workspaceCapabilitiesSchema,
      capabilityOwners: capMod.WORKSPACE_CAPABILITY_OWNERS,
    }),
    [],
  )

  const markdown = renderConfigContractsMarkdown({ rootDir: repoRoot })
  for (const key of Object.keys(runtimeMod.RUNTIME_CONFIG_DEFINITIONS)) {
    assert.ok(markdown.includes(`\`${key}\``), `rendered markdown missing runtime config key ${key}`)
  }
  for (const field of Object.keys(capMod.workspaceCapabilitiesSchema.shape)) {
    assert.ok(markdown.includes(`\`${field}\``), `rendered markdown missing capability field ${field}`)
  }
})

test('G6 CLI --write fails non-zero when generated markers are missing or inverted, and updates when markers are present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikka-g6-cli-write-'))
  try {
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(dir, 'node_modules'))
    fs.mkdirSync(path.join(dir, 'lib/runtime-config'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'lib/governance'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'docs/operations'), { recursive: true })

    fs.writeFileSync(
      path.join(dir, 'lib/runtime-config/schema.ts'),
      `import { z } from 'zod'
export const RUNTIME_CONFIG_DEFINITIONS = {
  sampleBanner: {
    key: 'sampleBanner',
    flag: 'mikka-config-sample-banner',
    owner: 'platform-ops',
    description: 'Sample banner.',
    environments: ['production', 'preview'] as const,
    schema: z.object({ enabled: z.boolean() }).strict(),
    fallback: { enabled: false },
  },
} as const
`,
    )

    fs.writeFileSync(
      path.join(dir, 'lib/governance/capabilities.ts'),
      `import { z } from 'zod'
export const workspaceCapabilitiesSchema = z.object({
  canUseSampleFeature: z.boolean(),
})
export const WORKSPACE_CAPABILITY_OWNERS = {
  canUseSampleFeature: {
    owner: 'governance',
    description: 'Allows the sample capability.',
  },
}
`,
    )

    const docAbs = path.join(dir, 'docs/operations/config-contracts.md')

    // Missing markers must fail non-zero and leave file unchanged
    const missingMarkersDoc = '# Config Contracts\n\nNo generated markers here.\n'
    fs.writeFileSync(docAbs, missingMarkersDoc, 'utf8')
    const missingRes = spawnSync(process.execPath, [SCRIPT_PATH, '--write'], { cwd: dir, encoding: 'utf8' })
    assert.equal(missingRes.status, 1)
    assert.ok(missingRes.stderr.includes('is missing or broken'))
    assert.equal(fs.readFileSync(docAbs, 'utf8'), missingMarkersDoc)

    // Inverted markers must also fail non-zero and leave file unchanged
    const invertedMarkersDoc = '# Config Contracts\n\n<!-- /generated:config-contracts -->\n<!-- generated:config-contracts -->\n'
    fs.writeFileSync(docAbs, invertedMarkersDoc, 'utf8')
    const invertedRes = spawnSync(process.execPath, [SCRIPT_PATH, '--write'], { cwd: dir, encoding: 'utf8' })
    assert.equal(invertedRes.status, 1)
    assert.ok(invertedRes.stderr.includes('is missing or broken'))
    assert.equal(fs.readFileSync(docAbs, 'utf8'), invertedMarkersDoc)

    // Valid markers succeed and synchronize the document
    fs.writeFileSync(
      docAbs,
      '# Config Contracts\n\n<!-- generated:config-contracts -->\nstale\n<!-- /generated:config-contracts -->\n',
      'utf8',
    )
    const okRes = spawnSync(process.execPath, [SCRIPT_PATH, '--write'], { cwd: dir, encoding: 'utf8' })
    assert.equal(okRes.status, 0, `expected --write to succeed, stderr=${okRes.stderr}`)
    assert.deepEqual(checkConfigContracts({ rootDir: dir }), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
