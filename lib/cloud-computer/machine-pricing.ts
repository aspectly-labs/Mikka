import e2bSizes from '../../scripts/e2b/machine-sizes.json'

/**
 * Cloudflare task machines are priced by memory, as Capy prices its machines
 * (decision 2026-11-15-1900): USD 0.025 per GiB-hour of the instance type, at
 * list price from Mikka 额度. Pure, so the machine picker can show the price.
 */
export const MACHINE_SIZES = {
  'standard-1': { vcpu: 0.5, gib: 4 },
  'standard-2': { vcpu: 1, gib: 6 },
  'standard-3': { vcpu: 2, gib: 8 },
  'standard-4': { vcpu: 4, gib: 12 },
  'standard-4-16': { vcpu: 4, gib: 16 },
} as const
export type MachineSize = keyof typeof MACHINE_SIZES
export type E2BMachineSize = keyof typeof e2bSizes
export type MachineProvider = 'cloudflare' | 'e2b'
export type MachineSku = { provider: 'cloudflare'; size: MachineSize } | { provider: 'e2b'; size: E2BMachineSize }
export type MachineGeometry = { vcpu: number; ramGib: number }
/** Machine time is prepaid in chunks while the machine is awake. */
export const MACHINE_CHUNK_MS = 5 * 60_000
export const MACHINE_LIST_PRICE_VERSION = '2026-11-26'
export const MACHINE_LIST_PRICE_START = '2026-11-26T00:00:00.000Z'
type MachinePriceTerm = { version: string; effectiveFrom: string; effectiveUntil: string | null; minimumPrepaidSeconds: number }
export type MachineListPrice = MachinePriceTerm & (
  | { basis: 'provisioned_hour'; hourlyMicroUsd: number }
  | { basis: 'active_cpu'; fixedHourlyMicroUsd: number; activeVcpuHourlyMicroUsd: number }
)
const machinePriceTerm: MachinePriceTerm = {
  version: MACHINE_LIST_PRICE_VERSION, effectiveFrom: MACHINE_LIST_PRICE_START, effectiveUntil: null, minimumPrepaidSeconds: MACHINE_CHUNK_MS / 1_000,
}
export function machinePriceIsEffective(term: Pick<MachinePriceTerm, 'effectiveFrom' | 'effectiveUntil'>, asOf: number) {
  return Number.isFinite(asOf) && asOf >= Date.parse(term.effectiveFrom) &&
    (term.effectiveUntil === null || asOf < Date.parse(term.effectiveUntil))
}

// https://developers.cloudflare.com/containers/platform/pricing/
// Memory and disk are provisioned; CPU is metered only while actively used.
const cloudflareDiskGb: Partial<Record<MachineSize, number>> = { 'standard-1': 8, 'standard-2': 12, 'standard-3': 16, 'standard-4': 20 }
const cloudflareActiveVcpuHourlyMicroUsd = 72_000
export const machineSkuGeometry = (sku: MachineSku): MachineGeometry => sku.provider === 'cloudflare'
  ? { vcpu: MACHINE_SIZES[sku.size].vcpu, ramGib: MACHINE_SIZES[sku.size].gib }
  : { vcpu: e2bSizes[sku.size].cpuCount, ramGib: e2bSizes[sku.size].memoryMB / 1_024 }

export function machineSkuListPrice(sku: MachineSku, asOf = Date.now()): MachineListPrice | null {
  if (!machinePriceIsEffective(machinePriceTerm, asOf)) return null
  // https://e2b.dev/pricing: $0.000014/vCPU-second + $0.0000045/GiB-second.
  if (sku.provider === 'e2b') return { ...machinePriceTerm, basis: 'provisioned_hour', hourlyMicroUsd: e2bSizes[sku.size].hourlyMicroUsd }
  const diskGb = cloudflareDiskGb[sku.size]
  if (diskGb === undefined) return null // custom, quota-gated SKU has no public disk specification
  return { ...machinePriceTerm, basis: 'active_cpu', fixedHourlyMicroUsd: MACHINE_SIZES[sku.size].gib * 9_000 + diskGb * 252,
    activeVcpuHourlyMicroUsd: cloudflareActiveVcpuHourlyMicroUsd }
}

export function parseMachineSku(provider: unknown, size: unknown): MachineSku | null {
  if (provider === 'cloudflare' && isMachineSize(size)) return { provider, size }
  if (provider === 'e2b' && typeof size === 'string' && Object.hasOwn(e2bSizes, size)) return { provider, size: size as E2BMachineSize }
  return null
}

export const machineLedgerLabel = (sku: MachineSku) => `machine/${sku.provider}-${sku.size}`

export function parseMachineLedgerLabel(label: string): { provider: MachineProvider; size: string } | null {
  const match = /^machine\/(cloudflare|e2b)-(.+)$/.exec(label)
  return match ? { provider: match[1] as MachineProvider, size: match[2] } : null
}

/** The size every new task machine gets (decision 2026-11-15-1900). */
export const DEFAULT_MACHINE_SIZE: MachineSize = 'standard-3'
/**
 * Sizes over the provider's default account limit (4 vCPU / 12 GiB / 20 GB,
 * epic #3076). They stay in the catalogue so stored Environment and Automation
 * choices still parse and price, but a cloud run must never be billed or
 * started at one until operations records verified provider quota (#3080):
 * the default ceiling cannot start them and showing them as usable is a false
 * promise.
 */
