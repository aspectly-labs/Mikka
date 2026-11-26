-- migrate: reviewed-data #3324 create favorites storage and install its account-deletion guard without rewriting rows
-- target: MIKKA_DATABASE_URL
-- The model picker's favorites, as Capy's (lib/model-favorites.ts). One row per
-- person, not per workspace: Capy keeps them per user, and a favorite names a
-- whole setup the person carries between chats. "slots" is the ordered list the
-- picker shows first under Favorites (digit keys 1..9), each
-- {"optionId": <the menu option id the chat saves: binding id, credits:<model> or
-- apikey:<key>:<model>>, "effort": <level or null>, "serviceTier": <speed or null>}.
-- A slot whose option is not usable in the open workspace stays and the menu marks
-- it unavailable. The check allows ten (keys 1..0); the app keeps nine, as Capy.
-- Mirrors lib/db/schema.ts (modelFavorites). Additive only.
-- Rollback: DROP TABLE IF EXISTS model_favorites;
--   DELETE FROM schema_migrations WHERE name = '20261125223407_model_favorites.sql';
CREATE TABLE IF NOT EXISTS model_favorites (
  "ownerId" text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_favorites_slots_list CHECK (jsonb_typeof(slots) = 'array' AND jsonb_array_length(slots) <= 10)
);
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON model_favorites;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON model_favorites FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
