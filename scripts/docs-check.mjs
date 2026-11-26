import { readFileSync } from 'node:fs'
import { GENERATED_DOCUMENTS } from './docs-generate.mjs'
import { renderGenerated } from './docs-generated.mjs'
import { validatePendingRegister, pendingLintProblems } from './pending-decisions.mjs'

const problems = []
for (const path of GENERATED_DOCUMENTS) {
  const before = readFileSync(path, 'utf8')
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
