#!/usr/bin/env node
/**
 * G6 (config-contract-sync): validates Tier-4 runtime config definitions
 * (`lib/runtime-config/schema.ts`) and workspace capability ownership metadata
 * (`lib/governance/capabilities.ts`), and keeps the generated contract table
 * in `docs/operations/config-contracts.md` (`<!-- generated:config-contracts -->`)
 * synchronized.
 *
 * Works both under plain Node 24 (native TypeScript stripping + module.registerHooks)
 * and under `node --import tsx`.
 */
import fs from 'node:fs'
import module from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const RUNTIME_CONFIG_SCHEMA_PATH = 'lib/runtime-config/schema.ts'
export const WORKSPACE_CAPABILITIES_PATH = 'lib/governance/capabilities.ts'
export const CONFIG_CONTRACTS_DOC_PATH = 'docs/operations/config-contracts.md'
export const CONFIG_CONTRACTS_MARKER = 'config-contracts'
export const RUNTIME_CONFIG_FLAG_RE = /^mikka-config-[a-z0-9-]+$/
export const VALID_RUNTIME_CONFIG_ENVIRONMENTS = Object.freeze(['production', 'preview', 'local'])
const VALID_RUNTIME_CONFIG_ENVIRONMENT_SET = new Set(VALID_RUNTIME_CONFIG_ENVIRONMENTS)

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs', '/index.js']
const REPO_PACKAGE_JSON_URL = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')).href
const OPEN_MARKER = `<!-- generated:${CONFIG_CONTRACTS_MARKER} -->`
const CLOSE_MARKER = `<!-- /generated:${CONFIG_CONTRACTS_MARKER} -->`
const GENERATED_BLOCK_RE = new RegExp(`${OPEN_MARKER}\\r?\\n?[\\s\\S]*?${CLOSE_MARKER}`)

let tsHooksRegistered = false
let activeRootDir = process.cwd()

function resolveCandidateFile(base) {
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = `${base}${ext}`
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

function ensureTsHooksRegistered() {
  if (tsHooksRegistered || typeof module.registerHooks !== 'function') return
  tsHooksRegistered = true
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'server-only') {
        return { shortCircuit: true, url: 'data:text/javascript,export default {}' }
      }
      if (specifier.startsWith('@/')) {
        const match = resolveCandidateFile(path.join(activeRootDir, specifier.slice(2)))
        if (match) return { shortCircuit: true, url: pathToFileURL(match).href }
      }
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
        const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
        const match = resolveCandidateFile(base)
        if (match) return { shortCircuit: true, url: pathToFileURL(match).href }
      }
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
          try {
            return nextResolve(specifier, { ...context, parentURL: REPO_PACKAGE_JSON_URL })
          } catch {
            // Fall through to original error
          }
        }
        throw error
      }
    },
  })
}

/**
 * Synchronously loads a TypeScript module under plain Node 24 or tsx.
 */
export function loadTsModuleSync(filePath, rootDir = process.cwd()) {
  ensureTsHooksRegistered()
  const resolvedRoot = path.resolve(rootDir)
  const resolvedFile = path.isAbsolute(filePath) ? filePath : path.resolve(resolvedRoot, filePath)
  const previousRoot = activeRootDir
  activeRootDir = resolvedRoot
  try {
    const req = module.createRequire(import.meta.url)
    return req(resolvedFile)
  } finally {
    activeRootDir = previousRoot
  }
}

/**
 * Loads `RUNTIME_CONFIG_DEFINITIONS`, `workspaceCapabilitiesSchema`, and
 * `WORKSPACE_CAPABILITY_OWNERS` from the repository (or a custom `rootDir`).
 */
