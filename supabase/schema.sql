-- ============================================================================
-- Sena — AI Front Desk Receptionist · Supabase schema
-- Build step 1 of 5 (CLAUDE.md §6).
--
-- The journey map in CLAUDE.md §2 is the source of truth: every stage there is
-- one row, one status change, or one webhook here. If a stage cannot be
-- observed in this schema, the stage is not really built.
--
-- Run: psql < schema.sql   (or paste into the Supabase SQL editor)
-- Then: policies.sql, then seed-demo-hotel.sql
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ── Enums ───────────────────────────────────────────────────────────────────
-- Booking lifecycle from §2: pending → confirmed → checked_in → completed.
-- `expired` is the pending hold that was never paid for; `cancelled` is a
-- deliberate cancellation. They are different things and the owner's revenue
-- report must not confuse them.
do $$ begin
  create type sena_booking_status as enum
    ('pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sena_guest_id_status as enum ('active', 'used', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sena_payment_status as enum ('pending', 'paid', 'failed', 'refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sena_call_intent as enum
    ('new_booking', 'existing_booking', 'inquiry', 'complaint', 'unknown');
exception when duplicate_object then null; end $$;

-- ── sena_hotels ──────────────────────────────────────────────────────────────────
-- Not in §6, added deliberately: this system is sold to many sena_hotels. Every
-- other table hangs off this one so a second client is a row, not a database.
create table if not exists sena_hotels (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  phone               text not null,                    -- the published number sena_guests dial
  email               text,
  address             text,
  currency            text not null default 'ZAR',
  timezone            text not null default 'Africa/Johannesburg',

  -- Policy text Sena QUOTES VERBATIM on the phone. It must never paraphrase a
  -- refund rule — that is how a hotel ends up in a Consumer Protection dispute.
  check_in_time       time not null default '14:00',
  check_out_time      time not null default '10:00',
  cancellation_policy text not null,
  early_late_policy   text,

  -- Where Sena hands off to a human (CLAUDE.md §3).
  escalation_phone    text not null,
  escalation_whatsapp text not null,

  -- How long a room is held while the guest pays (§2 stage 7: 15–30 min).
  hold_minutes        int  not null default 20 check (hold_minutes between 5 and 60),
  deposit_percent     int  not null default 100 check (deposit_percent between 1 and 100),

  -- Brand, so the Guest ID card and the booking PDF are the HOTEL's document,
  -- themed from data rather than hardcoded per client. Every MuleSoo deliverable
  -- still carries the MuleSoo credit stamp — the hotel's colours, our mark.
  brand_primary       text not null default '#0B1220',  -- card background
  brand_accent        text not null default '#C8A24B',  -- rules, headings, chip
  brand_ink           text not null default '#FFFFFF',  -- text on the card
  logo_url            text,                             -- transparent PNG; falls back to a wordmark
  card_style          text not null default 'dark'
                        check (card_style in ('dark', 'light')),

  is_demo             boolean not null default false,   -- keeps the fictional hotel out of real reporting
  created_at          timestamptz not null default now()
);

-- Where this hotel's LIVE voice line is, right now. The voice stack runs on a
-- box (or a laptop behind a tunnel) whose public URL can change on every
-- restart — so the box REGISTERS itself here (POST /api/sena/voice, signed
-- with the shared secret) and heartbeats every few minutes. The public "Call
-- Sena" button redirects to a fresh registration and shows an honest holding
-- page when the heartbeat has gone quiet. No poster is ever reprinted.
alter table sena_hotels add column if not exists voice_url            text;
alter table sena_hotels add column if not exists voice_url_updated_at timestamptz;

-- ── sena_rooms ───────────────────────────────────────────────────────────────────
-- A room TYPE with an inventory count, not a single physical room. A hotel has
-- "6 Standard Doubles", and availability is inventory minus overlapping
-- sena_bookings. Modelling one row per physical room would force Sena to pick a
-- room number on the phone, which no receptionist actually does.
create table if not exists sena_rooms (
  id           uuid primary key default gen_random_uuid(),
  hotel_id     uuid not null references sena_hotels(id) on delete cascade,
  name         text not null,                            -- "Standard Double"
  description  text,
  plan         text,                                     -- "Bed & Breakfast", "Room Only"
  rate_cents   bigint not null check (rate_cents > 0),   -- per night, in the hotel's currency
  capacity     int    not null default 2 check (capacity > 0),
  inventory    int    not null default 1 check (inventory >= 0),
  amenities    text[] not null default '{}',
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists sena_rooms_hotel_idx on sena_rooms(hotel_id) where is_active;

-- ── sena_calls ───────────────────────────────────────────────────────────────────
-- §2 stage 1: a row exists from the moment the phone rings, before we know
-- anything about the caller. Everything else in the journey links back here.
create table if not exists sena_calls (
  id                uuid primary key default gen_random_uuid(),
  hotel_id          uuid not null references sena_hotels(id) on delete cascade,
  provider_call_id  text unique,                         -- the LiveKit room name (a SIP call id, if a number is ever added)
  from_number       text,
  language          text,                                -- 'en' | 'am', detected from first sentence
  intent            sena_call_intent not null default 'unknown',
  outcome           text,                                -- free text: 'booked', 'no availability', ...
  escalated         boolean not null default false,
  escalation_reason text,
  transcript        text,                                -- §9: retained for disputes, consent stated at greeting
  started_at        timestamptz not null default now(),
  ended_at          timestamptz
);
create index if not exists sena_calls_hotel_started_idx on sena_calls(hotel_id, started_at desc);

-- ── sena_guests ──────────────────────────────────────────────────────────────────
-- §2 stage 6, the double-confirmation gate: NOTHING is written here until every
-- field has been read back to the caller and confirmed. The gate lives in the
-- voice agent (it simply does not call the tool until confirmed), and this
-- table's NOT NULLs are the second line of defence — a half-captured guest
-- cannot be persisted even by a buggy workflow.
create table if not exists sena_guests (
  id          uuid primary key default gen_random_uuid(),
  hotel_id    uuid not null references sena_hotels(id) on delete cascade,
  full_name   text not null check (length(btrim(full_name)) > 1),
  phone       text not null check (length(btrim(phone)) >= 7),
  email       text,
  nationality text,
  notes       text,                                      -- preferences, for returning sena_guests (§1)
  created_at  timestamptz not null default now()
);
create index if not exists sena_guests_hotel_phone_idx on sena_guests(hotel_id, phone);

-- ── sena_bookings ────────────────────────────────────────────────────────────────
create table if not exists sena_bookings (
  id               uuid primary key default gen_random_uuid(),
  hotel_id         uuid not null references sena_hotels(id) on delete cascade,
  guest_id         uuid references sena_guests(id) on delete set null,
  room_id          uuid not null references sena_rooms(id),
  call_id          uuid references sena_calls(id) on delete set null,

  reference        text not null unique,                 -- what Sena reads aloud: "JC-4K7Q2"
  check_in         date not null,
  check_out        date not null,
  arrival_time     time,                                 -- §2 stage 5, asked explicitly
  departure_time   time,
  guests_count     int  not null default 1 check (guests_count > 0),
  special_requests text,
  needs_approval   boolean not null default false,       -- early/late outside policy → owner decides

  status           sena_booking_status not null default 'pending',
  total_cents      bigint not null check (total_cents > 0),

  -- The pending hold. Past this moment an unpaid booking stops blocking the
  -- room for everyone else (§2 stage 7). Availability MUST honour this or the
  -- hotel silently loses sellable nights to abandoned sena_calls.
  hold_expires_at  timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint booking_dates_sane check (check_out > check_in)
);
create index if not exists sena_bookings_room_dates_idx on sena_bookings(room_id, check_in, check_out);
create index if not exists sena_bookings_hotel_status_idx on sena_bookings(hotel_id, status);

-- ── sena_guest_ids ───────────────────────────────────────────────────────────────
-- §7: the QR Guest ID. Single use. The verification number is spent exactly once
-- — at the desk (staff scan) or by the guest themselves (self check-in with a
-- photo). After that the card lives on as the in-stay photo pass until check-out,
-- when it expires and the photo is purged (POPIA: biometric data is not kept one
-- day longer than the stay it verified).
create table if not exists sena_guest_ids (
  id                  uuid primary key default gen_random_uuid(),
  booking_id          uuid not null unique references sena_bookings(id) on delete cascade,
  guest_id_number     text not null unique,              -- printed on the card
  verification_number text not null unique,              -- encoded in the QR, checked at the desk
  status              sena_guest_id_status not null default 'active',
  used_at             timestamptz,
  used_by             text,                              -- which staff device knocked it out
  created_at          timestamptz not null default now()
);

-- The guest's photo, captured at self check-in. A data URI (image/jpeg), never a
-- card number's worth of risk: it is deleted automatically the day the stay ends
-- (sena_expire_ended_guest_ids). Kept in the row rather than a storage bucket so
-- the demo needs no extra service and a purge is one UPDATE, not a bucket sweep.
alter table sena_guest_ids add column if not exists photo          text;
alter table sena_guest_ids add column if not exists photo_taken_at timestamptz;

-- ── sena_payments ────────────────────────────────────────────────────────────────
-- Paystack in ZAR (decision §0.0). No card data ever lands here — the gateway
-- holds it; we keep only its reference (§9).
create table if not exists sena_payments (
  id                 uuid primary key default gen_random_uuid(),
  booking_id         uuid not null references sena_bookings(id) on delete cascade,
  provider           text not null default 'paystack',
  provider_reference text unique,
  amount_cents       bigint not null check (amount_cents > 0),
  currency           text not null default 'ZAR',
  status             sena_payment_status not null default 'pending',
  raw                jsonb,                              -- webhook payload, for dispute forensics
  created_at         timestamptz not null default now(),
  paid_at            timestamptz
);
create index if not exists sena_payments_booking_idx on sena_payments(booking_id);

-- ── sena_notifications_log ───────────────────────────────────────────────────────
-- §8. Every message we send. Email is the channel (WhatsApp cannot deliver to a
-- guest who only phoned us — see src/adapters/notifier.mjs), but `channel` stays
-- free text so another one can be added without a migration. When an owner says
-- "I never got the booking", this table answers it.
create table if not exists sena_notifications_log (
  id                  uuid primary key default gen_random_uuid(),
  booking_id          uuid references sena_bookings(id) on delete cascade,
  channel             text not null,                     -- 'whatsapp' | 'sms' | 'email'
  recipient           text not null,
  template            text not null,                     -- 'guest_confirmation' | 'owner_new_booking' | ...
  status              text not null default 'queued',    -- 'queued' | 'sent' | 'delivered' | 'failed'
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now()
);

-- ============================================================================
-- Availability — the one piece of logic that must never be wrong
--
-- A booking occupies a room only while it is live: confirmed, checked in, or
-- pending with a hold that has not yet expired. Cancelled, completed and
-- expired sena_bookings free the room. Date overlap is half-open [check_in,
-- check_out) — a guest leaving on the 5th does not clash with one arriving on
-- the 5th, which is how sena_hotels actually work.
-- ============================================================================
create or replace function sena_rooms_taken(
  p_room_id  uuid,
  p_check_in date,
  p_check_out date
) returns int
language sql
stable
as $$
  select coalesce(count(*), 0)::int
  from sena_bookings b
  where b.room_id = p_room_id
    and b.check_in < p_check_out
    and b.check_out > p_check_in
    and (
      b.status in ('confirmed', 'checked_in')
      or (b.status = 'pending' and b.hold_expires_at > now())
    );
$$;

create or replace function sena_check_availability(
  p_hotel_id  uuid,
  p_check_in  date,
  p_check_out date,
  p_guests    int default 1
) returns table (
  room_id     uuid,
  name        text,
  plan        text,
  rate_cents  bigint,
  capacity    int,
  amenities   text[],
  free_units  int,
  nights      int,
  total_cents bigint
)
language sql
stable
as $$
  select
    r.id,
    r.name,
    r.plan,
    r.rate_cents,
    r.capacity,
    r.amenities,
    (r.inventory - sena_rooms_taken(r.id, p_check_in, p_check_out)) as free_units,
    (p_check_out - p_check_in) as nights,
    r.rate_cents * (p_check_out - p_check_in) as total_cents
  from sena_rooms r
  where r.hotel_id = p_hotel_id
    and r.is_active
    and r.capacity >= p_guests
    and (r.inventory - sena_rooms_taken(r.id, p_check_in, p_check_out)) > 0
  order by r.rate_cents asc;
$$;

-- ── sena_hold_room: the anti-double-booking gate ─────────────────────────────────
-- Two callers can be on the phone at the same second asking for the last room.
-- Checking availability and then inserting is a race: both read "1 free", both
-- insert, the hotel oversells. So the room row is LOCKED first, the count is
-- re-taken under that lock, and only then is the pending booking written.
--
-- Returns the booking id + reference, or raises. Sena must call this BEFORE it
-- quotes a confirmed price and sends the payment link.
create or replace function sena_hold_room(
  p_hotel_id     uuid,
  p_room_id      uuid,
  p_check_in     date,
  p_check_out    date,
  p_guests_count int,
  p_call_id      uuid default null
) returns table (booking_id uuid, reference text, total_cents bigint, hold_expires_at timestamptz)
language plpgsql
as $$
declare
  v_room       sena_rooms%rowtype;
  v_hotel      sena_hotels%rowtype;
  v_taken      int;
  v_nights     int;
  v_total      bigint;
  v_reference  text;
  v_booking_id uuid;
  v_expires    timestamptz;
begin
  if p_check_out <= p_check_in then
    raise exception 'check_out must be after check_in';
  end if;

  select * into v_hotel from sena_hotels where id = p_hotel_id;
  if not found then raise exception 'unknown hotel %', p_hotel_id; end if;

  -- Serialise every concurrent attempt on THIS room type behind this lock.
  select * into v_room from sena_rooms where id = p_room_id and hotel_id = p_hotel_id for update;
  if not found then raise exception 'unknown room % for hotel %', p_room_id, p_hotel_id; end if;

  v_taken := sena_rooms_taken(p_room_id, p_check_in, p_check_out);
  if v_room.inventory - v_taken <= 0 then
    raise exception 'no availability for room % between % and %', v_room.name, p_check_in, p_check_out
      using errcode = 'check_violation';
  end if;

  if p_guests_count > v_room.capacity then
    raise exception 'room % sleeps %, asked for %', v_room.name, v_room.capacity, p_guests_count;
  end if;

  v_nights  := p_check_out - p_check_in;
  v_total   := v_room.rate_cents * v_nights;
  v_expires := now() + make_interval(mins => v_hotel.hold_minutes);

  -- Short, unambiguous on a phone line: no 0/O or 1/I, which get misheard.
  v_reference := upper(
    substr(regexp_replace(v_hotel.name, '[^a-zA-Z]', '', 'g'), 1, 2) || '-' ||
    substr(translate(encode(gen_random_bytes(8), 'base64'), '01OIl+/=', 'ZYXWVUTS'), 1, 5)
  );

  insert into sena_bookings (hotel_id, room_id, call_id, reference, check_in, check_out,
                        guests_count, status, total_cents, hold_expires_at)
  values (p_hotel_id, p_room_id, p_call_id, v_reference, p_check_in, p_check_out,
          p_guests_count, 'pending', v_total, v_expires)
  returning id into v_booking_id;

  return query select v_booking_id, v_reference, v_total, v_expires;
end;
$$;

-- ── sena_expire_stale_holds: run on a schedule (n8n, every 5 min) ────────────────
-- A hold that was never paid must stop blocking the room. Availability already
-- ignores expired holds, but flipping the status keeps the owner's dashboard
-- honest about what actually happened on those sena_calls.
create or replace function sena_expire_stale_holds() returns int
language sql
as $$
  with expired as (
    update sena_bookings
       set status = 'expired', updated_at = now()
     where status = 'pending'
       and hold_expires_at is not null
       and hold_expires_at < now()
    returning 1
  )
  select coalesce(count(*), 0)::int from expired;
$$;

-- ── sena_confirm_paid_booking: the late-payment gate ─────────────────────────
-- A payment link outlives its hold: the guest can pay HOURS after the 20-minute
-- hold lapsed, and by then the room may have been resold — availability stops
-- counting a lapsed hold the moment it expires. Blindly confirming a late
-- payment is how one room gets two guests.
--
-- So confirmation re-decides under the same lock the hold took:
--   * hold still live            → confirm, no recount needed (this booking is
--                                  still the one occupying the room)
--   * hold lapsed / expired      → lock the room, recount EXCLUDING this
--                                  booking; confirm only if a unit is truly
--                                  free, else report paid_room_gone — the
--                                  money is real, the room is not, and a HUMAN
--                                  decides between refund and re-accommodation
--   * cancelled / already done   → say so, change nothing
create or replace function sena_confirm_paid_booking(p_booking_id uuid)
returns table (outcome text, reference text)
language plpgsql
as $$
declare
  v_b     sena_bookings%rowtype;
  v_room  sena_rooms%rowtype;
  v_taken int;
begin
  select b.* into v_b from sena_bookings b where b.id = p_booking_id for update;
  if not found then
    return query select 'unknown_booking'::text, null::text;
    return;
  end if;

  if v_b.status in ('confirmed', 'checked_in', 'completed') then
    return query select 'already_confirmed'::text, v_b.reference;
    return;
  end if;

  if v_b.status = 'cancelled' then
    return query select 'paid_but_cancelled'::text, v_b.reference;
    return;
  end if;

  -- Hold still live: the room is still being counted as this booking's.
  if v_b.status = 'pending' and v_b.hold_expires_at is not null and v_b.hold_expires_at > now() then
    update sena_bookings set status = 'confirmed', hold_expires_at = null, updated_at = now()
     where id = v_b.id;
    return query select 'confirmed'::text, v_b.reference;
    return;
  end if;

  -- The hold lapsed. Serialise against every concurrent hold_room() on this
  -- room type, then recount — a lapsed/expired booking is not counted by
  -- sena_rooms_taken, so the count is everyone EXCEPT us.
  select r.* into v_room from sena_rooms r where r.id = v_b.room_id for update;
  v_taken := sena_rooms_taken(v_b.room_id, v_b.check_in, v_b.check_out);

  if v_room.inventory - v_taken <= 0 then
    return query select 'paid_room_gone'::text, v_b.reference;
    return;
  end if;

  update sena_bookings set status = 'confirmed', hold_expires_at = null, updated_at = now()
   where id = v_b.id;
  return query select 'confirmed'::text, v_b.reference;
end;
$$;

-- ── sena_knock_out_guest_id: single-use check-in (§7 ID lifecycle rule) ──────────
-- The whole point of the QR is that it dies on first scan. This is deliberately
-- one atomic statement: two staff scanning the same code simultaneously must
-- not both succeed.
create or replace function sena_knock_out_guest_id(
  p_verification_number text,
  p_used_by             text default null
) returns table (ok boolean, reason text, booking_reference text, guest_name text)
language plpgsql
as $$
declare
  v_id      sena_guest_ids%rowtype;
  v_booking sena_bookings%rowtype;
  v_guest   sena_guests%rowtype;
begin
  update sena_guest_ids
     set status = 'used', used_at = now(), used_by = p_used_by
   where verification_number = p_verification_number
     and status = 'active'
  returning * into v_id;

  if not found then
    -- Distinguish "never existed" from "already used" — the front desk needs to
    -- know which, and a reused code may be a shared/forwarded ID.
    select * into v_id from sena_guest_ids where verification_number = p_verification_number;
    if not found then
      return query select false, 'unknown code', null::text, null::text;
    else
      return query select false, 'already used at ' || coalesce(v_id.used_at::text, 'unknown time'),
                          null::text, null::text;
    end if;
    return;
  end if;

  update sena_bookings set status = 'checked_in', updated_at = now()
   where id = v_id.booking_id
  returning * into v_booking;

  select * into v_guest from sena_guests where id = v_booking.guest_id;

  return query select true, 'checked in', v_booking.reference, coalesce(v_guest.full_name, '');
end;
$$;

-- ── sena_self_check_in: the guest checks themselves in (§2 stage 11) ─────────
-- The guest arrives, opens the reception page, chooses "I have a booking",
-- types the verification code from their confirmation email, and takes a photo.
-- This is that moment, as one atomic decision:
--
--   * the code must exist and still be active (single use, same as the desk)
--   * the booking must be PAID — a code only exists after payment, but the
--     booking may have been cancelled since, and a cancelled stay must not
--     walk in
--   * it must be arrival day or later, hotel-local time — a code is not a key
--     to the building a week early
--   * the stay must not already be over
--   * a photo is REQUIRED — the whole point of self check-in is that the card
--     the guest carries for the rest of the stay shows their face
--
-- On success the code is burned (status → used, exactly like a desk scan, and
-- the same race rules apply: the row is locked, two devices cannot both win),
-- the photo is attached, and the booking flips to checked_in. The card page
-- then renders as the in-stay photo pass, valid until check-out.
create or replace function sena_self_check_in(
  p_verification_number text,
  p_photo               text,
  p_device              text default 'guest-self-checkin'
) returns table (ok boolean, reason text, booking_reference text, guest_name text, check_out date)
language plpgsql
as $$
declare
  v_id      sena_guest_ids%rowtype;
  v_booking sena_bookings%rowtype;
  v_guest   sena_guests%rowtype;
  v_today   date;
begin
  -- Lock the credential row: the same code typed on two phones at the same
  -- second must produce one check-in and one honest refusal.
  select gi.* into v_id
    from sena_guest_ids gi
   where gi.verification_number = p_verification_number
     for update;

  if not found then
    return query select false, 'unknown code', null::text, null::text, null::date;
    return;
  end if;

  if v_id.status <> 'active' then
    return query select false,
      case when v_id.status = 'used'
           then 'already checked in at ' || coalesce(v_id.used_at::text, 'unknown time')
           else 'this code has expired' end,
      null::text, null::text, null::date;
    return;
  end if;

  select b.* into v_booking from sena_bookings b where b.id = v_id.booking_id;

  -- "Today" at the HOTEL, not in UTC — around midnight those differ, and a
  -- guest standing in the lobby at 00:30 must not be told to come back tomorrow.
  select (now() at time zone h.timezone)::date into v_today
    from sena_hotels h where h.id = v_booking.hotel_id;

  if v_booking.status = 'cancelled' then
    return query select false, 'this booking was cancelled', v_booking.reference, null::text, null::date;
    return;
  end if;

  -- A guest_id row only exists once money landed, so anything not confirmed
  -- here is a lifecycle surprise — refuse and let a human look.
  if v_booking.status <> 'confirmed' then
    return query select false, 'booking is ' || v_booking.status || ' — please see the front desk',
                        v_booking.reference, null::text, null::date;
    return;
  end if;

  if v_today < v_booking.check_in then
    return query select false, 'too early — check-in opens on ' || v_booking.check_in::text,
                        v_booking.reference, null::text, null::date;
    return;
  end if;

  if v_today > v_booking.check_out then
    return query select false, 'the stay dates for this booking have passed',
                        v_booking.reference, null::text, null::date;
    return;
  end if;

  if p_photo is null or length(p_photo) < 100 then
    return query select false, 'a photo is required to issue the guest ID',
                        v_booking.reference, null::text, null::date;
    return;
  end if;

  update sena_guest_ids
     set status = 'used', used_at = now(), used_by = p_device,
         photo = p_photo, photo_taken_at = now()
   where id = v_id.id;

  update sena_bookings set status = 'checked_in', updated_at = now()
   where id = v_booking.id;

  select g.* into v_guest from sena_guests g where g.id = v_booking.guest_id;

  return query select true, 'checked in', v_booking.reference,
                      coalesce(v_guest.full_name, ''), v_booking.check_out;
end;
$$;

-- ── sena_expire_ended_guest_ids: the pass dies with the stay ─────────────────
-- Run daily (api/sena/cron.mjs). Two promises kept in one statement:
--   1. §7 — an ID is worthless after the stay: status → expired.
--   2. §9 / POPIA — the guest's photo is BIOMETRIC personal information. It is
--      deleted the day after check-out (or the moment a booking is cancelled),
--      automatically, without anyone remembering to. Booking records stay, per
--      the retention policy; the face does not.
create or replace function sena_expire_ended_guest_ids() returns int
language sql
as $$
  with ended as (
    update sena_guest_ids gi
       set status = 'expired', photo = null, photo_taken_at = null
      from sena_bookings b
      join sena_hotels h on h.id = b.hotel_id
     where b.id = gi.booking_id
       and (gi.status <> 'expired' or gi.photo is not null)
       and ( (now() at time zone h.timezone)::date > b.check_out
          or b.status in ('cancelled', 'expired') )
    returning 1
  )
  select coalesce(count(*), 0)::int from ended;
$$;

-- ── updated_at housekeeping ─────────────────────────────────────────────────
create or replace function sena_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists sena_bookings_touch on sena_bookings;
create trigger sena_bookings_touch before update on sena_bookings
  for each row execute function sena_touch_updated_at();
