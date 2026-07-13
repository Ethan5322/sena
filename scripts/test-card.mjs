// ============================================================================
// Sena — the guest ID card, proven scannable.
//
// The card has exactly one job: to be scanned at 6am by a tired clerk. A card
// that renders beautifully and encodes the wrong booking — or encodes nothing at
// all — fails silently, and you find out when a guest is standing at the desk.
//
// So this does not check that the HTML "looks right". It takes the PNG bytes we
// actually embed in the page, decodes them back out with the same QR reader the
// front-desk scanner uses, and proves they carry THIS guest's verification
// number and nobody else's.
//
// Run: npm run test:card
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PNG } from 'pngjs';
import jsQRmod from 'jsqr';
import { createRouter } from '../src/router.mjs';
import { applyChargeSuccess } from '../src/payments.mjs';
import { buildCardHtml } from '../src/card.mjs';

const jsQR = jsQRmod.default || jsQRmod;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  console.error(`  FAIL  ${m}`);
  failures++;
  process.exitCode = 1;
};
const ok = (c, m) => (c ? pass(m) : fail(m));

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// ── Stand up the real database and take a real booking all the way to paid ──
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key);
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
`);
await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/sena-all-in-one.sql'), 'utf8'));

const noop = async () => ({ ok: true, id: 'x' });
const router = createRouter({
  db,
  paystack: { initialize: async ({ reference }) => ({ authorization_url: `https://pay.test/${reference}` }) },
  notifier: { channel: 'email', sendPaymentLink: noop, sendConfirmation: noop, notifyOwner: noop, alertOwner: noop },
  publicUrl: 'https://sena.test',
});

const call = { providerCallId: 'card_test', dialedNumber: '+27101234567', fromNumber: '+27821234567' };

const avail = await router.handle(
  'check_availability',
  { check_in: day(20), check_out: day(22), guests: 2 },
  call
);
const held = await router.handle(
  'hold_room',
  { room_id: avail.rooms[0].room_id, check_in: day(20), check_out: day(22), guests_count: 2 },
  call
);
await router.handle(
  'save_guest_details',
  {
    booking_id: held.booking_id,
    full_name: 'Thabo Mokoena',
    phone: '+27821234567',
    email: 'thabo@example.com',
    nationality: 'South African',
    guests_count: 2,
    double_confirmed: true,
  },
  call
);
await router.handle('send_payment_link', { booking_id: held.booking_id }, call);

const { rows: pay } = await db.query(
  `select provider_reference from sena_payments where booking_id = $1`,
  [held.booking_id]
);
await applyChargeSuccess(db, {
  event: 'charge.success',
  data: { reference: pay[0].provider_reference, amount: held.total * 100 },
});
const pkg = await router.handle('send_confirmation_package', { booking_id: held.booking_id }, call);
ok(pkg.ok, `a real booking reached confirmed — ${pkg.reference}`);

// ── Render the card from what is actually in the database ───────────────────
const { rows } = await db.query(
  `select to_jsonb(gi.*) as guest_id, to_jsonb(b.*) as booking, to_jsonb(g.*) as guest,
          to_jsonb(r.*)  as room,     to_jsonb(h.*) as hotel
     from sena_guest_ids gi
     join sena_bookings b on b.id = gi.booking_id
     join sena_rooms    r on r.id = b.room_id
     join sena_hotels   h on h.id = b.hotel_id
     join sena_guests   g on g.id = b.guest_id
    where gi.booking_id = $1`,
  [held.booking_id]
);
const row = { ...rows[0], guestId: rows[0].guest_id };

const html = await buildCardHtml(row);
pass('the card renders with no Chrome — this is what Vercel will serve');

// buildCardHtml throws on a leftover placeholder, so reaching here proves it.
ok(!/\{\{\s*\w+\s*\}\}/.test(html), 'no unfilled placeholder survived onto the card');

// ── The card is the HOTEL's document, themed from its row — not hardcoded ───
ok(html.includes(row.hotel.brand_primary), `themed from the hotel's own colour (${row.hotel.brand_primary})`);
ok(html.includes('Thabo Mokoena'), "the guest's name is on the card");
ok(html.includes(row.booking.reference), 'the booking reference is on the card');
ok(html.includes(row.guest_id.guest_id_number), 'the guest ID number is on the card');

// ── The only thing that actually matters: does it scan? ─────────────────────
const m = html.match(/src="(data:image\/png;base64,[^"]+)"/);
ok(!!m, 'a QR image is embedded in the page');

const png = PNG.sync.read(Buffer.from(m[1].split(',')[1], 'base64'));
const hit = jsQR(Uint8ClampedArray.from(png.data), png.width, png.height);
ok(!!hit, `the embedded QR DECODES (${png.width}×${png.height})`);

const payload = JSON.parse(hit.data);
ok(
  payload.v === row.guest_id.verification_number,
  'and it decodes to THIS guest — the number the front desk will burn'
);
ok(payload.ref === row.booking.reference, `it carries the booking too (${payload.ref}, ${payload.name})`);

// ── The knock-out, driven by exactly what the scanner would read ────────────
// This is the full round trip: card → QR → scanner → database. Nothing else in
// the repo proves these two halves are actually connected.
const { rows: first } = await db.query(`select * from sena_knock_out_guest_id($1, $2)`, [
  payload.v,
  'front-desk-test',
]);
ok(first[0].ok, `scanning the card checks in ${first[0].guest_name} on ${first[0].booking_reference}`);

const { rows: second } = await db.query(`select * from sena_knock_out_guest_id($1, $2)`, [
  payload.v,
  'front-desk-test',
]);
ok(!second[0].ok, `a second scan of the same card is REFUSED — "${second[0].reason}"`);

const { rows: st } = await db.query(`select status from sena_bookings where id = $1`, [
  held.booking_id,
]);
ok(st[0].status === 'checked_in', 'and the booking is now checked_in');

console.log(
  failures === 0
    ? '\n  ── the card scans, and it only scans once ──\n'
    : `\n  ── ${failures} FAILING ──\n`
);

await db.close();
