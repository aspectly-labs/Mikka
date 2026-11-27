-- target: MIKKA_DATABASE_URL
-- Cross-database provenance. Environment snapshot receipts live in DATABASE_URL.
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "environmentSnapshotId" uuid;
