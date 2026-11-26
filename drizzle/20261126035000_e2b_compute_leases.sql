-- Store the provider template and the paid interval separately from run ownership.
-- A task's sandbox may be adopted by a later run while its paid time is still usable.
CREATE TABLE IF NOT EXISTS e2b_compute_leases (
  "operationId" uuid PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "providerScope" text NOT NULL,
  "templateId" text NOT NULL,
  size text NOT NULL CHECK (size IN ('small','medium','large','ultra')),
  "cpuCount" integer NOT NULL CHECK ("cpuCount">0),
  "memoryMB" integer NOT NULL CHECK ("memoryMB">0),
  "hourlyMicroUsd" integer NOT NULL CHECK ("hourlyMicroUsd">0),
  "sandboxId" text UNIQUE,
  "paidUntil" timestamptz,
  "creationMissingAt" timestamptz,
  "creationAttempts" integer NOT NULL DEFAULT 0,
  "chunkIndex" integer NOT NULL DEFAULT -1,
  "pendingAt" timestamptz,
  "pendingRunId" uuid,
  "usedChunkIndex" integer NOT NULL DEFAULT -1,
  "previousPaidUntil" timestamptz,
  "activeChunkIndex" integer NOT NULL DEFAULT -1,
  "previousActiveChunkIndex" integer NOT NULL DEFAULT -1,
  "renewalReviewAt" timestamptz,
  "renewalDispatchId" uuid,
  "renewalDispatchUntil" timestamptz,
  "renewalUnchangedAt" timestamptz,
  "renewalBaselineDeadline" timestamptz
);
CREATE INDEX IF NOT EXISTS e2b_compute_renewal_due_idx ON e2b_compute_leases("renewalReviewAt") WHERE "renewalReviewAt" IS NOT NULL;
ALTER TABLE e2b_resource_accounts ADD COLUMN IF NOT EXISTS "computeTemplateId" text;
