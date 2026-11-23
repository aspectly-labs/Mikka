import type { CodeReviewConfiguration } from './settings-contract'

/**
 * How much of the request the ignore globs may take. A saved list of 100 long globs would
 * otherwise push the review request past the 10,000 characters dispatchTaskIntent accepts and
 * stop the review from being created at all; the globs that do not fit are named as a count.
 */
const IGNORED_PATHS_BUDGET = 4000

function ignoredPaths(paths: string[], budget: number): string {
  for (let count = paths.length; count >= 0; count--) {
    const omitted = paths.length - count
    const text = `${JSON.stringify(paths.slice(0, count))}${omitted ? ` and ${omitted} further saved globs not listed here` : ''}`
    if (text.length <= budget) return text
  }
  return ''
}

/** These preferences shape findings, never waive task criteria, security checks or missing evidence. */
export function codeReviewInstructions(config: CodeReviewConfiguration, surface: 'task' | 'factory' = 'task', budget = Infinity) {
  const lines = [
    'Workspace code review preferences:',
    `Report findings at severity ${config.severity} or higher (low < medium < high < critical). Required task acceptance criteria and security/tenant/data-integrity findings still apply at every threshold.`,
    config.output === 'summary'
      ? 'Return one review summary with evidence and unverified observations. Do not post inline comments or GitHub review comments.'
      : 'Return concrete findings with repository path, line, severity and evidence; group repeated findings. When the task explicitly authorizes GitHub comments, post only these findings through the existing authorized GitHub capability, never approve or merge.',
  ]
  const prefix = 'Ignore paths matching these repository-relative globs for optional line-by-line commentary: '
  const suffix = '. Do not omit a required acceptance criterion or a demonstrated security defect because of a glob.'
  const required = lines.join('\n')
  if (required.length > budget) return ''
  const available = budget - required.length - prefix.length - suffix.length - 1
  const paths = ignoredPaths(config.ignoredPaths, surface === 'factory' ? available : Math.min(available, IGNORED_PATHS_BUDGET))
  return paths ? [lines[0], lines[1], prefix + paths + suffix, lines[2]].join('\n') : required
}

export function factoryReviewPreferences(config: CodeReviewConfiguration, prompt: string) {
  const preferences = codeReviewInstructions(config, 'factory', 100_000 - prompt.length - 2)
  return preferences ? '\n\n' + preferences : ''
}
