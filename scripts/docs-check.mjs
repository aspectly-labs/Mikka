import { readFileSync } from 'node:fs'
import { GENERATED_DOCUMENTS } from './docs-generate.mjs'
import { renderGenerated } from './docs-generated.mjs'
import { validatePendingRegister, pendingLintProblems } from './pending-decisions.mjs'


const EXPECTED_GENERATED = {
  'docs/hosted-models.md': ['hosted-models'],
  'docs/operations/feature-flags.md': ['feature-flags'],
  'docs/operations/machine-sizes.md': ['machine-sizes'],
  'docs/settings.md': ['settings-sections'],
}

function generatedMarkerProblems(text, path) {
  const problems = []
  for (const name of EXPECTED_GENERATED[path] ?? []) {
    const open = `<!-- generated:${name} -->`
    const close = `<!-- /generated:${name} -->`
    if (!text.includes(open) || !text.includes(close) || text.indexOf(open) > text.indexOf(close)) {
      problems.push(`${path}: generated block ${name} is missing or broken; restore the markers and run pnpm docs:generate`)
    }
  }
  const withoutValidBlocks = text.replace(/<!-- generated:([a-z0-9-]+) -->\n[\s\S]*?<!-- \/generated:\1 -->/g, '')
  if (/<!-- \/?generated:/.test(withoutValidBlocks)) problems.push(`${path}: unknown, reversed or malformed generated marker`)
  return problems
}

const problems = []
for (const path of GENERATED_DOCUMENTS) {
  const before = readFileSync(path, 'utf8')
  problems.push(...generatedMarkerProblems(before, path))
  if (renderGenerated(before) !== before) problems.push(`${path}: generated content is stale; run pnpm docs:generate`)
}
problems.push(...validatePendingRegister('.'))
problems.push(...pendingLintProblems('.'))
const claims = JSON.parse(readFileSync('docs/doc-claims.json', 'utf8'))
for (const claim of claims.claims) {
  for (const path of claim.paths ?? []) {
    const text = readFileSync(path, 'utf8')
    const outside = text.replace(/<!-- generated:[a-z0-9-]+ -->[\s\S]*?<!-- \/generated:[a-z0-9-]+ -->/g, '')
    if (outside.includes(claim.text)) problems.push(`${path}: banned claim: ${claim.text}`)
  }
}
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('docs gates passed')
