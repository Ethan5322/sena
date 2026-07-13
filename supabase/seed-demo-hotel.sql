-- ============================================================================
-- Sena — demo property seed
--
-- "Jacaranda Court Hotel" is FICTIONAL. It exists so the whole system can be
-- built, called and demonstrated before a real hotel signs. Nothing here refers
-- to a real business; the phone number is a MuleSoo test line.
--
-- Onboarding a REAL hotel is this file with different values — not a rebuild.
-- Every rate, policy and room type below is data, not code. That is the product.
--
-- Run after schema.sql and policies.sql.
-- ============================================================================

-- Idempotent: re-running the seed refreshes the demo instead of duplicating it.
delete from sena_hotels where is_demo;

with h as (
  insert into sena_hotels (
    name, phone, email, address,
    currency, timezone,
    check_in_time, check_out_time,
    cancellation_policy,
    early_late_policy,
    escalation_phone, escalation_whatsapp,
    hold_minutes, deposit_percent,
    brand_primary, brand_accent, brand_ink, card_style,
    is_demo
  ) values (
    'Jacaranda Court Hotel',
    '+27101234567',                       -- demo line, not a real hotel
    'stay@jacarandacourt.example',
    '14 Jacaranda Avenue, Hatfield, Pretoria, 0083',
    'ZAR',
    'Africa/Johannesburg',
    '14:00',
    '10:00',
    -- Quoted VERBATIM by Sena. Written the way a person would say it out loud,
    -- because it will be said out loud.
    'Free cancellation up to 48 hours before check-in, and you get a full refund. ' ||
    'Inside 48 hours, the first night is charged. No-shows are charged the first night. ' ||
    'To cancel, call us or reply to your confirmation on WhatsApp.',
    'Check-in from 2pm and check-out by 10am. Early check-in and late check-out are ' ||
    'free when the room is available, but I have to get that approved by the front desk ' ||
    'rather than promise it on the call.',
    '+27688529333',                       -- MuleSoo line stands in for the owner during the demo
    '+27688529333',
    20,                                   -- hold the room 20 minutes while they pay
    100,                                  -- demo takes the full amount up front
    -- The hotel's OWN colours: deep jacaranda purple with a brass accent. The
    -- Guest ID card is built from these — a different hotel is a different card
    -- without touching the generator.
    '#1E1233',                            -- brand_primary  (card background)
    '#C8A24B',                            -- brand_accent   (rules, chip, headings)
    '#FFFFFF',                            -- brand_ink
    'dark',                               -- card_style
    true
  )
  returning id
)
insert into sena_rooms (hotel_id, name, description, plan, rate_cents, capacity, inventory, amenities)
select h.id, r.name, r.description, r.plan, r.rate_cents, r.capacity, r.inventory, r.amenities
from h, (values
  (
    'Standard Double',
    'A quiet double room with a queen bed, work desk and fast Wi-Fi.',
    'Bed & Breakfast',
    95000::bigint,          -- R950 per night (cents)
    2, 8,
    array['Free Wi-Fi', 'Breakfast included', 'En-suite bathroom', 'Air conditioning', 'Secure parking']
  ),
  (
    'Twin Room',
    'Two single beds, ideal for colleagues travelling together.',
    'Bed & Breakfast',
    105000::bigint,         -- R1,050
    2, 4,
    array['Free Wi-Fi', 'Breakfast included', 'Two single beds', 'Work desk', 'Secure parking']
  ),
  (
    'Family Room',
    'A double bed plus two singles, with space for a cot on request.',
    'Bed & Breakfast',
    155000::bigint,         -- R1,550
    4, 3,
    array['Free Wi-Fi', 'Breakfast included', 'Sleeps four', 'Extra cot on request', 'Secure parking']
  ),
  (
    'Executive Suite',
    'A separate lounge, king bed and a view over the jacarandas.',
    'Bed & Breakfast',
    240000::bigint,         -- R2,400
    2, 2,
    array['Free Wi-Fi', 'Breakfast included', 'Separate lounge', 'King bed', 'Nespresso machine', 'Secure parking']
  ),
  (
    'Budget Single',
    'A compact single room for a short stay.',
    'Room Only',
    62000::bigint,          -- R620
    1, 6,
    array['Free Wi-Fi', 'En-suite bathroom', 'Secure parking']
  )
) as r(name, description, plan, rate_cents, capacity, inventory, amenities);

-- ── Sanity checks ───────────────────────────────────────────────────────────
-- A seed that silently half-loaded is worse than one that failed loudly.
do $$
declare
  v_hotel uuid;
  v_rooms int;
  v_free  int;
begin
  select id into v_hotel from sena_hotels where is_demo;
  if v_hotel is null then raise exception 'demo hotel did not seed'; end if;

  select count(*) into v_rooms from sena_rooms where hotel_id = v_hotel;
  if v_rooms <> 5 then raise exception 'expected 5 room types, got %', v_rooms; end if;

  -- Availability must answer for a normal two-night stay, or Sena has nothing to sell.
  select count(*) into v_free
    from sena_check_availability(v_hotel, current_date + 7, current_date + 9, 2);
  if v_free = 0 then raise exception 'no availability returned for a 2-night stay'; end if;

  raise notice 'Demo hotel seeded: % room types, % sellable for 2 sena_guests next week.', v_rooms, v_free;
end $$;
