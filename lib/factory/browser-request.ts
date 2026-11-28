import { withBasePath } from '../base-path'
import { urlFetcher, type KeyedFetcher } from '../swr/fetcher'

export class RequestError extends Error {
  constructor(readonly code: string, readonly status: number, readonly body: Record<string, unknown>) { super(code) }
}

/** Strictly typed GET-only Factory request (never conflates extra arguments with a POST body). */
export async function factoryGet<T>(path: string): Promise<T> {
  const response = await fetch(withBasePath(path), { cache: 'no-store' })
  const value = await response.json().catch(() => ({}))
  if (response.status === 202) return { ...value, deferred: true } as T
  if (!response.ok) throw new RequestError(value.error ?? 'factoryUnavailable', response.status, value)
  return value as T
}

const sharedFactoryGetFetcher = urlFetcher<unknown>(path => factoryGet<unknown>(path))

/** Typed URL SWR fetcher backed by `factoryGet<T>`. */
export function factoryGetFetcher<T>(): KeyedFetcher<string, T> {
  return sharedFactoryGetFetcher as KeyedFetcher<string, T>
}

export async function request(path: string, body?: unknown, headers?: Record<string, string>) {
  const response = await fetch(withBasePath(path), body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => ({}))
  if (response.status === 202) return { ...value, deferred: true }
  if (!response.ok) throw new RequestError(value.error ?? 'factoryUnavailable', response.status, value)
  return value
}
