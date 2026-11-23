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
export const MICRO_USD_PER_GIB_HOUR = 25_000
/** Machine time is prepaid in chunks while the machine is awake, and renewed just before each chunk ends. */
export const MACHINE_CHUNK_MS = 5 * 60_000
export const MACHINE_RENEW_BEFORE_MS = 60_000
/** The machine's lease runs this far past the paid time, so a late renewal wake catches up instead of ending the thread (Alex, 2026-11-15: a little extra charge is fine). */
export const MACHINE_GRACE_MS = 10 * 60_000

export const machineHourlyMicroUsd = (size: MachineSize) => MACHINE_SIZES[size].gib * MICRO_USD_PER_GIB_HOUR
export const machineChunkMicroUsd = (size: MachineSize) => Math.ceil(machineHourlyMicroUsd(size) * MACHINE_CHUNK_MS / 3_600_000)
/** USD per hour, e.g. 0.2 for standard-3. */
export const machineHourlyUsd = (size: MachineSize) => machineHourlyMicroUsd(size) / 1_000_000
export const isMachineSize = (value: unknown): value is MachineSize => typeof value === 'string' && Object.hasOwn(MACHINE_SIZES, value)
