import { boolean, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const workspaceReviewRules = pgTable('workspace_review_rules', {
  workspaceId: uuid('workspaceId').notNull(),
  repoKey: text('repoKey').notNull().default(''),
  requirePullRequest: boolean('requirePullRequest').notNull().default(true),
  requireCi: boolean('requireCi').notNull().default(true),
  checkHarness: text('checkHarness'),
  branchTemplate: text('branchTemplate').notNull().default('mikka/{team}-{number}'),
  prBodyTemplate: text('prBodyTemplate'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.workspaceId, table.repoKey] })])
