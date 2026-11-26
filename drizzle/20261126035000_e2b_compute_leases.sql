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
  "chunkIndex" integer NOT NULL DEFAULT -1,
  "pendingAt" timestamptz,
  "pendingRunId" uuid
);
ALTER TABLE e2b_resource_accounts ADD COLUMN IF NOT EXISTS "computeTemplateId" text;
