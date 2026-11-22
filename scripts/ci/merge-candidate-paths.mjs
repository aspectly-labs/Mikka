import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

const filters = JSON.parse(readFileSync(new URL('./merge-candidate-paths.json', import.meta.url)))
const { merge_group: { base_sha: base, head_sha: head } } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH))
for (const sha of [base, head]) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a merge-group commit SHA')
}
const files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head], { encoding: 'utf8' }).split('\0')
const policyChanged = files.some(file => [
  '.github/workflows/ci-merge-candidate.yml',
  'scripts/ci/merge-candidate-paths.mjs',
  'scripts/ci/merge-candidate-paths.json',
].includes(file))
// These path filters use GitHub's *, ** and **/ wildcards, including dotfiles.
const matcher = pattern => new RegExp('^' + pattern.split(/(\*\*\/|\*\*|\*)/).map(part => {
  if (part === '**/') return '(?:.*/)?'
  if (part === '**') return '.*'
  if (part === '*') return '[^/]*'
  return part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}).join('') + '$')
for (const [workflow, paths] of Object.entries(filters)) {
  const selected = policyChanged || paths.map(matcher).some(pattern => files.some(file => pattern.test(file)))
  appendFileSync(process.env.GITHUB_OUTPUT, `${workflow}=${selected}\n`)
}
