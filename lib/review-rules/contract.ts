import { z } from 'zod'
import { normalizeRepoKey } from '@mikka/protocol/git-remote'
import {
  branchTemplateSchema,
  DEFAULT_BRANCH_TEMPLATE,
  prBodyTemplateSchema,
  REVIEW_CHECK_HARNESSES,
  type ReviewRule,
} from '@mikka/protocol/orchestrator'

const SAFE_REPO_KEY_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+\/[a-z0-9._-]+$/
const hasControlChar = (value: string) =>
  [...value].some(char => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })

/** Normalized repository key (`host/owner/name`) for per-repository review rule overrides (ADR ORV-172). */
export const reviewRuleRepoKeySchema = z
  .string()
  .min(1)
  .max(2_000)
  .transform((raw, ctx) => {
    const trimmed = raw.trim()
    // Reject bare local filesystem paths (`/a/b/c`) that `normalizeRepoKey` might split as 3 segments.
    if (trimmed.startsWith('/') || trimmed.includes('\\') || hasControlChar(trimmed)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid repository key' })
      return z.NEVER
    }
    const normalized = normalizeRepoKey(trimmed)
    if (
      !normalized ||
      normalized.length > 250 ||
      !SAFE_REPO_KEY_RE.test(normalized) ||
      normalized.split('/').some(segment => segment === '.' || segment === '..')
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid repository key' })
      return z.NEVER
    }
    return normalized
  })

/** Strict input schema matching `reviewRuleSchema` (`packages/protocol/src/orchestrator.ts:242`). */
export const reviewRuleInputSchema = z.strictObject({
  requirePullRequest: z.boolean().default(true),
  requireCi: z.boolean().default(true),
  checkHarness: z.enum(REVIEW_CHECK_HARNESSES).nullable().default(null),
  branchTemplate: branchTemplateSchema.default(DEFAULT_BRANCH_TEMPLATE),
  prBodyTemplate: prBodyTemplateSchema.default(null),
})

const optionalScopeRepoKey = z
  .union([z.literal(''), reviewRuleRepoKeySchema])
  .nullable()
  .optional()
  .transform(value => value ?? '')

export const saveWorkspaceReviewRuleInput = z.strictObject({
  repoKey: optionalScopeRepoKey,
  rule: reviewRuleInputSchema,
})

export const deleteWorkspaceReviewRuleInput = z.strictObject({
  repoKey: optionalScopeRepoKey,
})

export interface ResolvedWorkspaceReviewRule {
  value: ReviewRule
  source: 'workspace' | 'default'
  updatedAt: string | null
}

export interface RepositoryReviewRuleOverride {
  repoKey: string
  rule: ReviewRule
  source: 'repository'
  updatedAt: string
}

export interface WorkspaceReviewRulesView {
  workspaceId: string
  rule: ResolvedWorkspaceReviewRule
  overrides: RepositoryReviewRuleOverride[]
}

/** Resolve the effective review rule for an optional repository (`repository` -> `workspace` -> `default`). */
export function resolveEffectiveReviewRule(
  view: WorkspaceReviewRulesView,
  repositoryUrlOrKey?: string | null,
): { value: ReviewRule; source: 'repository' | 'workspace' | 'default' } {
  const normalized = repositoryUrlOrKey ? normalizeRepoKey(repositoryUrlOrKey) : null
  if (normalized) {
    const match = view.overrides.find(override => override.repoKey === normalized)
    if (match) return { value: match.rule, source: 'repository' }
  }
  return { value: view.rule.value, source: view.rule.source }
}
