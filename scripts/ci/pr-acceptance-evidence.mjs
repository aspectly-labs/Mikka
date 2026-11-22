import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// #2888: a feature PR's body must carry real acceptance evidence, not the
// untouched "How it was checked" template. Deterministic check on the PR body
// — pull_request reads the event payload; merge_group resolves the queued PR's
// current body via the API so body edits are honoured at the merge gate.

const HTML_COMMENT = /<!--[\s\S]*?-->/g
// Field values that do not count as evidence.
const EMPTY_FIELD = /^(\.{3}|N\/?A|not applicable|none|no|tbd|todo|pending|wip|-+|—)$/i
// A git SHA token near a sha/commit label; the lookaheads keep CI run ids
// (pure digits) from satisfying the requirement.
const HEAD_SHA = /(?:sha|commit|head)[^\n]{0,40}?\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i

export function evidenceErrors(body) {
  const errors = []
  const heading = body.match(/^##\s+How it was checked[^\n]*$/m)
  if (!heading) return ['missing "## How it was checked" section']
  const rest = body.slice(heading.index + heading[0].length)
  const next = rest.search(/^##\s/m)
  const section = (next === -1 ? rest : rest.slice(0, next)).replace(HTML_COMMENT, '')
  if (!section.trim()) errors.push('"How it was checked" is empty template text')
  const filled = section
    .split(/\n\s*-\s+/)
    .map(line => line.replace(/^[^:]+:\s*/, '').trim())
    .filter(value => value && !EMPTY_FIELD.test(value))
  if (filled.length < 2) errors.push('fewer than two evidence fields are filled')
  if (!HEAD_SHA.test(section)) errors.push('missing local source HEAD SHA')
  return errors
}

export function mergeGroupPrNumber(headRef = '') {
  return headRef.match(/\/pr-(\d+)-/)?.[1] ?? null
}

export async function prBody(env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  if (env.GITHUB_EVENT_NAME === 'pull_request') return event.pull_request?.body ?? ''
  if (env.GITHUB_EVENT_NAME === 'merge_group') {
    const number = mergeGroupPrNumber(event.merge_group?.head_ref)
    assert.ok(number, 'merge_group head_ref lacks a PR number')
    return execFileSync('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/pulls/${number}`, '--jq', '.body'], { encoding: 'utf8' })
  }
  assert.fail(`acceptance evidence is only checked on pull_request and merge_group events, not ${env.GITHUB_EVENT_NAME}`)
}

export async function main(env = process.env) {
  const body = await prBody(env)
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
