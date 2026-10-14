-- Extensions the schema depends on. Must run BEFORE any table.
--
-- `pg_trgm` is not optional: the migration creates `GIN (body gin_trgm_ops)`,
-- and without this the operator class does not exist and the whole migration fails
-- on a fresh database. `pgcrypto` backs gen_random_uuid().
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
