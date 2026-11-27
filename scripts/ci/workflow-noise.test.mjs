import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import yaml from 'js-yaml'

const directory = new URL('../../.github/workflows/', import.meta.url)
const files = readdirSync(directory).filter(name => /\.ya?ml$/.test(name))
const text = name => readFileSync(new URL(name, directory), 'utf8')
const workflow = name => yaml.load(text(name))

test('no workflow guards on the old repository name alone: the id survives the move, the name did not', () => {
  for (const name of files) {
    for (const line of text(name).split('\n').filter(line => /github\.repository == 'alexj11324\/Mikka'/.test(line)))
      assert.match(line, /github\.repository_id == '1427517699'/, `${name}: ${line.trim()}`)
  }
})

test('the retired one-shot issue workflows stay deleted', () => {
  for (const name of ['issues-1515-1517-cleanup.yml', 'issues-1515-1517-diagnostics.yml', 'issues-1516-welcome-acceptance.yml'])
    assert.ok(!files.includes(name), name)
})

test('no workflow is triggered by pushes to stale codex/* branches', () => {
  for (const name of files) {
    const branches = workflow(name).on?.push?.branches ?? []
    assert.deepEqual(branches.filter(branch => branch.startsWith('codex/')), [], name)
  }
})

test('waiting issues only reopens on close; CI Source checks run the check', () => {
  assert.deepEqual(workflow('waiting-issues.yml').on, { issues: { types: ['closed'] } })
  const source = workflow('ui-policy.yml').jobs['source-checks'].steps.find(step => step.name === 'Check waiting issues')
  assert.equal(source.run, 'node scripts/check-waiting-issues.mjs')
  assert.equal(source.if, 'always()')
})

test('production smoke follows deployment runs, not every deployment status', () => {
  const smoke = workflow('production-smoke.yml')
  assert.equal(smoke.on.deployment_status, undefined)
  assert.deepEqual(smoke.on.workflow_run, { workflows: ['Cloudflare application deployment'], types: ['completed'], branches: ['main'] })
  assert.equal(workflow('cloudflare-app-deploy.yml').name, 'Cloudflare application deployment')
  assert.ok(smoke.on.schedule.some(entry => entry.cron === '17 14 * * *'), 'the daily smoke stays')
  for (const job of ['smoke', 'deployment-comparison']) {
    assert.equal(smoke.jobs[job].needs, 'production-promotion', job)
    assert.match(smoke.jobs[job].if, /\(github\.event_name != 'workflow_run' \|\| needs\.production-promotion\.outputs\.promoted == 'true'\)/, job)
    assert.doesNotMatch(smoke.jobs[job].if, /deployment_status/, job)
  }
  const gate = smoke.jobs['production-promotion']
  assert.match(gate.if, /github\.event\.workflow_run\.conclusion == 'success'/)
  assert.equal(gate.steps.at(-1).run, 'node scripts/release/production-promotion.mjs', 'step-level promotion evidence')
})
