// Settings › 个人访问令牌. Mirrors drizzle/20261030204834_personal_access_tokens.sql
// and drizzle/20261111080200_api_tokens.sql (MIKKA_DATABASE_URL).
import { sql } from 'drizzle-orm'
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './schema'

export const personalAccessTokens = pgTable('personal_access_tokens', {
  id: uuid('id').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** mikka_workspaces.id in the workspace database; no FK across databases. */
  workspaceId: uuid('workspaceId').notNull(),
  name: text('name').notNull(),
  /** sha256 hex of the token. The plaintext is never stored. */
  tokenHash: text('tokenHash').notNull(),
  /** Last 4 characters, for telling tokens apart. */
  hint: text('hint').notNull(),
  /** Public `/api/v1` scopes, or the single internal `legacy:full` scope for a pre-M4 token. */
  scopes: text('scopes').array().notNull().default(sql`ARRAY['tasks:read','tasks:write','runs:read','runs:write']::text[]`),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }),
  lastUsedAt: timestamp('lastUsedAt', { withTimezone: true }),
  revokedAt: timestamp('revokedAt', { withTimezone: true }),
  /** The last in-place rotation; the previous secret stopped working then. */
  rotatedAt: timestamp('rotatedAt', { withTimezone: true }),
}, table => [
  uniqueIndex('personal_access_tokens_hash_key').on(table.tokenHash),
  index('personal_access_tokens_owner_idx').on(table.userId, table.workspaceId, table.createdAt.desc()).where(sql`${table.revokedAt} is null`),
])

/**
 * iOS refresh credentials (lib/auth-mobile-refresh.ts). Mirrors
 * drizzle/20261124035101_mobile_refresh_tokens.sql (MIKKA_DATABASE_URL), whose
 * triggers revoke a family when its live access session is deleted and keep a
 * minted access session from sliding.
 */
export const mobileRefreshTokens = pgTable('mobile_refresh_tokens', {
  id: uuid('id').primaryKey(),
  /** One sign-in on one phone; every rotation stays in it. */
  familyId: uuid('family_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** The access session this token currently backs; null once used or revoked. No FK (see the migration). */
  sessionId: text('session_id'),
  /** sessionId was minted by rotation: short-lived and never slid. */
  sessionMinted: boolean('session_minted').notNull().default(false),
  /** sha256 hex of the token. The plaintext is never stored. */
  tokenHash: text('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  familyExpiresAt: timestamp('family_expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  replacedBy: uuid('replaced_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason').$type<'reused' | 'session_ended' | 'signed_out' | 'superseded' | 'replaced'>(),
  userAgent: text('user_agent'),
  twoFactorVerifiedAt: timestamp('two_factor_verified_at', { withTimezone: true }),
  twoFactorMethod: text('two_factor_method'),
}, table => [
  uniqueIndex('mobile_refresh_tokens_hash_key').on(table.tokenHash),
  index('mobile_refresh_tokens_family_idx').on(table.familyId),
  index('mobile_refresh_tokens_session_idx').on(table.sessionId).where(sql`${table.sessionId} is not null`),
  index('mobile_refresh_tokens_user_idx').on(table.userId).where(sql`${table.revokedAt} is null`),
])