export function loadConfigContractSources(rootDir = process.cwd()) {
  const resolvedRoot = path.resolve(rootDir)
  const loadErrors = []
  let runtimeConfigs = null
  let capabilitiesSchema = null
  let capabilityOwners = null

  const runtimeConfigAbs = path.join(resolvedRoot, RUNTIME_CONFIG_SCHEMA_PATH)
  if (!fs.existsSync(runtimeConfigAbs)) {
    loadErrors.push(`${RUNTIME_CONFIG_SCHEMA_PATH} is missing`)
  } else {
    try {
      const mod = loadTsModuleSync(runtimeConfigAbs, resolvedRoot)
      runtimeConfigs = mod.RUNTIME_CONFIG_DEFINITIONS ?? null
      if (!runtimeConfigs) {
        loadErrors.push(`${RUNTIME_CONFIG_SCHEMA_PATH} does not export RUNTIME_CONFIG_DEFINITIONS`)
      }
    } catch (error) {
      loadErrors.push(`Failed to load ${RUNTIME_CONFIG_SCHEMA_PATH}: ${error.message}`)
    }
  }

  const capabilitiesAbs = path.join(resolvedRoot, WORKSPACE_CAPABILITIES_PATH)
  if (!fs.existsSync(capabilitiesAbs)) {
    loadErrors.push(`${WORKSPACE_CAPABILITIES_PATH} is missing`)
  } else {
    try {
      const mod = loadTsModuleSync(capabilitiesAbs, resolvedRoot)
      capabilitiesSchema = mod.workspaceCapabilitiesSchema ?? null
      capabilityOwners = mod.WORKSPACE_CAPABILITY_OWNERS ?? null
      if (!capabilitiesSchema) {
        loadErrors.push(`${WORKSPACE_CAPABILITIES_PATH} does not export workspaceCapabilitiesSchema`)
      }
      if (!capabilityOwners) {
        loadErrors.push(`${WORKSPACE_CAPABILITIES_PATH} does not export WORKSPACE_CAPABILITY_OWNERS`)
      }
    } catch (error) {
      loadErrors.push(`Failed to load ${WORKSPACE_CAPABILITIES_PATH}: ${error.message}`)
    }
  }

  return { runtimeConfigs, capabilitiesSchema, capabilityOwners, loadErrors }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function escapeMarkdownCell(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|')
}

function extractRuntimeConfigEntries(runtimeConfigs) {
  if (Array.isArray(runtimeConfigs)) {
    return runtimeConfigs.map((def, index) => ({ entryName: `[${index}]`, def, isMap: false }))
  }
  if (runtimeConfigs && typeof runtimeConfigs === 'object') {
    return Object.entries(runtimeConfigs).map(([entryName, def]) => ({ entryName, def, isMap: true }))
  }
  return null
}

function formatZodFailure(parsed) {
  const issues = parsed?.error?.issues ?? parsed?.error?.errors
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .map(issue => {
        const pathLabel = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
        return `${pathLabel}${issue.message ?? 'invalid'}`
      })
      .join('; ')
  }
  return parsed?.error?.message ?? 'schema validation failed'
}

/**
 * Programmatically validates runtime config definitions and workspace capability contracts.
 * Returns an array of problem descriptions (empty array means valid).
 */
