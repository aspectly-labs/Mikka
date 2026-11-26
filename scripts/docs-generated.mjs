import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'

export const GENERATED_RE = /<!-- generated:([a-z0-9-]+) -->\n[\s\S]*?<!-- \/generated:\1 -->/g

function read(path) { return readFileSync(path, 'utf8') }

export function hostedModels() {
  const config = yaml.load(read('deploy/litellm/config.yaml'))
  const rows = config.model_list
    .filter(row => row.model_name?.startsWith('mikka-') && !row.model_name.includes('*'))
    .map(row => `| \`${row.model_name}\` | \`${row.litellm_params.model}\` |`)
  return ['Source: `deploy/litellm/config.yaml`.', '', '| Alias | Upstream model |', '| --- | --- |', ...rows].join('\n')
}

export function featureFlags() {
  const source = read('lib/feature-flags.ts')
  const body = /export const gatedFeatures = \{([\s\S]*?)\n\} as const/.exec(source)?.[1] ?? ''
  const rows = [...body.matchAll(/^\s{2}(\w+): \{ key: '([^']+)'(?:, waitsOn: (\d+))? \}/gm)]
    .map(([, name, key, issue]) => `| \`${name}\` | \`${key}\` | ${issue ? `[#${issue}](https://github.com/aspectly-labs/Mikka/issues/${issue})` : '—'} |`)
  const defaultsBody = /export const PRODUCTION_FLAG_DEFAULTS[\s\S]*?= \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
  const literalDefaults = [...defaultsBody.matchAll(/^\s{2}'([^']+)': (true|false),/gm)]
  const upcomingBody = /export const upcomingFeatures = \{([\s\S]*?)\n\} satisfies/.exec(source)?.[1] ?? ''
  const spreadDefaults = [...upcomingBody.matchAll(/^\s{2}\w+: \{ key: '([^']+)'/gm)]
    .filter(match => !literalDefaults.some(([, literal]) => literal === match[1]))
    .map(match => [match[0], match[1], 'false'])
  const defaults = [...literalDefaults, ...spreadDefaults]
    .map(([, key, value]) => `| \`${key}\` | \`${value}\` |`)
  return [
    'Source: `lib/feature-flags.ts`.', '',
    '| Gated feature | PostHog key | waitsOn |', '| --- | --- | --- |', ...rows, '',
    '| Production default key | Default when PostHog is absent |', '| --- | --- |', ...defaults,
  ].join('\n')
}

export function machineSizes() {
  const source = read('lib/cloud-computer/machine-pricing.ts')
  const microPerGibHour = Number((/MICRO_USD_PER_GIB_HOUR = ([0-9_]+)/.exec(source)?.[1] ?? '25000').replace(/_/g, ''))
  const usdPerGibHour = microPerGibHour / 1_000_000
  const rows = [...source.matchAll(/^\s{2}'([^']+)': \{ vcpu: ([0-9.]+), gib: ([0-9.]+) \},$/gm)]
    .map(([, id, vcpu, gib]) => {
      const hourly = Number(gib) * usdPerGibHour
      return `| \`${id}\` | ${vcpu} | ${gib} | $${hourly.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} |`
    })
  const defaultSize = /DEFAULT_MACHINE_SIZE: MachineSize = '([^']+)'/.exec(source)?.[1] ?? 'unknown'
  return [
    `Source: \`lib/cloud-computer/machine-pricing.ts\`. List price is USD ${usdPerGibHour} per GiB-hour.`,
    '',
    `Default size: \`${defaultSize}\`.`,
    '',
    '| Size | vCPU | GiB | USD/hour |',
    '| --- | ---: | ---: | ---: |',
    ...rows,
  ].join('\n')
}

export function settingsSections() {
  const source = read('lib/settings-sections.ts')
  const rows = [...source.matchAll(/\{ id: '([^']+)', group: '([^']+)', title: '([^']+)'/g)]
    .map(([, id, group, title]) => `| \`${group}\` | \`${id}\` | ${title} |`)
  return ['Source: `SETTINGS_SECTIONS` in `lib/settings-sections.ts`.', '', '| Group | Section id | Title |', '| --- | --- | --- |', ...rows].join('\n')
}

export function generatedContent(name) {
  if (name === 'hosted-models') return hostedModels()
  if (name === 'feature-flags') return featureFlags()
  if (name === 'settings-sections') return settingsSections()
  if (name === 'machine-sizes') return machineSizes()
  throw new Error(`unknown generated block: ${name}`)
}

export function renderGenerated(text) {
  return text.replace(GENERATED_RE, (all, name) => `<!-- generated:${name} -->\n${generatedContent(name)}\n<!-- /generated:${name} -->`)
}
