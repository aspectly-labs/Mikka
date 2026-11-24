import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const HANDBOOK_PATH = 'docs/engineering/HANDBOOK.md'
const DECISIONS_DIR = 'docs/design/decisions'
const DECISIONS_README = 'docs/design/decisions/README.md'
const FROZEN_DECISIONS = 'docs/design/decisions.md'

const REQUIRED_TEMPLATES = [
  'docs/engineering/templates/design-doc.md',
  'docs/engineering/templates/ui-spec.md',
  'docs/engineering/templates/coe-postmortem.md',
]

const CROSS_REPO_PREFIXES = ['mikka-hosted-ui/', 'mikka-cloud/']
const LOCAL_DIR_PREFIXES = new Set([
  '.agents',
  '.claude',
  '.github',
  'app',
  'apps',
  'cloudflare',
  'config',
  'deploy',
  'docs',
  'drizzle',
  'lib',
  'messages',
  'packages',
  'public',
  'scripts',
  'tests',
])
const LOCAL_ROOT_FILES = new Set(['AGENTS.md', 'CONTRIBUTING.md', 'package.json', 'ui-policy.json'])

const CANONICAL_ADR_STATUS_RE =
  /^(?:-\s+)?(?:\*\*Status:\*\*|Status:)\s*(Accepted\b|Superseded(?:\s+in\s+part)?\s+by\s+\[[^\]]+\]\(([0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md)\))/

