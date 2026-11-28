import { isCloudEdition } from '@/lib/edition'
import { runtimeEnv } from '@/lib/env/server'

export function githubAppSlug(env: Readonly<Record<string, string | undefined>> = runtimeEnv()): string | null {
  const slug = env.GITHUB_APP_SLUG?.trim() || (isCloudEdition(env) ? 'mikka-github' : '')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)) return null
  return slug
}

export function githubAppInstallUrlFromSlug(slug: string | null): string | null {
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)) return null
  return `https://github.com/apps/${slug}/installations/new`
}

export function githubAppInstallUrl(env: Readonly<Record<string, string | undefined>> = runtimeEnv()): string | null {
  return githubAppInstallUrlFromSlug(githubAppSlug(env))
}
