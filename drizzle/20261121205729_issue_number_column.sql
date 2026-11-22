-- target: MIKKA_DATABASE_URL

-- A12: the generated number column already exists (20261031000250); this adds
-- the integrity half — one owner number per task.
CREATE UNIQUE INDEX IF NOT EXISTS issues_owner_number_key ON issues ("userId", "number") WHERE "number" IS NOT NULL;