export function validateConfigContracts({ runtimeConfigs, capabilitiesSchema, capabilityOwners } = {}) {
  const problems = []

  const entries = extractRuntimeConfigEntries(runtimeConfigs)
  if (!entries || entries.length === 0) {
    problems.push('RUNTIME_CONFIG_DEFINITIONS must be a non-empty object or array of runtime config definitions')
  } else {
    const seenKeys = new Set()
    const seenFlags = new Set()

    for (const { entryName, def, isMap } of entries) {
      const label = `RUNTIME_CONFIG_DEFINITIONS.${entryName}`
      if (!def || typeof def !== 'object' || Array.isArray(def)) {
        problems.push(`${label}: definition must be an object`)
        continue
      }

      if (!isNonEmptyString(def.key)) {
        problems.push(`${label}: "key" must be a non-empty string`)
      } else {
        if (isMap && def.key !== entryName) {
          problems.push(`${label}: "key" ("${def.key}") must match definition property name "${entryName}"`)
        }
        if (seenKeys.has(def.key)) {
          problems.push(`${label}: duplicate runtime config key "${def.key}"`)
        }
        seenKeys.add(def.key)
      }

      if (!isNonEmptyString(def.flag) || !RUNTIME_CONFIG_FLAG_RE.test(def.flag)) {
        problems.push(`${label}: "flag" ("${String(def.flag ?? '')}") must match ${RUNTIME_CONFIG_FLAG_RE}`)
      } else {
        if (seenFlags.has(def.flag)) {
          problems.push(`${label}: duplicate PostHog flag "${def.flag}"`)
        }
        seenFlags.add(def.flag)
      }

      if (!isNonEmptyString(def.owner)) {
        problems.push(`${label}: "owner" must be a non-empty string`)
      }

      if (!isNonEmptyString(def.description)) {
        problems.push(`${label}: "description" must be a non-empty string`)
      }

      if (def.environments !== undefined) {
        if (!Array.isArray(def.environments) || def.environments.length === 0) {
          problems.push(
            `${label}: "environments" must be a non-empty array of ${VALID_RUNTIME_CONFIG_ENVIRONMENTS.join(' | ')}`,
          )
        } else {
          const seenEnvs = new Set()
          for (const envName of def.environments) {
            if (typeof envName !== 'string' || !VALID_RUNTIME_CONFIG_ENVIRONMENT_SET.has(envName)) {
              problems.push(
                `${label}: "environments" contains invalid entry "${String(envName)}" (expected one of ${VALID_RUNTIME_CONFIG_ENVIRONMENTS.join(', ')})`,
              )
            } else if (seenEnvs.has(envName)) {
              problems.push(`${label}: "environments" contains duplicate entry "${envName}"`)
            } else {
              seenEnvs.add(envName)
            }
          }
        }
      }

      const hasValidSchema = Boolean(def.schema && typeof def.schema.safeParse === 'function')
      if (!hasValidSchema) {
        problems.push(`${label}: "schema" must be a Zod schema exposing safeParse()`)
      }

      if (!Object.hasOwn(def, 'fallback')) {
        problems.push(`${label}: "fallback" is required`)
      } else if (hasValidSchema) {
        try {
          const parsed = def.schema.safeParse(def.fallback)
          if (!parsed || parsed.success !== true) {
            problems.push(`${label}: "fallback" fails schema validation (${formatZodFailure(parsed)})`)
          }
        } catch (error) {
          problems.push(`${label}: "schema.safeParse(fallback)" threw: ${error.message}`)
        }
      }
    }
  }

  const shape = capabilitiesSchema && typeof capabilitiesSchema.safeParse === 'function' && capabilitiesSchema.shape && typeof capabilitiesSchema.shape === 'object' && !Array.isArray(capabilitiesSchema.shape)
    ? capabilitiesSchema.shape
    : null

  if (!shape || Object.keys(shape).length === 0) {
    problems.push('workspaceCapabilitiesSchema must be a non-empty Zod object schema exposing safeParse() and shape')
  }

  const validOwnersMap = Boolean(capabilityOwners && typeof capabilityOwners === 'object' && !Array.isArray(capabilityOwners))
  if (!validOwnersMap) {
    problems.push('WORKSPACE_CAPABILITY_OWNERS must be a plain object mapping capability fields to { owner, description }')
  }

  if (shape && validOwnersMap) {
    const shapeFields = Object.keys(shape)
    for (const field of shapeFields) {
      if (!Object.hasOwn(capabilityOwners, field)) {
        problems.push(`WORKSPACE_CAPABILITY_OWNERS: missing owner metadata for capability field "${field}"`)
        continue
      }
      const entry = capabilityOwners[field]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`WORKSPACE_CAPABILITY_OWNERS.${field}: metadata must be an object with non-empty owner and description`)
        continue
      }
      if (!isNonEmptyString(entry.owner)) {
        problems.push(`WORKSPACE_CAPABILITY_OWNERS.${field}: "owner" must be a non-empty string`)
      }
      if (!isNonEmptyString(entry.description)) {
        problems.push(`WORKSPACE_CAPABILITY_OWNERS.${field}: "description" must be a non-empty string`)
      }
    }

    for (const ownerField of Object.keys(capabilityOwners)) {
      if (!Object.hasOwn(shape, ownerField)) {
        problems.push(`WORKSPACE_CAPABILITY_OWNERS.${ownerField}: orphaned entry does not exist in workspaceCapabilitiesSchema.shape`)
      }
    }
  }

  return problems
}

