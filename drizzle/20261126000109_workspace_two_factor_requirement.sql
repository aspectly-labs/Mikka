-- target: DATABASE_URL
-- The membership read holds this workspace row through access-sensitive writes.
ALTER TABLE mikka_workspaces
  ADD COLUMN IF NOT EXISTS "requireTwoFactor" boolean,
  ADD COLUMN IF NOT EXISTS "twoFactorRequiredAt" timestamptz;
