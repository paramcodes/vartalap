-- Handle reservation, enforced by the database. Hand-written: Drizzle has no
-- trigger primitive, and the point of this file is that it cannot be reached by a
-- writer who forgot to call something.
--
-- Two properties this buys that an endpoint could not:
--
--   1. The reservation and the user row commit in the SAME transaction. An
--      afterDelete hook — the mechanism normally used here — loses a handle forever
--      if the process dies between the two writes, which is precisely the failure
--      this table exists to prevent.
--   2. It is the only enforcement no writer can bypass. ADR 0001 already found that
--      writing `user` through Drizzle skips Better Auth's normaliser, so "the app
--      always goes through the plugin" was never true and could not be made true.
--
-- Signup therefore stays inside `signUp.email`. An endpoint writing the user row
-- itself would also have to write the `account` row, and Better Auth's password
-- hash format is undocumented — the library would end up verifying a hash we
-- guessed.
--
-- ADR 0041: a released handle is reserved FOREVER. Tombstoning a user must not make
-- their handle claimable by a stranger.
CREATE OR REPLACE FUNCTION reserve_handle() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- BEFORE DELETE, so the row is still readable and the write cannot fail.
    INSERT INTO handle_reservation (handle, user_id, reason)
         VALUES (OLD.username, OLD.id, 'released')
    ON CONFLICT (handle) DO NOTHING;
    RETURN OLD;
  END IF;

  -- A handle in the reservation table is gone for good (ADR 0041). Without this the
  -- DELETE arm above writes the reservation and nothing ever reads it back, so a
  -- released handle silently becomes claimable again — which is the exact failure
  -- the table exists to prevent.
  IF EXISTS (SELECT 1 FROM handle_reservation WHERE handle = NEW.username) THEN
    RAISE EXCEPTION 'handle % is reserved', NEW.username USING ERRCODE = 'unique_violation';
  END IF;

  -- `OLD` is an UNASSIGNED record in a BEFORE INSERT trigger, and reading a field
  -- off it raises at runtime rather than yielding NULL. So the immutability check is
  -- guarded on TG_OP, not left to the comparison.
  IF TG_OP = 'UPDATE' AND NEW.username IS DISTINCT FROM OLD.username THEN
    -- ADR 0017: handles are immutable. Reaching here at all means something wrote
    -- a username change; refuse it rather than let two rows disagree about a handle.
    RAISE EXCEPTION 'handle is immutable (user % tried to change % -> %)',
      OLD.id, OLD.username, NEW.username USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- BEFORE, not AFTER: AFTER INSERT would let the reservation fail as a separate
-- statement, which is the two-write race the whole design is avoiding.
CREATE TRIGGER user_reserve_handle_ins
  BEFORE INSERT ON "user"
  FOR EACH ROW EXECUTE FUNCTION reserve_handle();
--> statement-breakpoint

CREATE TRIGGER user_reserve_handle_update
  BEFORE UPDATE OF username ON "user"
  FOR EACH ROW EXECUTE FUNCTION reserve_handle();
--> statement-breakpoint

CREATE TRIGGER user_release_handle_del
  BEFORE DELETE ON "user"
  FOR EACH ROW EXECUTE FUNCTION reserve_handle();
