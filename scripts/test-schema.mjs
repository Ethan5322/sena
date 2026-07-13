/* Sena — schema behaviour tests.
 *
 * Runs schema.sql, policies.sql and seed-demo-hotel.sql against a real Postgres
 * (PGlite, Postgres compiled to WASM — no server to install) and then attacks
 * the two things that would end a hotel relationship on day one:
 *
 *   1. Selling the same last room to two callers who are on the phone at once.
 *   2. Letting one QR guest ID check in twice.
 *
 * If either of those ever regresses, this fails loudly instead of failing at a
 * front desk at 6am.
 *
 * Run: npm run test:db
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
const read = (f) => fs.readFileSync(path.join(SQL, f), 'utf8');

const db = new PGlite({ extensions: { pgcrypto } });

const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); process.exitCode = 1; };

// Supabase supplies auth.users / auth.uid(); a bare Postgres does not. Stub them
// so policies.sql can be exercised exactly as it will run in Supabase.
await db.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key);
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
`);

for (const f of ['schema.sql', 'policies.sql', 'seed-demo-hotel.sql']) {
  try {
    await db.exec(read(f));
    pass(`${f} applied`);
  } catch (e) {
    fail(`${f} — ${e.message}`);
    process.exit(1);
  }
}

const { rows: [hotel] } = await db.query(
  `select id, name, brand_primary, hold_minutes from sena_hotels where is_demo`);
console.log(`        ${hotel.name} · brand ${hotel.brand_primary} · ${hotel.hold_minutes}min hold`);

// ── Availability ────────────────────────────────────────────────────────────
const { rows: avail } = await db.query(
  `select name, rate_cents, free_units, total_cents
     from sena_check_availability($1, current_date + 7, current_date + 9, 2)
    order by rate_cents`, [hotel.id]);
if (!avail.length) fail('no availability returned for a normal 2-night stay');
else {
  pass(`sena_check_availability → ${avail.length} room types`);
  for (const r of avail) {
    console.log(`        ${r.name.padEnd(17)} R${(Number(r.rate_cents) / 100).toFixed(2)}/night · ${r.free_units} free · total R${(Number(r.total_cents) / 100).toFixed(2)}`);
  }
}

// A single guest must never be offered a room that cannot hold them.
const { rows: single } = await db.query(
  `select name from sena_check_availability($1, current_date + 7, current_date + 9, 4)`, [hotel.id]);
if (single.every((r) => r.name === 'Family Room')) pass('capacity respected — only the Family Room sleeps 4');
else fail(`a room too small for 4 guests was offered: ${single.map((r) => r.name).join(', ')}`);

// ── Can we oversell the last room? ─────────────────────────────────────────
const { rows: [suite] } = await db.query(
  `select id from sena_rooms where hotel_id = $1 and name = 'Executive Suite'`, [hotel.id]);
await db.query(`update sena_rooms set inventory = 1 where id = $1`, [suite.id]);

const { rows: [first] } = await db.query(
  `select * from sena_hold_room($1, $2, current_date + 30, current_date + 32, 2, null)`,
  [hotel.id, suite.id]);
pass(`hold #1 → ${first.reference} (R${(Number(first.total_cents) / 100).toFixed(2)})`);

let oversold = false;
try {
  await db.query(`select * from sena_hold_room($1, $2, current_date + 30, current_date + 32, 2, null)`,
    [hotel.id, suite.id]);
  oversold = true;
} catch (e) {
  pass(`hold #2 on the last room REFUSED — "${e.message.split('\n')[0]}"`);
}
if (oversold) fail('DOUBLE BOOKED — the hotel just oversold its last suite');

// Back-to-back stays must still sell: checkout day == next guest's arrival day.
try {
  const { rows: [ok] } = await db.query(
    `select * from sena_hold_room($1, $2, current_date + 32, current_date + 34, 2, null)`,
    [hotel.id, suite.id]);
  pass(`the same room re-sells from the checkout day (${ok.reference})`);
} catch (e) {
  fail(`a legitimate back-to-back stay was refused — ${e.message}`);
}

// ── An abandoned hold must free the room again ─────────────────────────────
await db.query(`update sena_bookings set hold_expires_at = now() - interval '1 minute' where status = 'pending'`);
const { rows: [{ sena_expire_stale_holds: freed }] } = await db.query(`select sena_expire_stale_holds()`);
pass(`sena_expire_stale_holds() released ${freed} abandoned hold(s)`);

const { rows: [again] } = await db.query(
  `select free_units from sena_check_availability($1, current_date + 30, current_date + 32, 2)
    where room_id = $2`, [hotel.id, suite.id]);
if (Number(again?.free_units) === 1) pass('the abandoned suite is sellable again');
else fail(`suite still blocked after its hold expired (free_units=${again?.free_units})`);

// ── Single-use guest ID ────────────────────────────────────────────────────
const { rows: [g] } = await db.query(
  `insert into sena_guests (hotel_id, full_name, phone, email, nationality)
   values ($1, 'Thabo Mokoena', '+27821234567', 't@example.com', 'South African') returning id`,
  [hotel.id]);
const { rows: [b] } = await db.query(
  `select * from sena_hold_room($1, $2, current_date + 60, current_date + 61, 2, null)`,
  [hotel.id, suite.id]);
await db.query(`update sena_bookings set guest_id = $1, status = 'confirmed' where id = $2`,
  [g.id, b.booking_id]);
await db.query(
  `insert into sena_guest_ids (booking_id, guest_id_number, verification_number)
   values ($1, 'JC-G-0001', 'VRF-8H2K9')`, [b.booking_id]);

const { rows: [scan1] } = await db.query(`select * from sena_knock_out_guest_id('VRF-8H2K9', 'desk-1')`);
if (scan1.ok) pass(`first scan checks in ${scan1.guest_name} on ${scan1.booking_reference}`);
else fail(`first scan failed — ${scan1.reason}`);

const { rows: [scan2] } = await db.query(`select * from sena_knock_out_guest_id('VRF-8H2K9', 'desk-2')`);
if (!scan2.ok) pass(`second scan of the same QR REFUSED — "${scan2.reason}"`);
else fail('a guest ID was reused — the knock-out rule is broken');

const { rows: [{ status }] } = await db.query(`select status from sena_bookings where id = $1`, [b.booking_id]);
if (status === 'checked_in') pass('booking flipped to checked_in on scan');
else fail(`booking status is ${status}, expected checked_in`);

const { rows: [unknown] } = await db.query(`select * from sena_knock_out_guest_id('NOT-A-CODE', 'desk-1')`);
if (!unknown.ok && unknown.reason === 'unknown code') pass('an unknown QR is rejected cleanly');
else fail('an unknown code was not handled');

if (process.exitCode) console.error('\n  ── FAILURES ABOVE ──');
else console.log('\n  ── all schema behaviour verified ──');
