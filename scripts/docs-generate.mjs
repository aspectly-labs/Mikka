import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderGenerated } from './docs-generated.mjs'

export const GENERATED_DOCUMENTS = ['docs/hosted-models.md', 'docs/operations/feature-flags.md', 'docs/operations/machine-sizes.md', 'docs/settings.md']
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const path of GENERATED_DOCUMENTS) writeFileSync(path, renderGenerated(readFileSync(path, 'utf8')))
  console.log(`generated docs updated (${GENERATED_DOCUMENTS.length} file(s))`)
}
