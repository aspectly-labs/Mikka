import type { AuditRow } from '@/lib/audit/events'
import type { EnvironmentConfiguration, EnvironmentRepository, EnvironmentScope } from '@/lib/project-resources/contracts'
import { pgTable, text, timestamp, uuid, varchar, primaryKey, unique, index, jsonb, integer } from 'drizzle-orm/pg-core'

export const workspaces = pgTable('mikka_workspaces', {
  id: uuid('id').primaryKey(),
  userId: text('userId').notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  slug: varchar('slug', { length: 64 }).unique('mikka_workspaces_slug_unique'),
  /** Four-letter prefix shown for this workspace. Issued task numbers do not change. */
  taskPrefix: varchar('taskPrefix', { length: 4 }),
  /** A small image data URL (≤200 KB decoded); see lib/workspace-admin/icon.ts. */
  icon: text('icon'),
  /** 'personal': the one workspace each person has, with only them as a member (decision 2026-10-31-2130). */
  kind: text('kind').$type<'personal' | 'team'>().notNull().default('team'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

export const workspaceMembers = pgTable('mikka_workspace_members', {
  workspaceId: uuid('workspaceId').notNull(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  role: text('role').$type<'admin' | 'member'>().notNull(),
  status: text('status').$type<'active' | 'suspended'>().notNull().default('active'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.workspaceId, table.userId] }), index('mikka_workspace_members_user_idx').on(table.userId)])

export const workspaceInvitations = pgTable('mikka_workspace_invitations', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspaceId').notNull(),
  userId: text('userId').notNull(),
  email: text('email').notNull(),
  role: text('role').$type<'admin' | 'member'>().notNull(),
  tokenHash: text('tokenHash').notNull().unique(),
  status: text('status').$type<'pending' | 'accepted' | 'revoked'>().notNull().default('pending'),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique().on(table.workspaceId, table.email)])

/** Slugs a workspace used before; /w/<old-slug> redirects to its current slug. */
export const workspaceSlugRedirects = pgTable('mikka_workspace_slug_redirects', {
  slug: varchar('slug', { length: 64 }).primaryKey(),
  workspaceId: uuid('workspaceId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('mikka_workspace_slug_redirects_workspace_idx').on(table.workspaceId)])

/** Durable delivery receipt for the main audit sink, committed with workspace mutations. */
export const workspaceAuditOutbox = pgTable('workspace_audit_outbox', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspaceId').notNull(),
  payload: jsonb('payload').$type<AuditRow>(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull(),
  lastAttemptAt: timestamp('lastAttemptAt', { withTimezone: true }),
  deliveredAt: timestamp('deliveredAt', { withTimezone: true }),
})

/** Reusable execution environment in the Workspace database (DATABASE_URL). */
export const workspaceEnvironments = pgTable('workspace_environments', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspaceId').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  configuration: jsonb('configuration').$type<EnvironmentConfiguration>().notNull(),
  instructions: text('instructions').notNull().default(''),
  defaultMachineSize: text('defaultMachineSize'),
  /** 'personal': only `ownerId` sees and uses it; sharing makes it 'workspace' and keeps the owner (20261125223723). */
  scope: text('scope').$type<EnvironmentScope>().notNull().default('workspace'),
  ownerId: text('ownerId'),
  /** Repository rows, cloned at start or on demand; configuration.repositoryKeys lists the start rows. */
  repositories: jsonb('repositories').$type<EnvironmentRepository[]>().notNull().default([]),
  revision: integer('revision').notNull().default(1),
  archivedAt: timestamp('archivedAt', { withTimezone: true }),
  createdBy: text('createdBy').notNull(),
  updatedBy: text('updatedBy').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique().on(table.id, table.workspaceId),
  index('workspace_environments_workspace_idx').on(table.workspaceId, table.archivedAt),
])

/** A task's 「环境」 property (decision 2026-11-26-0110 rule 4); replaces its Project's default environment. */
export const workspaceTaskEnvironments = pgTable('workspace_task_environments', {
  issueId: uuid('issueId').primaryKey(),
  workspaceId: uuid('workspaceId').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  environmentId: uuid('environmentId').notNull(),
  /** NULL: copied from the task's Project by drizzle/20261125223723. */
  updatedBy: text('updatedBy'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('workspace_task_environments_environment_idx').on(table.workspaceId, table.environmentId)])

/** Original branch-only settings of a migrated task before its first environment selection. */
export const workspaceTaskLegacyRepositoryBranches = pgTable('workspace_task_legacy_repository_branches', {
  workspaceId: uuid('workspaceId').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  issueId: uuid('issueId').notNull(),
  repositoryKey: text('repositoryKey').notNull(),
  baseBranch: text('baseBranch').notNull(),
}, table => [primaryKey({ columns: [table.workspaceId, table.issueId, table.repositoryKey] })])