/**
 * Renders the deterministic Markdown body for `<!-- generated:config-contracts -->`
 * in `docs/operations/config-contracts.md`.
 */
export function renderConfigContractsMarkdown(input) {
  let runtimeConfigs
  let capabilitiesSchema
  let capabilityOwners

  if (input && typeof input === 'object' && ('runtimeConfigs' in input || 'capabilitiesSchema' in input || 'capabilityOwners' in input)) {
    runtimeConfigs = input.runtimeConfigs
    capabilitiesSchema = input.capabilitiesSchema
    capabilityOwners = input.capabilityOwners
  } else {
    const rootDir = typeof input === 'string' ? input : input?.rootDir ?? process.cwd()
    const loaded = loadConfigContractSources(rootDir)
    if (loaded.loadErrors.length > 0) {
      throw new Error(`Cannot render config contracts markdown: ${loaded.loadErrors.join('; ')}`)
    }
    runtimeConfigs = loaded.runtimeConfigs
    capabilitiesSchema = loaded.capabilitiesSchema
    capabilityOwners = loaded.capabilityOwners
  }

  const entries = (extractRuntimeConfigEntries(runtimeConfigs) ?? [])
    .map(({ entryName, def }) => ({
      key: isNonEmptyString(def?.key) ? def.key : entryName,
      flag: def?.flag ?? '',
      owner: def?.owner ?? '',
      description: def?.description ?? '',
    }))
    .sort((a, b) => compareAscii(a.key, b.key))

  const runtimeRows = entries.map(
    entry => `| \`${escapeMarkdownCell(entry.key)}\` | \`${escapeMarkdownCell(entry.flag)}\` | \`${escapeMarkdownCell(entry.owner)}\` | ${escapeMarkdownCell(entry.description)} |`,
  )

  const shapeFields = Object.keys(capabilitiesSchema?.shape ?? {}).sort(compareAscii)
  const capabilityRows = shapeFields.map(field => {
    const meta = capabilityOwners?.[field] ?? {}
    return `| \`${escapeMarkdownCell(field)}\` | \`${escapeMarkdownCell(meta.owner ?? '')}\` | ${escapeMarkdownCell(meta.description ?? '')} |`
  })

  return [
    `Source: \`${RUNTIME_CONFIG_SCHEMA_PATH}\` and \`${WORKSPACE_CAPABILITIES_PATH}\`.`,
    '',
    '### Runtime configuration contracts',
    '',
    '| Key | PostHog flag | Owner | Description |',
    '| --- | --- | --- | --- |',
    ...runtimeRows,
    '',
    '### Workspace capability contracts',
    '',
    '| Capability | Owner | Description |',
    '| --- | --- | --- |',
    ...capabilityRows,
  ].join('\n')
}

export function hasValidConfigContractsMarkers(docText) {
  const openIdx = docText.indexOf(OPEN_MARKER)
  const closeIdx = docText.indexOf(CLOSE_MARKER)
  return openIdx !== -1 && closeIdx !== -1 && openIdx < closeIdx
}

export function renderConfigContractsDocument(docText, renderedMarkdown) {
  return docText.replace(GENERATED_BLOCK_RE, () => `${OPEN_MARKER}\n${renderedMarkdown}\n${CLOSE_MARKER}`)
}

export function checkConfigContractsMarkdown(docText, renderedMarkdown, docPath = CONFIG_CONTRACTS_DOC_PATH) {
  const problems = []
  if (!hasValidConfigContractsMarkers(docText)) {
    problems.push(`${docPath}: generated block ${CONFIG_CONTRACTS_MARKER} is missing or broken; restore markers and run pnpm docs:generate`)
    return problems
  }
  const updated = renderConfigContractsDocument(docText, renderedMarkdown)
  if (updated !== docText) {
    problems.push(`${docPath}: generated block ${CONFIG_CONTRACTS_MARKER} is stale; run pnpm docs:generate`)
  }
  return problems
}

