import machineSizes from '../../scripts/e2b/machine-sizes.json'

// Measured image catalogues are synthetic at the E2B boundary in DB fixtures.
export function templateModelsFixture(models: string[] = ['gpt-5'], { hostedSizes = false } = {}) {
  const names = ['MIKKA_CLOUD_TEMPLATE_MODELS','MIKKA_CLOUD_WORKER_SHA','E2B_BYO_COMPUTER_TEMPLATE','E2B_CLAUDE_TEMPLATE','E2B_CODEX_TEMPLATE']
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  const sha = 'f'.repeat(40)
  const report = (harness: string) => ({ harness, installed: true, version: null, models })
  const templates = {
    desktop: { templateId: 'desktop', models: [report('claude_code'), report('codex')] },
    claude: { templateId: 'claude', models: [report('claude_code')] }, codex: { templateId: 'codex', models: [report('codex')] },
  }
  const machineVariants = hostedSizes ? Object.entries(templates).map(([kind, template]) => ({
    kind, size: 'medium', templateId: template.templateId, cpuCount: machineSizes.medium.cpuCount, memoryMB: machineSizes.medium.memoryMB,
  })) : undefined
  Object.assign(process.env, { MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify({ version: 1, workerSha: sha, templates, machineVariants }), MIKKA_CLOUD_WORKER_SHA: sha,
    E2B_BYO_COMPUTER_TEMPLATE: templates.desktop.templateId, E2B_CLAUDE_TEMPLATE: templates.claude.templateId, E2B_CODEX_TEMPLATE: templates.codex.templateId })
  return { sha, restore() { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] } } }
}
