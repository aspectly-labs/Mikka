-- target: MIKKA_DATABASE_URL
-- Additive per-device binary computer-use switch (allow/deny; never ask) and optional local checkout path metadata on device_repos.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS "computerUseEnabled" boolean NOT NULL DEFAULT true;

ALTER TABLE device_repos
  ADD COLUMN IF NOT EXISTS "localPath" text;
