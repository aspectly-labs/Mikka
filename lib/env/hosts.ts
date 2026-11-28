/**
 * T2 — Typed internal, loopback, and service host/origin boundary.
 *
 * Centralizes every loopback address (`127.0.0.1`, `localhost`, `[::1]`),
 * local development default origin, and internal service origin
 * (`https://product.internal`) so G5 (`no-hardcoded-hosts`) holds at `0`
 * everywhere outside `lib/env/**`, fixtures, and tests.
 */
import { z } from 'zod'
import { runtimeEnv, type EnvMap } from './runtime.mjs'
import {
  CLAUDE_DESKTOP_CALLBACK_URL,
  DEFAULT_LOCAL_APP_ORIGIN,
  DEFAULT_LOCAL_DEV_ORIGIN,
  DEFAULT_LOCAL_EVE_ORIGIN,
  DEFAULT_LOCAL_SYNTHETIC_ORIGIN,
  GITHUB_REDELIVERY_HOSTNAME,
  GITHUB_REDELIVERY_ORIGIN,
  INTERNAL_PRODUCT_HOSTNAME,
  INTERNAL_PRODUCT_ORIGIN,
  LOCALHOST_HOSTNAME,
  LOOPBACK_HOSTS,
  LOOPBACK_IPV4,
  LOOPBACK_IPV6,
  LOOPBACK_IPV6_BRACKETED,
  SANDBOX_RUNTIME_VERSION_URL,
  SANDBOX_VNC_PROBE_URL,
  loopbackUrl,
} from './hosts-constants.mjs'

export {
  CLAUDE_DESKTOP_CALLBACK_URL,
  DEFAULT_LOCAL_APP_ORIGIN,
  DEFAULT_LOCAL_DEV_ORIGIN,
  DEFAULT_LOCAL_EVE_ORIGIN,
  DEFAULT_LOCAL_SYNTHETIC_ORIGIN,
  GITHUB_REDELIVERY_HOSTNAME,
  GITHUB_REDELIVERY_ORIGIN,
  INTERNAL_PRODUCT_HOSTNAME,
  INTERNAL_PRODUCT_ORIGIN,
  LOCALHOST_HOSTNAME,
  LOOPBACK_HOSTS,
  LOOPBACK_IPV4,
  LOOPBACK_IPV6,
  LOOPBACK_IPV6_BRACKETED,
  SANDBOX_RUNTIME_VERSION_URL,
  SANDBOX_VNC_PROBE_URL,
  loopbackUrl,
}

const LOOPBACK_HOST_SET: ReadonlySet<string> = new Set<string>(LOOPBACK_HOSTS)

const httpOriginSchema = z.url().refine(value => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}, 'must be a valid http(s) origin URL')

const LOCALHOST_SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.localhost$/
const MAX_HOSTNAME_LENGTH = 253

/** True when `hostname` is an IPv4/IPv6 loopback host or `localhost` (optionally `*.localhost`). */
export function isLoopbackHost(hostname: string, options: { allowSubdomain?: boolean } = {}): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (LOOPBACK_HOST_SET.has(normalized)) return true
  if (
    options.allowSubdomain
    && normalized.length <= MAX_HOSTNAME_LENGTH
    && LOCALHOST_SUBDOMAIN_PATTERN.test(normalized)
  ) {
    return true
  }
  return false
}

/** True when `origin` is `http://<loopback>[:port]` (never arbitrary hosts). */
export function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'http:'
      && (url.hostname === LOCALHOST_HOSTNAME || url.hostname === LOOPBACK_IPV4 || url.hostname === LOOPBACK_IPV6_BRACKETED || url.hostname === LOOPBACK_IPV6)
      && url.origin === origin
  } catch {
    return false
  }
}

/** Normalizes any valid http(s) URL string to its `.origin` after Zod validation. */
export function parseHttpOrigin(raw: string): string {
  return new URL(httpOriginSchema.parse(raw)).origin
}

/** Resolves the local app origin (`MIKKA_APP_ORIGIN` → `BETTER_AUTH_URL` → `http://127.0.0.1:3000`). */
export function resolveLocalAppOrigin(env: EnvMap = runtimeEnv()): string {
  const configured = env.MIKKA_APP_ORIGIN?.trim() || env.BETTER_AUTH_URL?.trim()
  return configured ? parseHttpOrigin(configured) : DEFAULT_LOCAL_APP_ORIGIN
}

/** Resolves the development auth origin (`BETTER_AUTH_URL` → `MIKKA_APP_ORIGIN` → `http://localhost:3000`). */
export function resolveLocalDevOrigin(env: EnvMap = runtimeEnv()): string {
  const configured = env.BETTER_AUTH_URL?.trim() || env.MIKKA_APP_ORIGIN?.trim()
  return configured ? parseHttpOrigin(configured) : DEFAULT_LOCAL_DEV_ORIGIN
}

/** Resolves the internal product RPC origin (hosted Workers service binding vs local HTTP). */
export function resolveInternalProductOrigin(hosted: boolean, env: EnvMap = runtimeEnv()): string {
  if (hosted) return INTERNAL_PRODUCT_ORIGIN
  return env.MIKKA_APP_ORIGIN?.trim() || env.BETTER_AUTH_URL?.trim() || DEFAULT_LOCAL_APP_ORIGIN
}

/** Resolves the Eve service proxy origin (`MIKKA_EVE_ORIGIN` → `http://127.0.0.1:3002`). */
export function resolveEveProxyOrigin(env: EnvMap = runtimeEnv()): string {
  return env.MIKKA_EVE_ORIGIN?.trim() || DEFAULT_LOCAL_EVE_ORIGIN
}

/** Resolves the Eve agent endpoint URL (`MIKKA_EVE_ORIGIN` → `<appOrigin>/mikka/api/agents`). */
export function resolveEveServerEndpoint(env: EnvMap = runtimeEnv()): string {
  const explicit = env.MIKKA_EVE_ORIGIN?.trim()
  if (explicit) return explicit
  return new URL('/mikka/api/agents', env.BETTER_AUTH_URL?.trim() || DEFAULT_LOCAL_APP_ORIGIN).toString()
}

/** Builds a synthetic loopback `Request` for internal token verification outside an HTTP server. */
export function syntheticLocalRequest(path = '/'): Request {
  return new Request(new URL(path, DEFAULT_LOCAL_SYNTHETIC_ORIGIN))
}

export type HttpTracePeer = 'github' | 'composio' | 'eve' | 'cloud' | 'litellm' | 'other'

/** Closed telemetry labels only; operator/private hosts never leave this boundary. */
export function httpTracePeer(rawOrigin: string | URL, env: EnvMap = runtimeEnv()): HttpTracePeer {
  try {
    const origin = new URL(rawOrigin).origin
    if (origin === 'https://api.github.com') return 'github'
    if (origin === 'https://backend.composio.dev') return 'composio'
    const configured: readonly [HttpTracePeer, string | undefined][] = [
      ['eve', resolveEveProxyOrigin(env)], ['cloud', env.MIKKA_CLOUD_URL], ['litellm', env.MIKKA_LITELLM_URL],
    ]
    for (const [peer, value] of configured) {
      if (!value) continue
      try { if (new URL(value).origin === origin) return peer } catch { /* invalid configuration is not a telemetry label */ }
    }
  } catch { /* an unfamiliar transport origin remains private */ }
  return 'other'
}
