import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import yaml from 'js-yaml'

export const PENDING_REGISTER = 'docs/decisions/pending.yaml'
const TEXT = new Set(['.md', '.mdx', '.ts', '.tsx', '.js', '.mjs', '.json', '.yaml', '.yml'])
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.next', '.hosted-ui', 'dist', 'build'])
const owner = 'Al' + 'ex'
const pendingText = new RegExp(`pending ${owner}(?:'s)?|awaiting ${owner}|待\\s*${owner}`, 'i')

function walk(dir = '.', files = []) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, files)
    else if (TEXT.has(extname(entry))) files.push(path)
  }
  return files
}

export function validatePendingRegister(root = '.') {
  const path = join(root, PENDING_REGISTER)
  if (!existsSync(path)) return [`${PENDING_REGISTER} is missing`]
  const rows = yaml.load(readFileSync(path, 'utf8'))
  if (!Array.isArray(rows)) return [`${PENDING_REGISTER} must be a list`]
  const problems = []
  const ids = new Set()
  rows.forEach((row, index) => {
    const where = `${PENDING_REGISTER}[${index}]`
    for (const key of ['id', 'question', 'options', 'recommendation', 'asked_on', 'owner', 'link']) if (!(key in (row ?? {}))) problems.push(`${where} missing ${key}`)
    if (typeof row?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(row.id)) problems.push(`${where}.id must be kebab-case`)
    else if (ids.has(row.id)) problems.push(`${where}.id duplicates ${row.id}`)
    else ids.add(row.id)
    if (!Array.isArray(row?.options) || row.options.length === 0) problems.push(`${where}.options must be a non-empty list`)
    const asked = row?.asked_on instanceof Date ? row.asked_on.toISOString().slice(0, 10) : String(row?.asked_on ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asked)) problems.push(`${where}.asked_on must be YYYY-MM-DD`)
  })
  return problems
}

export function pendingLintProblems(root = '.') {
  const problems = []
  for (const path of walk(root)) {
    const rel = path.replace(/^\.\//, '').replaceAll('\\', '/')
    if (rel === PENDING_REGISTER || rel === 'scripts/pending-decisions.mjs' || rel === 'scripts/docs-gates.test.mjs') continue
    if (rel.startsWith('docs/design/decisions/') || rel === 'docs/design/decisions.md') continue
    const lines = readFileSync(path, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (pendingText.test(line)) problems.push(`${rel}:${index + 1}: pending decision text outside ${PENDING_REGISTER}`)
    })
  }
  return problems
}
