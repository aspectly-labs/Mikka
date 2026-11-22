-- Plugins (Composio) from the desktop app: the account that started a link,
-- named by a one-time token the app hands to the system browser. Only a hash
-- of the token is stored. The app takes the return on its own loopback
-- (RFC 8252 §7.3): returnTo/returnState name its listener, and linkId the
-- connected account Composio gave the connect page, so the shared callback
-- can send the browser back to the app whatever it is signed in as.
CREATE TABLE IF NOT EXISTS composio_connect_intents (
  "tokenHash" text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "toolkit" text NOT NULL,
  "replaceAccountId" text,
  "returnTo" text NOT NULL,
  "returnState" text NOT NULL,
  "linkId" text,
  "usedAt" timestamptz,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS composio_connect_intents_link ON composio_connect_intents ("linkId") WHERE "linkId" IS NOT NULL;
