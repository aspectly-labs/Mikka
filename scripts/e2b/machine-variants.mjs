import { readFileSync } from 'node:fs'

const sizes = JSON.parse(readFileSync(new URL('./machine-sizes.json', import.meta.url)))
const kinds = ['desktop','claude','codex']

/** Unversioned reports remain usable for rollback, without asserting a billable hardware tier. */
export function releaseTemplateRows(report) {
  const entries = kinds.map(kind => ({kind, suffix:kind, row:report?.templates?.[kind]}))
  if (report?.machineVariants === undefined) return entries
  if (!Array.isArray(report.machineVariants) || report.machineVariants.length > 6) throw Error('runtime_report_variants_invalid')
  for (const row of report.machineVariants) {
    const kind = row?.baseTemplate, size = row?.machineSize
    if (!['claude','codex'].includes(kind) || !['small','large','ultra'].includes(size)) throw Error('runtime_report_variant_invalid')
    entries.push({kind,suffix:kind+'-'+size,row})
  }
  const seen = new Set()
  for (const {kind,suffix,row} of entries) {
    const expected = sizes[row?.machineSize]
    if (!expected || seen.has(suffix) || row.baseTemplate !== kind || (suffix === kind) !== (row.machineSize === 'medium')
        || row.cpuCount !== expected.cpuCount || row.memoryMB !== expected.memoryMB) throw Error('runtime_report_variant_hardware_invalid')
    seen.add(suffix)
  }
  if (!seen.has('claude-small') || !seen.has('codex-small')) throw Error('runtime_report_default_variants_missing')
  return entries
}
