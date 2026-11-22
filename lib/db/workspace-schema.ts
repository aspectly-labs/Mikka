import type { AuditRow } from '@/lib/audit/events'
import type { EnvironmentConfiguration } from '@/lib/project-resources/contracts'
import { pgTable, text, timestamp, uuid, varchar, primaryKey, unique, index, jsonb, integer } from 'drizzle-orm/pg-core'

export const workspaces = pgTable('mikka_workspaces', {
  id: uuid('id').primaryKey(),
  userId: text('userId').notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  slug: varchar('slug', { length: 64 }).unique('mikka_workspaces_slug_unique'),
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
