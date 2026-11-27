-- target: MIKKA_DATABASE_URL
-- migrate: reviewed-data #3335 Extend the existing credential-source constraint for run-bound subscriptions.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE model_gateway_tokens ADD COLUMN IF NOT EXISTS "deviceId" uuid;
ALTER TABLE model_gateway_tokens DROP CONSTRAINT IF EXISTS "model_gateway_tokens_sourceKind_check";
ALTER TABLE model_gateway_tokens ADD CONSTRAINT "model_gateway_tokens_sourceKind_check"
  CHECK ("sourceKind" IN ('credits', 'api_key', 'subscription'));
ALTER TABLE model_gateway_tokens ADD CONSTRAINT model_gateway_tokens_subscription_device
  CHECK (("sourceKind" = 'subscription') = ("deviceId" IS NOT NULL));
COMMIT;
