import type { CodeReviewConfiguration } from './settings-contract'

/**
 * How much of the request the ignore globs may take. A saved list of 100 long globs would
 * otherwise push the review request past the 10,000 characters dispatchTaskIntent accepts and
 * stop the review from being created at all; the globs that do not fit are named as a count.
 */
const IGNORED_PATHS_BUDGET = 4000

function ignoredPaths(paths: string[]): string {
  const kept: string[] = []
  let used = 0
  for (const path of paths) {
    used += path.length + 4
    if (used > IGNORED_PATHS_BUDGET) break
    kept.push(path)
  }
  const omitted = paths.length - kept.length
  return `${JSON.stringify(kept)}${omitted ? ` and ${omitted} further saved globs not listed here` : ''}`
}

/** These preferences shape findings, never waive task criteria, security checks or missing evidence. */
export function codeReviewInstructions(config: CodeReviewConfiguration) {
  return [
    'Workspace code review preferences:',
    `Report findings at severity ${config.severity} or higher (low < medium < high < critical). Required task acceptance criteria and security/tenant/data-integrity findings still apply at every threshold.`,
    `Ignore paths matching these repository-relative globs for optional line-by-line commentary: ${ignoredPaths(config.ignoredPaths)}. Do not omit a required acceptance criterion or a demonstrated security defect because of a glob.`,
    config.output === 'summary'
      ? 'Return one review summary with evidence and unverified observations. Do not post inline comments or GitHub review comments.'
      : 'Return concrete findings with repository path, line, severity and evidence; group repeated findings. When the task explicitly authorizes GitHub comments, post only these findings through the existing authorized GitHub capability, never approve or merge.',
  ].join('\n')
}
