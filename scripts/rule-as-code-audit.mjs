// Verifies Mikka's 7-layer primitive architecture map (docs/architecture/primitives.md):
// every local repo path, markdown link, and pnpm script cited as an active primitive or
// CI gate must exist on disk; cross-repo markers (mikka-hosted-ui/, mikka-cloud/) are
// validated syntactically without requiring local checkouts; frozen historical snapshots
// (docs/design/decisions.md) retain their non-authoritative warning and stay frozen; and
// docs/README.md stays free of broken links and undated/unlinked rule contradictions.
//
//   node scripts/rule-as-code-audit.mjs
//   node scripts/rule-as-code-audit.mjs --json
//   node scripts/rule-as-code-audit.mjs --root <path>

import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PRIMITIVES_DOC = 'docs/architecture/primitives.md'
export const DOCS_INDEX = 'docs/README.md'
export const FROZEN_DECISIONS_DOC = 'docs/design/decisions.md'
export const FROZEN_DECISIONS_CUTOFF = '2026-10-31'
export const REQUIRED_LAYERS = [1, 2, 3, 4, 5, 6, 7]
export const CROSS_REPO_PREFIXES = ['mikka-hosted-ui/', 'mikka-cloud/']

const LOCAL_DIR_PREFIX = /^(?:lib|scripts|\.github|docs|apps|packages|app|cloudflare|services|tests|drizzle|messages)\//
const LOCAL_ROOT_FILES = new Set(['AGENTS.md', 'CONTRIBUTING.md', 'package.json', 'ui-policy.json'])
const PNPM_BUILTINS = new Set(['install', 'i', 'exec', 'run', 'test', 'add', 'remove', 'dlx', 'up', 'update'])

const RETIRED_AUTHORITY_PATTERNS = [
  { name: 'Comma visual standard', pattern: /\bComma\b/ },
  { name: 'Grok composer', pattern: /\bGrok\s+composer\b/i },
  { name: 'WorkflowAgent', pattern: /\bWorkflowAgent\b/ },
  { name: 'LobeHub action bar', pattern: /\bLobeHub\b/i },
  { name: 'Next.js runtime', pattern: /\bNext\.js\b/i },
  { name: 'Vercel deployment/sandbox', pattern: /\bVercel\b/i },
]

const NEGATIVE_OR_RETIRED_CONTEXT = /\b(?:retired|superseded|legacy|historical|removed|replaced|deprecated|not\s+active|not\s+a\s+|never|no\s+longer|do\s+not|former)\b/i

function stripFencedCodeBlocks(markdown) {
  const lines = markdown.split('\n')
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  return lines.map(line => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line)
    if (match) {
      const marker = match[1]
      if (!inFence) {
        inFence = true
        fenceChar = marker[0]
        fenceLen = marker.length
        return ''
      }
      if (marker[0] === fenceChar && marker.length >= fenceLen) {
        inFence = false
        fenceChar = ''
        fenceLen = 0
        return ''
      }
    }
    return inFence ? '' : line
  }).join('\n')
}

