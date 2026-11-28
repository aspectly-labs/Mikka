/**
 * What may be logged about a failed audit write: the error class, the Postgres
 * SQLSTATE and the constraint name. Never error.message: drizzle's
 * DrizzleQueryError message is "Failed query: … params: …" and would leak
 * metadata, labels and ip. This summary has no database initialization.
 */
export function auditFailureSummary(error: unknown): { name: string; code: string | null; constraint: string | null } {
  const raw = error instanceof Error ? (error.name !== 'Error' ? error.name : error.constructor?.name || error.name) : typeof error
  const name = /^[A-Za-z0-9_$]{1,63}$/.test(raw) ? raw : 'Error'
  const cause = (error as { cause?: unknown } | null)?.cause ?? error
  const pick = (key: 'code' | 'constraint') => {
    const value = (cause as Record<string, unknown> | null)?.[key]
    return typeof value === 'string' && /^[A-Za-z0-9_]{1,63}$/.test(value) ? value : null
  }
  return { name, code: pick('code'), constraint: pick('constraint') }
}