/**
 * Full G6 contract + documentation freshness verification.
 */
export function checkConfigContracts(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : process.cwd()
  const docPath = options.docPath ?? CONFIG_CONTRACTS_DOC_PATH
  const requireDoc = options.requireDoc ?? true

  let runtimeConfigs = options.runtimeConfigs
  let capabilitiesSchema = options.capabilitiesSchema
  let capabilityOwners = options.capabilityOwners
  const problems = []

  if (runtimeConfigs === undefined && capabilitiesSchema === undefined && capabilityOwners === undefined) {
    const loaded = loadConfigContractSources(rootDir)
    if (loaded.loadErrors.length > 0) {
      problems.push(...loaded.loadErrors)
      return problems
    }
    runtimeConfigs = loaded.runtimeConfigs
    capabilitiesSchema = loaded.capabilitiesSchema
    capabilityOwners = loaded.capabilityOwners
  }

  problems.push(...validateConfigContracts({ runtimeConfigs, capabilitiesSchema, capabilityOwners }))
  if (problems.length > 0) return problems

  const renderedMarkdown = renderConfigContractsMarkdown({ runtimeConfigs, capabilitiesSchema, capabilityOwners })

  if (options.docText !== undefined) {
    problems.push(...checkConfigContractsMarkdown(options.docText, renderedMarkdown, docPath))
  } else if (requireDoc) {
    const resolvedDoc = path.isAbsolute(docPath) ? docPath : path.join(rootDir, docPath)
    if (!fs.existsSync(resolvedDoc)) {
      problems.push(`${docPath}: file is missing; create it with ${OPEN_MARKER} / ${CLOSE_MARKER} markers and run pnpm docs:generate`)
    } else {
      const docText = fs.readFileSync(resolvedDoc, 'utf8')
      problems.push(...checkConfigContractsMarkdown(docText, renderedMarkdown, docPath))
    }
  }

  return problems
}

function main() {
  const args = new Set(process.argv.slice(2))
  const rootDir = process.cwd()

  if (args.has('--write')) {
    const loaded = loadConfigContractSources(rootDir)
    if (loaded.loadErrors.length > 0) {
      console.error(`config-contract-sync failed:\n${loaded.loadErrors.map(e => `  - ${e}`).join('\n')}`)
      process.exitCode = 1
      return
    }
    const validationProblems = validateConfigContracts(loaded)
    if (validationProblems.length > 0) {
      console.error(`config-contract-sync failed with ${validationProblems.length} problem(s):`)
      for (const problem of validationProblems) console.error(`  - ${problem}`)
      process.exitCode = 1
      return
    }
    const markdown = renderConfigContractsMarkdown(loaded)
    const docAbs = path.join(rootDir, CONFIG_CONTRACTS_DOC_PATH)
    if (!fs.existsSync(docAbs)) {
      console.error(`${CONFIG_CONTRACTS_DOC_PATH} is missing`)
      process.exitCode = 1
      return
    }
    const before = fs.readFileSync(docAbs, 'utf8')
    if (!hasValidConfigContractsMarkers(before)) {
      console.error(
        `${CONFIG_CONTRACTS_DOC_PATH}: generated block ${CONFIG_CONTRACTS_MARKER} is missing or broken; restore ${OPEN_MARKER} / ${CLOSE_MARKER} markers before running --write`,
      )
      process.exitCode = 1
      return
    }
    const after = renderConfigContractsDocument(before, markdown)
    fs.writeFileSync(docAbs, after, 'utf8')
    console.log(`config-contract-sync updated ${CONFIG_CONTRACTS_DOC_PATH}`)
    return
  }

  const problems = checkConfigContracts({ rootDir })
  if (problems.length > 0) {
    console.error(`config-contract-sync failed with ${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('config-contract-sync passed: runtime config schemas, capability owners, and docs are in sync.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
