-- target: MIKKA_DATABASE_URL
-- iOS refresh credentials (decision 2026-11-24 mobile-refresh-credentials,
-- lib/auth-mobile-refresh.ts). One row per refresh token; a family is one
-- sign-in on one phone. Only sha256(token) is stored. "session_id" is the
-- Better Auth access session the family currently backs (NULL once the row is
-- used or revoked); no FK, so a session's own deletion triggers below can see
-- the row before anything clears it. Used rows stay until the family ends so a
-- replayed token is recognised and revokes its family. Mirrors
-- lib/db/token-schema.ts (mobileRefreshTokens).
-- Additive only: old app builds and the web never read or write this table.
-- Rollback: DROP TRIGGER IF EXISTS mobile_refresh_session_ended ON session;
--   DROP TRIGGER IF EXISTS mobile_refresh_session_no_slide ON session;
--   DROP FUNCTION IF EXISTS mikka_mobile_refresh_session_ended();
--   DROP FUNCTION IF EXISTS mikka_mobile_refresh_session_no_slide();
--   DROP TABLE IF EXISTS mobile_refresh_tokens;
--   DELETE FROM schema_migrations WHERE name = '20261124035101_mobile_refresh_tokens.sql';
CREATE TABLE IF NOT EXISTS mobile_refresh_tokens (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  session_id text,
  -- session_id was minted by rotation: a short access session that never slides.
  session_minted boolean NOT NULL DEFAULT false,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- The family's absolute end; no rotation extends a token past it.
  family_expires_at timestamptz NOT NULL,
  used_at timestamptz,
  replaced_by uuid,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('reused', 'session_ended', 'signed_out', 'superseded', 'replaced')),
  user_agent text,
  -- The sign-in's second-factor assurance, carried to each minted session.
  two_factor_verified_at timestamptz,
  two_factor_method text,
  CONSTRAINT mobile_refresh_tokens_expiry CHECK (expires_at > created_at AND expires_at <= family_expires_at),
  CONSTRAINT mobile_refresh_tokens_revocation CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS mobile_refresh_tokens_hash_key ON mobile_refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS mobile_refresh_tokens_family_idx ON mobile_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS mobile_refresh_tokens_session_idx ON mobile_refresh_tokens (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mobile_refresh_tokens_user_idx ON mobile_refresh_tokens (user_id) WHERE revoked_at IS NULL;
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON mobile_refresh_tokens;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON mobile_refresh_tokens FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('user_id');

-- A live access session that ends (sign-out, a revoke on the web, a password
-- reset, enterprise deprovisioning, any SQL delete) ends the family it backs.
-- Rotation moves session_id to the new session before deleting the old one,
-- so its own delete revokes nothing. An expired session's cleanup is not a
-- sign-out: Better Auth deletes one when its own stale cookie arrives, and
-- lib/auth-mobile-refresh.ts revokes for an expired session only when another
-- request deleted it.
CREATE OR REPLACE FUNCTION mikka_mobile_refresh_session_ended() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."expiresAt" > now() THEN
    UPDATE mobile_refresh_tokens SET revoked_at = now(), revoked_reason = 'session_ended', session_id = NULL
    WHERE revoked_at IS NULL AND family_id IN (SELECT family_id FROM mobile_refresh_tokens WHERE session_id = OLD.id);
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS mobile_refresh_session_ended ON session;
CREATE TRIGGER mobile_refresh_session_ended AFTER DELETE ON session
FOR EACH ROW EXECUTE FUNCTION mikka_mobile_refresh_session_ended();

-- A rotated access session keeps the expiry it was minted with. Better Auth
-- slides a session it reads (updateAge) to the full 7 days; this keeps a
-- minted session at its short lifetime whatever path reads it.
CREATE OR REPLACE FUNCTION mikka_mobile_refresh_session_no_slide() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mobile_refresh_tokens WHERE session_id = OLD.id AND session_minted) THEN
    NEW."expiresAt" := OLD."expiresAt";
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mobile_refresh_session_no_slide ON session;
CREATE TRIGGER mobile_refresh_session_no_slide BEFORE UPDATE OF "expiresAt" ON session
FOR EACH ROW WHEN (NEW."expiresAt" > OLD."expiresAt") EXECUTE FUNCTION mikka_mobile_refresh_session_no_slide();