export const QUOTA_GATED_SIZES: ReadonlySet<MachineSize> = new Set<MachineSize>(['standard-4-16'])
/** The largest size inside the provider's default account limit. */
export const LARGEST_DEFAULT_QUOTA_SIZE: MachineSize = 'standard-4'

export type ProvisionedMachineSize = {
  /** The size the run or its Environment asked for, kept for the record. */
  readonly requested: MachineSize
  /** The size allowed to start and be billed. */
  readonly size: MachineSize
  /** Why `size` is not `requested`; recorded in the machine lifecycle. */
  readonly adjusted: 'provider_quota_unverified' | null
}

/**
 * Resolves a requested size to what a task machine may actually start and be
 * billed at. Quota-gated sizes map down to the largest default-quota size with
 * a recorded reason until the operator's verified-quota proof enables them;
 * every other size passes through.
 */
export const provisionableMachineSize = (requested: MachineSize, verifiedQuota: boolean): ProvisionedMachineSize =>
  QUOTA_GATED_SIZES.has(requested) && !verifiedQuota
    ? { requested, size: LARGEST_DEFAULT_QUOTA_SIZE, adjusted: 'provider_quota_unverified' }
    : { requested, size: requested, adjusted: null }
export const CLOUDFLARE_LEGACY_PRICE_VERSION = 'cloudflare-legacy-memory-2026-11-15'
export const MICRO_USD_PER_GIB_HOUR = 25_000
export const MACHINE_RENEW_BEFORE_MS = 60_000
/** The machine's lease runs this far past the paid time, so a late renewal wake catches up instead of ending the thread (Alex, 2026-11-15: a little extra charge is fine). */
export const MACHINE_GRACE_MS = 10 * 60_000

export const machineHourlyMicroUsd = (size: MachineSize) => MACHINE_SIZES[size].gib * MICRO_USD_PER_GIB_HOUR
const MILLIS_PER_HOUR = 3_600_000n
function integerHourCost(units: bigint) {
  const result = Number((units + MILLIS_PER_HOUR - 1n) / MILLIS_PER_HOUR)
  if (!Number.isSafeInteger(result)) throw new RangeError('Machine charge exceeds integer precision')
  return result
}

/** A floor on authorised time, independent of when the provider starts billing. */
export const prepaidMachineMicroUsd = (hourlyMicroUsd: number) => integerHourCost(BigInt(hourlyMicroUsd) * BigInt(MACHINE_CHUNK_MS))

/** Cloudflare has no fixed instance-hour amount without measured active CPU.
 * E2B supplies a fixed rate per provisioned second. Times are integer ms. */
export function machineListUsageMicroUsd(price: MachineListPrice, provisionedMs: number, activeVcpuMs?: number): number | null {
  if (!Number.isSafeInteger(provisionedMs) || provisionedMs < 0) return null
  if (price.basis === 'provisioned_hour') return integerHourCost(BigInt(price.hourlyMicroUsd) * BigInt(provisionedMs))
  if (activeVcpuMs === undefined || !Number.isSafeInteger(activeVcpuMs) || activeVcpuMs < 0) return null
  return integerHourCost(BigInt(price.fixedHourlyMicroUsd) * BigInt(provisionedMs) +
    BigInt(price.activeVcpuHourlyMicroUsd) * BigInt(activeVcpuMs))
}

export const machineChunkMicroUsd = (size: MachineSize) => prepaidMachineMicroUsd(machineHourlyMicroUsd(size))
/** USD per hour, e.g. 0.2 for standard-3. */
export const machineHourlyUsd = (size: MachineSize) => machineHourlyMicroUsd(size) / 1_000_000
export const isMachineSize = (value: unknown): value is MachineSize => typeof value === 'string' && Object.hasOwn(MACHINE_SIZES, value)

export interface MachineSizeOption {
  readonly id: MachineSize
  readonly vcpu: number
  readonly ramGib: number
  readonly hourlyUsd: number
  readonly isDefault: boolean
}

/**
 * Provisionable cloud machine tiers safe for customer-facing selectors.
 * Strictly excludes `QUOTA_GATED_SIZES` so the UI never offers tiers that
 * would silently downgrade under the provider's default account ceiling.
 */
export const SELECTABLE_MACHINE_SIZES: readonly MachineSize[] = (
  Object.keys(MACHINE_SIZES) as MachineSize[]
).filter(size => !QUOTA_GATED_SIZES.has(size))

/** Structured metadata (vCPU, GiB, USD/hr) for optional collapsed Advanced compute pickers. */
export const selectableMachineSizeOptions = (): readonly MachineSizeOption[] =>
  SELECTABLE_MACHINE_SIZES.map(id => ({
    id,
    vcpu: MACHINE_SIZES[id].vcpu,
    ramGib: MACHINE_SIZES[id].gib,
    hourlyUsd: machineHourlyUsd(id),
    isDefault: id === DEFAULT_MACHINE_SIZE,
  }))
