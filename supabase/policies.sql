-- ============================================================================
-- Sena — Row Level Security (CLAUDE.md §9)
--
-- Threat model, stated plainly: this database holds sena_guests' full names, phone
-- numbers, email addresses and nationalities. Under POPIA that is personal
-- information, and a leak is the hotel's liability and MuleSoo's reputation.
--
-- Two principles:
--   1. The public (the `anon` key that ships in any browser bundle) gets
--      NOTHING. Not a room list, not a booking, nothing. Sena talks to the
--      database through the service_role key from the server side only.
--   2. A logged-in staff member sees their OWN hotel and no other. Hotel A's
--      manager must never be one forged request away from hotel B's sena_guests.
--
-- Run after schema.sql.
-- ============================================================================

-- Who works at which hotel. A staff row is created by the owner (or by MuleSoo
-- on setup); auth.uid() comes from Supabase Auth.
create table if not exists sena_hotel_staff (
  user_id    uuid not null references auth.users(id) on delete cascade,
  hotel_id   uuid not null references sena_hotels(id) on delete cascade,
  role       text not null default 'reception' check (role in ('owner', 'manager', 'reception')),
  created_at timestamptz not null default now(),
  primary key (user_id, hotel_id)
);

alter table sena_hotels             enable row level security;
alter table sena_rooms              enable row level security;
alter table sena_calls              enable row level security;
alter table sena_guests             enable row level security;
alter table sena_bookings           enable row level security;
alter table sena_guest_ids          enable row level security;
alter table sena_payments           enable row level security;
alter table sena_notifications_log  enable row level security;
alter table sena_hotel_staff        enable row level security;

-- Force RLS even for the table owner, so a mistake in a migration script or a
-- future `postgres`-role query cannot quietly bypass the whole model.
alter table sena_guests   force row level security;
alter table sena_bookings force row level security;
alter table sena_payments force row level security;

-- ── The tenancy predicate ───────────────────────────────────────────────────
-- SECURITY DEFINER so the policy can read sena_hotel_staff without recursing back
-- into sena_hotel_staff's own RLS policy (a classic infinite-recursion footgun).
create or replace function sena_is_staff_of(p_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from sena_hotel_staff s
    where s.hotel_id = p_hotel_id
      and s.user_id = auth.uid()
  );
$$;

-- ── Policies ────────────────────────────────────────────────────────────────
-- No policy is written for `anon`. In Postgres RLS, absence of a policy means
-- deny — so the public key already gets nothing. That is deliberate, not an
-- omission.
--
-- Staff get SELECT on their hotel. They do NOT get blanket INSERT/UPDATE:
-- sena_bookings are created by Sena through the service_role key, which bypasses RLS
-- entirely. The one thing reception must be able to do by hand is check a guest
-- in, and that goes through sena_knock_out_guest_id(), not a raw UPDATE.
--
-- Each policy is dropped before it is created because Postgres has no
-- CREATE POLICY IF NOT EXISTS — and the install file must be safe to paste
-- AGAIN into a database that already ran an older version of it. Dropping and
-- recreating a policy in the same transaction-free script leaves no window:
-- with RLS enabled, "no policy" already means deny.

drop policy if exists staff_read_hotel on sena_hotels;
create policy staff_read_hotel on sena_hotels
  for select to authenticated using (sena_is_staff_of(id));

drop policy if exists staff_read_rooms on sena_rooms;
create policy staff_read_rooms on sena_rooms
  for select to authenticated using (sena_is_staff_of(hotel_id));

drop policy if exists staff_read_calls on sena_calls;
create policy staff_read_calls on sena_calls
  for select to authenticated using (sena_is_staff_of(hotel_id));

drop policy if exists staff_read_guests on sena_guests;
create policy staff_read_guests on sena_guests
  for select to authenticated using (sena_is_staff_of(hotel_id));

drop policy if exists staff_read_bookings on sena_bookings;
create policy staff_read_bookings on sena_bookings
  for select to authenticated using (sena_is_staff_of(hotel_id));

drop policy if exists staff_read_guest_ids on sena_guest_ids;
create policy staff_read_guest_ids on sena_guest_ids
  for select to authenticated using (
    exists (select 1 from sena_bookings b where b.id = sena_guest_ids.booking_id and sena_is_staff_of(b.hotel_id))
  );

drop policy if exists staff_read_payments on sena_payments;
create policy staff_read_payments on sena_payments
  for select to authenticated using (
    exists (select 1 from sena_bookings b where b.id = sena_payments.booking_id and sena_is_staff_of(b.hotel_id))
  );

drop policy if exists staff_read_notifications on sena_notifications_log;
create policy staff_read_notifications on sena_notifications_log
  for select to authenticated using (
    booking_id is null
    or exists (select 1 from sena_bookings b where b.id = sena_notifications_log.booking_id and sena_is_staff_of(b.hotel_id))
  );

drop policy if exists staff_read_own_staff_rows on sena_hotel_staff;
create policy staff_read_own_staff_rows on sena_hotel_staff
  for select to authenticated using (user_id = auth.uid());

-- Owners and managers may correct room rates and inventory from the dashboard.
drop policy if exists managers_write_rooms on sena_rooms;
create policy managers_write_rooms on sena_rooms
  for update to authenticated
  using (
    exists (select 1 from sena_hotel_staff s
             where s.hotel_id = sena_rooms.hotel_id
               and s.user_id = auth.uid()
               and s.role in ('owner', 'manager'))
  )
  with check (
    exists (select 1 from sena_hotel_staff s
             where s.hotel_id = sena_rooms.hotel_id
               and s.user_id = auth.uid()
               and s.role in ('owner', 'manager'))
  );

-- ── Front-desk check-in ─────────────────────────────────────────────────────
-- sena_knock_out_guest_id() flips a booking to checked_in and burns the QR. Reception
-- has no UPDATE grant on sena_bookings, so this SECURITY DEFINER wrapper is the only
-- door — and it can only ever do that one thing.
create or replace function sena_staff_check_in(
  p_verification_number text
) returns table (ok boolean, reason text, booking_reference text, guest_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hotel_id uuid;
begin
  select b.hotel_id into v_hotel_id
    from sena_guest_ids g
    join sena_bookings b on b.id = g.booking_id
   where g.verification_number = p_verification_number;

  if v_hotel_id is null then
    return query select false, 'unknown code', null::text, null::text;
    return;
  end if;

  -- The scanner must work at the hotel the code belongs to.
  if not sena_is_staff_of(v_hotel_id) then
    return query select false, 'not authorised for this property', null::text, null::text;
    return;
  end if;

  return query select * from sena_knock_out_guest_id(p_verification_number, auth.uid()::text);
end;
$$;

revoke all on function sena_staff_check_in(text) from public, anon;
grant execute on function sena_staff_check_in(text) to authenticated;

-- Availability is read by Sena (service_role). Nothing here is granted to anon:
-- a public rate-scraper is not a feature the hotel asked for.
revoke all on function sena_check_availability(uuid, date, date, int) from public, anon;
revoke all on function sena_hold_room(uuid, uuid, date, date, int, uuid)  from public, anon;
revoke all on function sena_knock_out_guest_id(text, text)                from public, anon;
revoke all on function sena_expire_stale_holds()                          from public, anon;
-- Self check-in is driven by the API (service_role) — the browser talks to
-- /api/sena/checkin, never to the database. The photo purge is the cron's job.
revoke all on function sena_self_check_in(text, text, text)               from public, anon;
revoke all on function sena_expire_ended_guest_ids()                      from public, anon;
revoke all on function sena_confirm_paid_booking(uuid)                    from public, anon;