function stripInlineCode(line) {
  return line.replace(/`[^`\n]*`/g, match => ' '.repeat(match.length))
}

function cleanToken(token) {
  return token
    .replace(/^['"([{<]+/, '')
    .replace(/['")\]}>.,;:]+$/, '')
}

function stripAnchorAndLine(target) {
  const noAnchor = target.split('#')[0]
  return noAnchor.replace(/:\d+(?::\d+)?$/, '')
}

function isWithinRoot(root, resolvedTarget) {
  const rel = relative(root, resolvedTarget)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/')
}

export function extractMarkdownLinks(markdown) {
  const stripped = stripFencedCodeBlocks(markdown)
  const links = []
  const lines = stripped.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const text = stripInlineCode(lines[i])
    for (const match of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      links.push({ line: i + 1, label: match[1], target: match[2] })
    }
  }
  return links
}

export function extractPrimitivesCitations(markdown) {
  const stripped = stripFencedCodeBlocks(markdown)
  const localPaths = []
  const globPaths = []
  const crossRepoRefs = []
  const npmScripts = []
  const invalidRefs = []

  const lines = stripped.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1
    for (const spanMatch of lines[i].matchAll(/`([^`\n]+)`/g)) {
      const rawSpan = spanMatch[1].trim()
      if (!rawSpan) continue

      const pnpmMatch = /^pnpm\s+(?:--silent\s+)?([a-z0-9:_-]+)(?:\s|$)/i.exec(rawSpan)
      if (pnpmMatch && !PNPM_BUILTINS.has(pnpmMatch[1])) {
        npmScripts.push({ line: lineNum, script: pnpmMatch[1], raw: rawSpan })
      }

      // Skip code expressions / SQL snippets / prose tokens that clearly are not paths or CLI invocations.
      const tokens = rawSpan.split(/\s+/)
      for (const rawToken of tokens) {
        const token = cleanToken(rawToken)
        if (!token) continue
        if (/^(?:https?:\/\/|mailto:|\/)/.test(token)) continue
        if (token.includes('->') || token.includes('::') || token.includes('(') || token.includes('=')) continue

        const crossPrefix = CROSS_REPO_PREFIXES.find(prefix => token.startsWith(prefix))
        if (crossPrefix) {
          const rest = token.slice(crossPrefix.length)
          if (!rest || rest === '/' || rest.split('/').includes('..')) {
            invalidRefs.push({ line: lineNum, target: token, kind: 'cross-repo' })
          } else {
            crossRepoRefs.push({ line: lineNum, repo: crossPrefix.slice(0, -1), target: token })
          }
          continue
        }

        const candidate = stripAnchorAndLine(token)
        const isLocalRootFile = LOCAL_ROOT_FILES.has(candidate)
        const isLocalDirPath = LOCAL_DIR_PREFIX.test(candidate)
        if (!isLocalRootFile && !isLocalDirPath) continue

        if (candidate.split('/').includes('..')) {
          invalidRefs.push({ line: lineNum, target: candidate, kind: 'local' })
          continue
        }

        if (candidate.includes('*')) {
          const segments = candidate.split('/')
          const wildcardIndex = segments.findIndex(segment => segment.includes('*'))
          const staticPrefix = segments.slice(0, wildcardIndex).join('/')
          globPaths.push({ line: lineNum, target: candidate, staticPrefix })
        } else {
          localPaths.push({ line: lineNum, target: candidate })
        }
      }
    }
  }

  return { localPaths, globPaths, crossRepoRefs, npmScripts, invalidRefs }
}

function parseBulletBlocks(markdown) {
  const stripped = stripFencedCodeBlocks(markdown)
  const lines = stripped.split('\n')
  const bullets = []
  let current = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    if (/^\s*-\s+/.test(line)) {
      if (current) bullets.push(current)
      current = { line: lineNum, text: line }
    } else if (current && /^\s+\S/.test(line)) {
      current.text += '\n' + line
    } else {
      if (current) bullets.push(current)
      current = null
    }
  }
  if (current) bullets.push(current)
  return bullets
}

function checkRetiredAuthorityLines(file, markdown, findings) {
  const stripped = stripFencedCodeBlocks(markdown)
  const lines = stripped.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    for (const { name, pattern } of RETIRED_AUTHORITY_PATTERNS) {
      if (pattern.test(line) && !NEGATIVE_OR_RETIRED_CONTEXT.test(line)) {
        findings.push({
          file,
          line: i + 1,
          rule: 'rule-as-code/stale-rule-contradiction',
          target: name,
          message: `${name} is retired/superseded and must not be cited as active operating policy without explicit retirement framing.`,
        })
      }
    }
  }
}

