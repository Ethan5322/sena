-- ############################################################################
-- #  SENA — UNINSTALL                                                         #
-- #  Removes every sena_* object. Touches nothing else in the database.       #
-- ############################################################################
--
-- This exists because Sena shares a Supabase project with the MuleSoo website.
-- "Just drop the tables" is how someone deletes the wrong thing at 11pm, so the
-- safe path is written down instead of improvised.
--
-- WARNING: this destroys every booking, guest and payment record Sena holds.
-- Take a backup first if the hotel is live. There is no undo.
--
-- Every name below starts with sena_. Nothing that belongs to MuleSoo (corp_*,
-- leads, site_settings, …) is named here, and nothing is dropped by wildcard.

begin;

-- TABLES FIRST, not functions.
--
-- The RLS policies live ON the tables and CALL sena_is_staff_of(). Dropping the
-- function first therefore fails — Postgres refuses to remove something the
-- policies still depend on. Dropping the tables takes their policies, triggers
-- and indexes with them, which leaves the functions free to go.
drop table if exists sena_notifications_log cascade;
drop table if exists sena_payments          cascade;
drop table if exists sena_guest_ids         cascade;
drop table if exists sena_bookings          cascade;
drop table if exists sena_guests            cascade;
drop table if exists sena_calls             cascade;
drop table if exists sena_rooms             cascade;
drop table if exists sena_hotel_staff       cascade;
drop table if exists sena_hotels            cascade;

-- Now the functions, with nothing left pointing at them.
drop function if exists sena_staff_check_in(text);
drop function if exists sena_knock_out_guest_id(text, text);
drop function if exists sena_expire_stale_holds();
drop function if exists sena_hold_room(uuid, uuid, date, date, int, uuid);
drop function if exists sena_check_availability(uuid, date, date, int);
drop function if exists sena_rooms_taken(uuid, date, date);
drop function if exists sena_is_staff_of(uuid);
drop function if exists sena_touch_updated_at();

-- Types last — nothing references them now.
drop type if exists sena_call_intent;
drop type if exists sena_payment_status;
drop type if exists sena_guest_id_status;
drop type if exists sena_booking_status;

-- Note: the pgcrypto extension is deliberately NOT dropped. MuleSoo may be using
-- it too, and dropping a shared extension to tidy up is exactly the kind of
-- "harmless" cleanup that takes down the other app.

commit;

-- Confirm nothing of Sena's is left:
--   select tablename from pg_tables where tablename like 'sena_%';
--   select proname   from pg_proc   where proname   like 'sena_%';
