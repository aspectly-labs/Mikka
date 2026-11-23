-- target: MIKKA_DATABASE_URL

-- WS-E (#3110): Better Auth native passkey storage (@better-auth/passkey@1.7.12).
-- Rollback: retain additive passkey table and records; disable passkey endpoints in code before reverting.
CREATE TABLE IF NOT EXISTS "passkey" (
  id text PRIMARY KEY,
  name text,
  "publicKey" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "credentialID" text NOT NULL,
  counter integer NOT NULL DEFAULT 0,
  "deviceType" text NOT NULL,
  "backedUp" boolean NOT NULL DEFAULT false,
  transports text,
  "createdAt" timestamptz DEFAULT now(),
  aaguid text
);
CREATE UNIQUE INDEX IF NOT EXISTS passkey_credential_id_unique ON "passkey" ("credentialID");
CREATE INDEX IF NOT EXISTS passkey_user_id_idx ON "passkey" ("userId");