export function auditPrimitivesMap(root, pkgScripts = null) {
  const findings = []
  const filePath = resolve(root, PRIMITIVES_DOC)
  if (!existsSync(filePath)) {
    findings.push({
      file: PRIMITIVES_DOC,
      line: 1,
      rule: 'rule-as-code/missing-primitives-doc',
      target: PRIMITIVES_DOC,
      message: `Authoritative primitive architecture map ${PRIMITIVES_DOC} does not exist.`,
    })
    return { findings, checkedLocalPaths: [], checkedGlobPaths: [], checkedLinks: [], checkedScripts: [], crossRepoRefs: [] }
  }

  const content = readFileSync(filePath, 'utf8')
  const stripped = stripFencedCodeBlocks(content)

  // Verify all 7 primitive layers are mapped in both summary table and section headings.
  for (const layer of REQUIRED_LAYERS) {
    const hasTableRow = new RegExp(`^\\|\\s*(?:\\*\\*)?${layer}(?:\\*\\*)?\\s*\\|`, 'm').test(stripped)
    const hasHeading = new RegExp(`^###\\s+Layer\\s+${layer}\\b`, 'm').test(stripped)
    if (!hasTableRow || !hasHeading) {
      findings.push({
        file: PRIMITIVES_DOC,
        line: 1,
        rule: 'rule-as-code/missing-primitive-layer',
        target: `Layer ${layer}`,
        message: `${PRIMITIVES_DOC} must document Layer ${layer} in both the architecture table and a "### Layer ${layer}" section.`,
      })
    }
  }

  const citations = extractPrimitivesCitations(content)

  for (const bad of citations.invalidRefs) {
    findings.push({
      file: PRIMITIVES_DOC,
      line: bad.line,
      rule: bad.kind === 'cross-repo' ? 'rule-as-code/invalid-cross-repo-ref' : 'rule-as-code/invalid-local-path',
      target: bad.target,
      message: `Invalid ${bad.kind} path citation "${bad.target}".`,
    })
  }

  const checkedLocalPaths = new Set()
  for (const entry of citations.localPaths) {
    const normalized = entry.target.replace(/\/+$/, '')
    const resolvedTarget = resolve(root, normalized)
    if (!isWithinRoot(root, resolvedTarget) || !existsSync(resolvedTarget)) {
      findings.push({
        file: PRIMITIVES_DOC,
        line: entry.line,
        rule: 'rule-as-code/missing-local-path',
        target: entry.target,
        message: `Cited local path "${entry.target}" does not exist on disk.`,
      })
    } else {
      checkedLocalPaths.add(normalized)
    }
  }

  const checkedGlobPaths = new Set()
  for (const entry of citations.globPaths) {
    const prefix = entry.staticPrefix.replace(/\/+$/, '')
    const resolvedPrefix = resolve(root, prefix)
    if (!prefix || !isWithinRoot(root, resolvedPrefix) || !existsSync(resolvedPrefix)) {
      findings.push({
        file: PRIMITIVES_DOC,
        line: entry.line,
        rule: 'rule-as-code/missing-local-path',
        target: entry.target,
        message: `Static directory prefix "${prefix || entry.target}" for cited glob "${entry.target}" does not exist on disk.`,
      })
    } else {
      checkedGlobPaths.add(entry.target)
    }
  }

  const checkedScripts = new Set()
  if (pkgScripts) {
    for (const entry of citations.npmScripts) {
      if (!Object.hasOwn(pkgScripts, entry.script)) {
        findings.push({
          file: PRIMITIVES_DOC,
          line: entry.line,
          rule: 'rule-as-code/missing-npm-script',
          target: entry.script,
          message: `Cited pnpm script "pnpm ${entry.script}" is not defined in package.json.`,
        })
      } else {
        checkedScripts.add(entry.script)
      }
    }
  }

  const checkedLinks = new Set()
  const docDir = dirname(filePath)
  for (const link of extractMarkdownLinks(content)) {
    if (/^(?:https?:\/\/|mailto:|#)/.test(link.target)) continue
    const cleanTarget = link.target.split('#')[0]
    if (!cleanTarget) continue
    const resolvedTarget = resolve(docDir, cleanTarget)
    if (!isWithinRoot(root, resolvedTarget) || !existsSync(resolvedTarget)) {
      findings.push({
        file: PRIMITIVES_DOC,
        line: link.line,
        rule: 'rule-as-code/broken-markdown-link',
        target: link.target,
        message: `Broken relative link "${link.target}" in ${PRIMITIVES_DOC}.`,
      })
    } else {
      checkedLinks.add(relative(root, resolvedTarget))
    }
  }

  if (checkedLocalPaths.size === 0) {
    findings.push({
      file: PRIMITIVES_DOC,
      line: 1,
      rule: 'rule-as-code/no-verified-local-paths',
      target: PRIMITIVES_DOC,
      message: `${PRIMITIVES_DOC} must cite active local primitive modules and CI gates.`,
    })
  } else if (!checkedLocalPaths.has('scripts/rule-as-code-audit.mjs')) {
    findings.push({
      file: PRIMITIVES_DOC,
      line: 1,
      rule: 'rule-as-code/missing-self-reference',
      target: 'scripts/rule-as-code-audit.mjs',
      message: `${PRIMITIVES_DOC} must cite scripts/rule-as-code-audit.mjs as Layer 7 verification.`,
    })
  }

  checkRetiredAuthorityLines(PRIMITIVES_DOC, content, findings)

  return {
    findings,
    checkedLocalPaths: [...checkedLocalPaths].sort(),
    checkedGlobPaths: [...checkedGlobPaths].sort(),
    checkedLinks: [...checkedLinks].sort(),
    checkedScripts: [...checkedScripts].sort(),
    crossRepoRefs: [...new Set(citations.crossRepoRefs.map(ref => ref.target))].sort(),
  }
}

export function auditFrozenDecisions(root) {
  const findings = []
  const filePath = resolve(root, FROZEN_DECISIONS_DOC)
  if (!existsSync(filePath)) {
    findings.push({
      file: FROZEN_DECISIONS_DOC,
      line: 1,
      rule: 'rule-as-code/missing-frozen-decisions',
      target: FROZEN_DECISIONS_DOC,
      message: `Frozen decision archive ${FROZEN_DECISIONS_DOC} is missing.`,
    })
    return { findings, rowCount: 0 }
  }

  const content = readFileSync(filePath, 'utf8')
  const lines = content.split('\n')
  const header = lines.slice(0, 20).join('\n')

  const hasHistorical = /historical\s+snapshot/i.test(header)
  const hasNotPolicy = /not\s+current\s+operating\s+policy/i.test(header)
  const hasFrozenDate = new RegExp(`frozen(?:\\s+on)?\\s+${FROZEN_DECISIONS_CUTOFF}`, 'i').test(header)

  if (!hasHistorical || !hasNotPolicy || !hasFrozenDate) {
    findings.push({
      file: FROZEN_DECISIONS_DOC,
      line: 1,
      rule: 'rule-as-code/frozen-history-warning-missing',
      target: FROZEN_DECISIONS_DOC,
      message: `${FROZEN_DECISIONS_DOC} must retain its top frozen-history warning ("HISTORICAL SNAPSHOT — NOT CURRENT OPERATING POLICY. Frozen on ${FROZEN_DECISIONS_CUTOFF}.").`,
    })
  }

  let rowCount = 0
  for (let i = 0; i < lines.length; i++) {
    const match = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/.exec(lines[i])
    if (!match) continue
    rowCount++
    if (match[1] > FROZEN_DECISIONS_CUTOFF) {
      findings.push({
        file: FROZEN_DECISIONS_DOC,
        line: i + 1,
        rule: 'rule-as-code/frozen-decisions-appended',
        target: match[1],
        message: `Row dated ${match[1]} was appended after freeze date ${FROZEN_DECISIONS_CUTOFF}; record new decisions in docs/design/decisions/ instead.`,
      })
    }
  }

  return { findings, rowCount }
}

export function auditDocsIndex(root) {
  const findings = []
  const filePath = resolve(root, DOCS_INDEX)
  if (!existsSync(filePath)) {
    findings.push({
      file: DOCS_INDEX,
      line: 1,
      rule: 'rule-as-code/missing-docs-index',
      target: DOCS_INDEX,
      message: `Documentation index ${DOCS_INDEX} does not exist.`,
    })
    return { findings, checkedLinks: [] }
  }

  const content = readFileSync(filePath, 'utf8')
  const links = extractMarkdownLinks(content)
  const docDir = dirname(filePath)
  const checkedLinks = new Set()

  let linksPrimitives = false
  for (const link of links) {
    if (/^(?:https?:\/\/|mailto:|#)/.test(link.target)) continue
    const cleanTarget = link.target.split('#')[0]
    if (!cleanTarget) continue
    const resolvedTarget = resolve(docDir, cleanTarget)
    if (!isWithinRoot(root, resolvedTarget) || !existsSync(resolvedTarget)) {
      findings.push({
        file: DOCS_INDEX,
        line: link.line,
        rule: 'rule-as-code/broken-docs-index-link',
        target: link.target,
        message: `Broken relative link "${link.target}" in ${DOCS_INDEX}.`,
      })
    } else {
      const repoRel = relative(root, resolvedTarget)
      checkedLinks.add(repoRel)
      if (repoRel === PRIMITIVES_DOC) linksPrimitives = true
    }
  }

  if (!linksPrimitives) {
    findings.push({
      file: DOCS_INDEX,
      line: 1,
      rule: 'rule-as-code/missing-primitives-index-link',
      target: PRIMITIVES_DOC,
      message: `${DOCS_INDEX} must link to ${PRIMITIVES_DOC} (architecture/primitives.md).`,
    })
  }

  // Verify snapshot non-authority warnings stay present in docs/README.md.
  if (!/design\/decisions\.md\)[^\n]*not active instructions/is.test(content)) {
    findings.push({
      file: DOCS_INDEX,
      line: 1,
      rule: 'rule-as-code/missing-decisions-snapshot-warning',
      target: FROZEN_DECISIONS_DOC,
      message: `${DOCS_INDEX} must explicitly warn that design/decisions.md is legacy and not active instructions.`,
    })
  }

  if (!/dated audits[^\n]*not a second source of operating instructions/i.test(content)) {
    findings.push({
      file: DOCS_INDEX,
      line: 1,
      rule: 'rule-as-code/missing-dated-audit-warning',
      target: DOCS_INDEX,
      message: `${DOCS_INDEX} must explicitly warn that dated audits and screenshot snapshots are not a second source of operating instructions.`,
    })
  }

  // Every index bullet must link to an owning document, and any retirement/superseded status
  // claim must carry an ISO date or link to a dated decision record.
  const bullets = parseBulletBlocks(content)
  for (const bullet of bullets) {
    const bulletLinks = [...stripInlineCode(bullet.text).matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)]
    if (bulletLinks.length === 0) {
      findings.push({
        file: DOCS_INDEX,
        line: bullet.line,
        rule: 'rule-as-code/unlinked-docs-index-entry',
        target: bullet.text.split('\n')[0].trim().slice(0, 80),
        message: `Bullet in ${DOCS_INDEX} has no link to an owning document; add a link instead of an unlinked rule.`,
      })
      continue
    }

    const mentionsStatusChange = /\b(?:retired|superseded|deprecated|replaced)\b/i.test(bullet.text)
    const isGeneralSnapshotDisclaimer = /not active instructions/i.test(bullet.text)
    if (mentionsStatusChange && !isGeneralSnapshotDisclaimer) {
      const hasIsoDate = /\b20\d{2}-\d{2}-\d{2}\b/.test(bullet.text)
      const hasDatedDecisionLink = bulletLinks.some(([, , target]) => /decisions\/\d{4}-\d{2}-\d{2}-/.test(target))
      if (!hasIsoDate && !hasDatedDecisionLink) {
        findings.push({
          file: DOCS_INDEX,
          line: bullet.line,
          rule: 'rule-as-code/undated-status-contradiction',
          target: bullet.text.split('\n')[0].trim().slice(0, 80),
          message: `Retired/superseded/deprecated entry in ${DOCS_INDEX} must cite an ISO date (YYYY-MM-DD) or link to a dated decision record.`,
        })
      }
    }
  }

  // Reject bare undated policy overrides anywhere in docs/README.md.
  const stripped = stripFencedCodeBlocks(content)
  const lines = stripped.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/\b(?:OVERRIDE|EXCEPTION|TEMP\s+RULE|TEMPORARY\s+RULE)\s*:/.test(line)) {
      const hasDate = /\b20\d{2}-\d{2}-\d{2}\b/.test(line)
      const hasLink = /\[[^\]]+\]\([^)\s]+\)/.test(line)
      if (!hasDate || !hasLink) {
        findings.push({
          file: DOCS_INDEX,
          line: i + 1,
          rule: 'rule-as-code/undated-policy-override',
          target: line.trim().slice(0, 80),
          message: `Policy override in ${DOCS_INDEX} must include both an ISO date and a link to its owning decision.`,
        })
      }
    }
  }

  checkRetiredAuthorityLines(DOCS_INDEX, content, findings)

  return { findings, checkedLinks: [...checkedLinks].sort() }
}

