export const THREAD_COST_GROUPINGS = ['thread', 'model', 'machine'] as const
export type ThreadCostGrouping = (typeof THREAD_COST_GROUPINGS)[number]
