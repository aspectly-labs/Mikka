import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { auditSource, auditCss, isComponentLibrarySource, exemptAsShipped, exemptFrameworkShims } from './ui-policy.mjs'
import { asyncPressBaseline, auditActionBindings, auditInteractions } from './interaction-policy.mjs'
import { auditSettingsSurface } from './settings-policy.mjs'
import { auditIconButtons } from './icon-button-policy.mjs'
import { auditBasePath } from './base-path-policy.mjs'
import { auditEntityDetail, auditTaskEntry, resolveEntityFile, verifyEntityContracts } from './entity-ui-policy.mjs'
import { auditSplitPanes } from './split-pane-policy.mjs'
import { auditControlSizes } from './control-size-policy.mjs'
import { auditMotion } from './motion-policy.mjs'
import { auditRepository as auditPollingRepository } from './polling-policy.mjs'
import { auditRepository as auditErrorCauseRepository } from './error-cause-policy.mjs'
import { officialCore, officialCoreFiles, readUi } from './official-ui-tree.mjs'

const policy = JSON.parse(readFileSync('ui-policy.json', 'utf8'))
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0')
const ownFiles = tracked.filter(file => /\.(?:[cm]?[jt]sx?|css)$/.test(file) && !/^(?:apps|packages|scripts|node_modules|\.next|\.vercel|out|build|user_read_only_context|v0_memories|\.claude)\//.test(file) && !file.endsWith('.d.ts') && existsSync(file))
// The interface moved to the official UI checkout's core/ at the same paths (official-ui-tree.mjs); audit it there
// when it is mounted. Its client application (core/renderer) is checked for action bindings below, as the renderer was.
const coreFiles = officialCoreFiles().filter(file => /\.(?:[cm]?[jt]sx?|css)$/.test(file) && !file.endsWith('.d.ts') && !/^(?:renderer|tests)\//.test(file) && !/\.test\.[cm]?[jt]sx?$/.test(file))
const files = [...ownFiles, ...coreFiles]
const diagnostics = verifyEntityContracts(file => {
  const resolved = resolveEntityFile(file)
  if (!resolved) return undefined
  return readFileSync(resolved, 'utf8')
})
// The component registry config (components.json) belongs to the official UI checkout, which installs components.
const configFile = ['components.json', officialCore && join(officialCore, '..', 'components.json')].find(file => file && existsSync(file))
const config = configFile ? JSON.parse(readFileSync(configFile, 'utf8')) : { style: policy.style, iconLibrary: policy.iconLibrary.replace('-react', '') }
if (config.style !== policy.style || config.iconLibrary !== policy.iconLibrary.replace('-react', '')) diagnostics.push({ file: 'components.json', line: 1, column: 1, rule: 'policy/config-drift', message: '组件 base/style/iconLibrary 与 ui-policy.json 不一致；变更预设需同步审核策略。' })
const businessFiles = files.filter(file => !isComponentLibrarySource(file, policy))
for (const file of businessFiles) {
  const text = readUi(file)
  diagnostics.push(...exemptFrameworkShims(file, exemptAsShipped(file, file.endsWith('.css') ? auditCss(file, text, policy) : auditSource(file, text, policy), policy), policy))
  if (!file.endsWith('.css')) diagnostics.push(...auditBasePath(file, text), ...auditEntityDetail(file, text), ...auditTaskEntry(file, text))
  if (/\.[jt]sx$/.test(file)) diagnostics.push(...auditSettingsSurface(file, text), ...auditSplitPanes(file, text), ...auditControlSizes(file, text), ...auditMotion(file, text))
}
for (const file of tracked.filter(file => /^apps\/(?:mobile|desktop)\/.*\.[jt]sx?$/.test(file) && existsSync(file))) {
  diagnostics.push(...auditEntityDetail(file, readFileSync(file, 'utf8')))
}
const clientFiles = [
  ...tracked.filter(file => /^apps\/(?:mobile\/(?:app|components|features|shared|slots)|desktop\/src\/renderer|frontend\/src)\/.*\.[jt]sx$/.test(file) && existsSync(file)),
  ...officialCoreFiles().filter(file => /^renderer\/.*\.[jt]sx$/.test(file)).map(file => `${officialCore}/${file}`),
]
for (const file of clientFiles) diagnostics.push(...auditActionBindings(file, readUi(file)))
const interactionFiles = files.filter(file => /\.[jt]sx$/.test(file) && !['components/ui/', 'components/reui/'].some(root => file.startsWith(root)))
if (Object.keys(asyncPressBaseline).length > 0) {
  diagnostics.push({ file: 'scripts/interaction-busy-baseline.json', line: 1, column: 1, rule: 'interaction/async-press-baseline-locked', message: 'scripts/interaction-busy-baseline.json is permanently locked at 0 entries; pass `busy` on async presses instead.' })
}
for (const file of interactionFiles) {
  const text = readUi(file)
  diagnostics.push(...auditInteractions(file, text), ...auditIconButtons(file, text))
}
// Polling covers web, mobile, daemon and workflows, so it lists its own files; stale allowlist
// entries fail in scripts/polling-policy.test.mjs (docs/design/decisions/2026-11-05-0200-no-new-polling.md).
diagnostics.push(...auditPollingRepository())
// Error causes and copy for user-reachable codes cover web, daemon and workflows too; stale allowlist
// entries fail in scripts/error-cause-policy.test.mjs (docs/design/decisions/2026-11-05-0330-error-causes.md).
diagnostics.push(...auditErrorCauseRepository())
const counts = Object.fromEntries([...new Set(diagnostics.map(d => d.rule))].sort().map(rule => [rule, diagnostics.filter(d => d.rule === rule).length]))
if (process.argv.includes('--json')) console.log(JSON.stringify({ files: businessFiles.length, libraryFiles: files.length - businessFiles.length, interactionFiles: interactionFiles.length, clientInteractionFiles: clientFiles.length, errors: diagnostics.length, counts, diagnostics }, null, 2))
else {
  for (const diagnostic of diagnostics) console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} error [${diagnostic.rule}] ${diagnostic.message}`)
  console.log(`\nUI policy: ${businessFiles.length} business files, ${diagnostics.length} errors; ${files.length - businessFiles.length} component-library files excluded (no source verification).`)
  console.log(`Interaction policy: ${interactionFiles.length} files, including downloaded business blocks; plus ${clientFiles.length} native and renderer files checked for action bindings.`)
  console.log(JSON.stringify(counts, null, 2))
}
process.exitCode = diagnostics.length ? 1 : 0
