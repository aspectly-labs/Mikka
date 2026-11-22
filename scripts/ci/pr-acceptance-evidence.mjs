import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #2888: a feature PR's body must carry real acceptance evidence, not the
// untouched "How it was checked" template. Deterministic check on the PR body
// only — no network, no judgement calls.

const PLACEHOLDER = /<!--[\s\S]*?-->|^\s*-?\s*$/gm

export function evidenceErrors(body) {
  const errors = []
  const match = body.match(/^##\s+How it was checked\s*\n([\s\S]*?)(?=\n##\s|$)/m)
  if (!match) return ['missing "## How it was checked" section']
  const section = match[1].replace(PLACEHOLDER, '').trim()
  if (!section) errors.push('"How it was checked" is empty template text')
  const fields = section.split(/\n\s*-\s+/).map(line => line.trim()).filter(Boolean)
  const filled = fields.filter(line => {
    const value = line.replace(/^[^:]+:\s*/, '').trim()
    return value.length > 0 && !/^($|\.\.\.|N\/A$|TBD$)/i.test(value)
  })
  if (filled.length === 0 && section.length === 0) errors.push('no acceptance evidence recorded')
  const hasSha = /[0-9a-f]{7,40}/i.test(section)
  if (!hasSha) errors.push('missing local source HEAD SHA')
  return errors
}

export function main(env = process.env) {
  assert.ok(env.GITHUB_EVENT_NAME === 'pull_request', 'acceptance evidence is only checked on pull_request events')
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  const body = event.pull_request?.body ?? ''
  const errors = evidenceErrors(body)
  if (errors.length) {
    for (const error of errors) console.error(`PR acceptance evidence missing: ${error}`)
    console.error('Fill the "How it was checked" section of the PR template with the real local SHA, test commands/results, and the acceptance outcome.')
    process.exitCode = 1
    return
  }
  console.log('PR acceptance evidence present.')
}

if (import.meta.url === `file://${process.argv[1]}`) main()