export function auditRuleAsCodeRepository(root = process.cwd()) {
  const pkgPath = resolve(root, 'package.json')
  let pkgScripts = null
  if (existsSync(pkgPath)) {
    try {
      pkgScripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? null
    } catch {
      pkgScripts = null
    }
  }

  const primitives = auditPrimitivesMap(root, pkgScripts)
  const decisions = auditFrozenDecisions(root)
  const docsIndex = auditDocsIndex(root)

  const findings = [
    ...primitives.findings,
    ...decisions.findings,
    ...docsIndex.findings,
  ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule))

  return {
    ok: findings.length === 0,
    findings,
    summary: {
      checkedLocalPaths: primitives.checkedLocalPaths.length,
      checkedGlobPaths: primitives.checkedGlobPaths.length,
      checkedPrimitivesLinks: primitives.checkedLinks.length,
      checkedScripts: primitives.checkedScripts.length,
      crossRepoRefs: primitives.crossRepoRefs.length,
      frozenDecisionRows: decisions.rowCount,
      checkedDocsIndexLinks: docsIndex.checkedLinks.length,
    },
    details: {
      checkedLocalPaths: primitives.checkedLocalPaths,
      checkedGlobPaths: primitives.checkedGlobPaths,
      checkedScripts: primitives.checkedScripts,
      crossRepoRefs: primitives.crossRepoRefs,
    },
  }
}

function parseRootArg(argv) {
  const idx = argv.indexOf('--root')
  if (idx !== -1 && argv[idx + 1]) return resolve(argv[idx + 1])
  return process.cwd()
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = parseRootArg(process.argv)
  const asJson = process.argv.includes('--json')
  const result = auditRuleAsCodeRepository(root)
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const finding of result.findings) {
      console.error(`${finding.file}:${finding.line} error [${finding.rule}] ${finding.message}`)
    }
    if (result.ok) {
      const s = result.summary
      console.log(
        `rule-as-code audit: pass (${s.checkedLocalPaths} local paths, ${s.checkedScripts} scripts, ${s.crossRepoRefs} cross-repo markers, ${s.checkedDocsIndexLinks} docs/README links, ${s.frozenDecisionRows} frozen decision rows)`,
      )
    }
  }
  if (!result.ok) process.exitCode = 1
}
