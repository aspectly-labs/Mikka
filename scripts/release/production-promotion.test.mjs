import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { PROMOTION_STEPS, isPipelineProductionPromoted, promotedProduction } from './production-promotion.mjs'

const steps = (outcome = 'success') => [
  'Set up job', 'Verify the actual public release identity', 'Select the verified staging result and production baseline',
  'Check out the pinned operations source', 'Read the existing Cloudflare deployment identity', ...PROMOTION_STEPS, 'Complete job',
].map((name, index) => ({ number: index + 1, name, status: 'completed',
  conclusion: PROMOTION_STEPS.includes(name) || name === 'Check out the pinned operations source' || name === 'Read the existing Cloudflare deployment identity' ? outcome : 'success' }))
const job = (name, extra = {}) => ({ name, status: 'completed', conclusion: 'success', steps: steps(), ...extra })
// Run 45913824441 promoted production (Production deployment 0e259f65); its pipeline-production steps, trimmed.
const promoted = [job('pipeline'), job('pipeline-record'), job('pipeline-production'), job('pipeline-production-record')]
// A green run with nothing staged to promote (#3375 `not-ready`): the selection step succeeds and every
// later step is skipped, so pipeline-production still concludes success.
const notReady = [job('pipeline'), job('pipeline-record'), job('pipeline-production', { steps: steps('skipped') })]

test('a real promotion counts; a green not-ready run and partial evidence do not', () => {
  assert.equal(promotedProduction(promoted), true)
  assert.equal(notReady.find(entry => entry.name === 'pipeline-production').conclusion, 'success')
  assert.equal(promotedProduction(notReady), false)
  for (const broken of [
    { conclusion: 'failure' }, { status: 'in_progress' },
    { steps: steps().map(step => step.name === PROMOTION_STEPS[1] ? { ...step, conclusion: 'skipped' } : step) },
    { steps: steps().filter(step => step.name !== PROMOTION_STEPS[0]) }, { steps: undefined },
  ]) assert.equal(isPipelineProductionPromoted(job('pipeline-production', broken)), false, JSON.stringify(broken).slice(0, 80))
  assert.equal(promotedProduction([job('pipeline')]), false)
  assert.equal(promotedProduction([job('pipeline-production'), job('pipeline-production')]), false, 'one job per attempt')
  assert.equal(promotedProduction(null), false)
})

test('the command line reads the run attempt and writes promoted for each case', async () => {
  const listings = { 41: promoted, 42: notReady }
  const server = createServer((request, response) => {
    const match = /\/actions\/runs\/(\d+)\/attempts\/1\/jobs/.exec(request.url)
    const jobs = match && listings[match[1]]
    if (!jobs || request.headers.authorization !== 'Bearer token') { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ total_count: jobs.length, jobs }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const directory = mkdtempSync(join(tmpdir(), 'promotion-'))
  try {
    for (const [run, expected] of [['41', 'true'], ['42', 'false'], ['43', 'false']]) {
      const output = join(directory, `output-${run}`)
      writeFileSync(output, '')
      const code = await new Promise(done => spawn(process.execPath, [fileURLToPath(new URL('./production-promotion.mjs', import.meta.url))], {
        env: { PATH: process.env.PATH, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: 'aspectly-labs/Mikka',
          RUN_ID: run, RUN_ATTEMPT: '1', GH_TOKEN: 'token', GITHUB_OUTPUT: output }, stdio: 'ignore',
      }).on('exit', done))
      assert.equal(code, 0)
      assert.equal(readFileSync(output, 'utf8'), `promoted=${expected}\n`, run)
    }
  } finally {
    server.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the deploy workflow still names the promotion steps this reads', () => {
  const deploy = yaml.load(readFileSync(new URL('../../.github/workflows/cloudflare-app-deploy.yml', import.meta.url), 'utf8'))
  const names = deploy.jobs['pipeline-production'].steps.map(step => step.name)
  for (const name of PROMOTION_STEPS) assert.ok(names.includes(name), name)
  const smoke = yaml.load(readFileSync(new URL('../../.github/workflows/production-smoke.yml', import.meta.url), 'utf8'))
  assert.equal(smoke.jobs['production-promotion'].steps.at(-1).run, 'node scripts/release/production-promotion.mjs')
})
