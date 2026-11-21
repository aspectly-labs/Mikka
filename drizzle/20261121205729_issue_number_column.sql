-- target: MIKKA_DATABASE_URL

-- A12: the owner-scope task number moves to a real column (expand phase).
-- Reads keep the content metadata copy until the contract migration.

ALTER TABLE issues ADD COLUMN IF NOT EXISTS "number" integer;

UPDATE issues SET "number" = (content->'attrs'->'mikka'->>'number')::integer
WHERE "number" IS NULL AND content->'attrs'->'mikka'->>'number' ~ '^\d+$';

UPDATE issues SET "number" = (content->'attrs'->'orvilo'->>'number')::integer
WHERE "number" IS NULL AND content->'attrs'->'orvilo'->>'number' ~ '^\d+$';

CREATE UNIQUE INDEX IF NOT EXISTS issues_owner_number_key ON issues ("userId", "number") WHERE "number" IS NOT NULL;
