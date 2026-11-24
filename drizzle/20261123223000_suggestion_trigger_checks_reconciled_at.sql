-- #2820: per-item due for the hourly suggestions backfill — reconciledAt marks
-- each person's last reconcile so the sweep only walks people the real-time
-- path hasn't touched (checkedAt stale) or nobody reconciled inside the window.
ALTER TABLE suggestion_trigger_checks ADD COLUMN IF NOT EXISTS "reconciledAt" timestamptz;