function stripFencedCodeBlocks(markdown) {
  const lines = markdown.split(/\r?\n/)
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  return lines
    .map(line => {
      const m = /^\s*(`{3,}|~{3,})/.exec(line)
      if (m) {
        if (!inFence) {
          inFence = true
          fenceChar = m[1][0]
          fenceLen = m[1].length
          return ''
        }
        if (m[1][0] === fenceChar && m[1].length >= fenceLen) {
          inFence = false
          fenceChar = ''
          fenceLen = 0
          return ''
        }
      }
      return inFence ? '' : line
    })
    .join('\n')
}

function headingSlugs(markdown) {
  const slugs = new Set()
  const seen = new Map()
  for (const line of stripFencedCodeBlocks(markdown).split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)
    if (!m) continue
    const base = m[1]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
    if (!base) continue
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    slugs.add(count === 0 ? base : `${base}-${count}`)
  }
  return slugs
}

function stripInlineCode(markdown) {
  return markdown.replace(/`[^`\n]+`/g, 'CODE')
}

function checkMarkdownLinks(root, relFile, text, errors) {
  const stripped = stripInlineCode(stripFencedCodeBlocks(text))
  const linkRe = /(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (const m of stripped.matchAll(linkRe)) {
    const rawTarget = m[1]
    if (/^(?:https?:|mailto:|tel:)/i.test(rawTarget)) continue
    const [targetPath, fragment] = rawTarget.split('#')
    const resolved = targetPath ? resolve(root, dirname(relFile), targetPath) : resolve(root, relFile)
    if (!existsSync(resolved)) {
      errors.push(`${relFile}: broken markdown link target '${rawTarget}'`)
      continue
    }
    if (fragment && resolved.endsWith('.md')) {
      const slugs = headingSlugs(readFileSync(resolved, 'utf8'))
      if (!slugs.has(fragment.toLowerCase())) {
        errors.push(`${relFile}: broken heading anchor '#${fragment}' in '${rawTarget}'`)
      }
    }
  }
}

function checkBacktickPaths(root, relFile, text, errors) {
  const stripped = stripFencedCodeBlocks(text)
  const codeRe = /`([^`\n]+)`/g
  for (const m of stripped.matchAll(codeRe)) {
    const token = m[1].trim()
    if (!token || /\s/.test(token)) continue
    if (token.startsWith('/') || token.startsWith('--') || token.startsWith('@')) continue
    if (/[*<>{}$]/.test(token)) continue
    if (CROSS_REPO_PREFIXES.some(prefix => token.startsWith(prefix))) {
      if (token.includes('..')) {
        errors.push(`${relFile}: invalid cross-repo path '${token}'`)
      }
      continue
    }
    const clean = token.split('#')[0].replace(/\/+$/, '')
    if (!clean) continue
    const firstSeg = clean.split('/')[0]
    const isLocalPath =
      LOCAL_ROOT_FILES.has(clean) ||
      (clean.includes('/') && LOCAL_DIR_PREFIXES.has(firstSeg))
    if (!isLocalPath) continue
    const full = resolve(root, clean)
    if (!existsSync(full)) {
      errors.push(`${relFile}: referenced local path '${clean}' does not exist`)
    }
  }
}

export function auditEngineeringHandbook(root) {
  const errors = []

  const handbookAbs = resolve(root, HANDBOOK_PATH)
  if (!existsSync(handbookAbs)) {
    errors.push(`Missing ${HANDBOOK_PATH}`)
    return { errors, adrCounts: { total: 0, accepted: 0, superseded: 0, supersededInPart: 0 } }
  }

  const handbook = readFileSync(handbookAbs, 'utf8')
  for (const requiredHeading of [
    'Three-tier documentation architecture',
    'Stage 1:',
    'Stage 2:',
    'Stage 3:',
    'Stage 4:',
    'Stage 5:',
    'Stage 6:',
  ]) {
    if (!handbook.includes(requiredHeading)) {
      errors.push(`${HANDBOOK_PATH}: missing required section '${requiredHeading}'`)
    }
  }

  for (const tpl of REQUIRED_TEMPLATES) {
    if (!existsSync(resolve(root, tpl))) {
      errors.push(`Missing required engineering template: ${tpl}`)
    }
  }

  checkMarkdownLinks(root, HANDBOOK_PATH, handbook, errors)
  checkBacktickPaths(root, HANDBOOK_PATH, handbook, errors)

  // Verify top-level pointers and markdown links in AGENTS.md and docs/README.md
  for (const entry of ['AGENTS.md', 'docs/README.md']) {
    const abs = resolve(root, entry)
    if (!existsSync(abs)) {
      errors.push(`Missing ${entry}`)
      continue
    }
    const content = readFileSync(abs, 'utf8')
    if (!content.includes('engineering/HANDBOOK.md')) {
      errors.push(`${entry}: missing pointer to docs/engineering/HANDBOOK.md`)
    }
    checkMarkdownLinks(root, entry, content, errors)
  }

  // Verify decisions README links and Status header convention
  const decisionsReadmeAbs = resolve(root, DECISIONS_README)
  if (!existsSync(decisionsReadmeAbs)) {
    errors.push(`Missing ${DECISIONS_README}`)
  } else {
    const readmeText = readFileSync(decisionsReadmeAbs, 'utf8')
    checkMarkdownLinks(root, DECISIONS_README, readmeText, errors)
  }

  // Verify every ADR in docs/design/decisions/20*.md carries a canonical Status header
  const decisionsDirAbs = resolve(root, DECISIONS_DIR)
  const adrCounts = { total: 0, accepted: 0, superseded: 0, supersededInPart: 0 }
  if (!existsSync(decisionsDirAbs)) {
    errors.push(`Missing ${DECISIONS_DIR}`)
  } else {
    const files = readdirSync(decisionsDirAbs)
      .filter(f => /^20\d{2}-.*\.md$/.test(f))
      .sort()
    const fileSet = new Set(files)
    adrCounts.total = files.length

    for (const file of files) {
      const text = readFileSync(join(decisionsDirAbs, file), 'utf8')
      const topLines = text.split(/\r?\n/).slice(0, 15)
      let match = null
      for (const line of topLines) {
        const m = CANONICAL_ADR_STATUS_RE.exec(line.trim())
        if (m) {
          match = m
          break
        }
      }
      if (!match) {
        errors.push(`${DECISIONS_DIR}/${file}: missing canonical Status header in first 15 lines`)
        continue
      }
      const statusText = match[1]
      const targetFile = match[2]
      if (targetFile) {
        if (targetFile === file) {
          errors.push(`${DECISIONS_DIR}/${file}: Status header cannot supersede itself`)
        } else if (!fileSet.has(targetFile)) {
          errors.push(`${DECISIONS_DIR}/${file}: Status supersession target '${targetFile}' does not exist`)
        } else if (targetFile.slice(0, 10) < file.slice(0, 10)) {
          errors.push(
            `${DECISIONS_DIR}/${file}: Status supersession target '${targetFile}' predates this ADR`,
          )
        }
        if (/^Superseded\s+in\s+part/i.test(statusText)) adrCounts.supersededInPart++
        else adrCounts.superseded++
      } else {
        adrCounts.accepted++
      }
    }
  }

  // Verify frozen decisions.md remains present and carries its non-authoritative notice
  const frozenAbs = resolve(root, FROZEN_DECISIONS)
  if (!existsSync(frozenAbs)) {
    errors.push(`Missing frozen archive ${FROZEN_DECISIONS}`)
  } else {
    const frozenText = readFileSync(frozenAbs, 'utf8')
    if (!/frozen|archive|legacy|historical|停止更新|冻结/i.test(frozenText.slice(0, 1500))) {
      errors.push(`${FROZEN_DECISIONS}: missing frozen/historical archive banner`)
    }
  }

  return { errors, adrCounts }
}

test('Engineering Handbook, templates, pointers, and all ADRs pass Tier 3 audit', () => {
  const result = auditEngineeringHandbook(REPO_ROOT)
  assert.deepEqual(result.errors, [], `Handbook / ADR audit errors:\n${result.errors.join('\n')}`)
  assert.ok(result.adrCounts.total >= 300, `expected >= 300 ADRs, saw ${result.adrCounts.total}`)
  assert.equal(
    result.adrCounts.accepted + result.adrCounts.superseded + result.adrCounts.supersededInPart,
    result.adrCounts.total,
  )
})

test('auditEngineeringHandbook rejects missing ADR Status headers, broken supersession links, and missing handbook paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handbook-audit-'))
  try {
    mkdirSync(join(dir, 'docs/engineering/templates'), { recursive: true })
    mkdirSync(join(dir, 'docs/design/decisions'), { recursive: true })
    writeFileSync(join(dir, 'AGENTS.md'), 'See `docs/engineering/HANDBOOK.md`.\n')
    writeFileSync(join(dir, 'docs/README.md'), 'See [Handbook](engineering/HANDBOOK.md).\n')
    writeFileSync(join(dir, 'docs/design/decisions.md'), '# Decisions\n\nFrozen archive through 2026-10-31.\n')
    writeFileSync(join(dir, 'docs/design/decisions/README.md'), '# ADRs\n')
    for (const tpl of REQUIRED_TEMPLATES) {
      writeFileSync(join(dir, tpl), '# Template\n')
    }
    writeFileSync(
      join(dir, HANDBOOK_PATH),
      [
        '# Handbook',
        '## Three-tier documentation architecture',
        '## Stage 1: Spec',
        '## Stage 2: Arch',
        'See `scripts/does-not-exist.mjs`, [Broken](../nope.md), and [`code-link`](../also-missing.md).',
        'Example syntax: `- **Status:** Superseded by [<placeholder>](<placeholder>.md)`.',
        '## Stage 3: Static',
        '## Stage 4: Verify',
        '## Stage 5: Release',
        '## Stage 6: COE',
      ].join('\n'),
    )
    writeFileSync(join(dir, 'docs/design/decisions/2026-11-01-0000-no-status.md'), '# Missing\n\nBody.\n')
    writeFileSync(
      join(dir, 'docs/design/decisions/2026-11-02-0000-bad-target.md'),
      '# Bad\n\n- **Status:** Superseded by [missing](2026-11-03-0000-missing.md)\n',
    )
    writeFileSync(
      join(dir, 'docs/design/decisions/2026-11-05-0000-older-target.md'),
      '# Older\n\n- **Status:** Superseded by [old](2026-11-01-0000-no-status.md)\n',
    )

    const { errors } = auditEngineeringHandbook(dir)
    assert.ok(errors.some(e => e.includes("referenced local path 'scripts/does-not-exist.mjs'")))
    assert.ok(errors.some(e => e.includes("broken markdown link target '../nope.md'")))
    assert.ok(errors.some(e => e.includes("broken markdown link target '../also-missing.md'")))
    assert.ok(!errors.some(e => e.includes('<placeholder>')))
    assert.ok(errors.some(e => e.includes('2026-11-01-0000-no-status.md: missing canonical Status header')))
    assert.ok(errors.some(e => e.includes("2026-11-02-0000-bad-target.md: Status supersession target '2026-11-03-0000-missing.md' does not exist")))
    assert.ok(errors.some(e => e.includes("2026-11-05-0000-older-target.md: Status supersession target '2026-11-01-0000-no-status.md' predates this ADR")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
