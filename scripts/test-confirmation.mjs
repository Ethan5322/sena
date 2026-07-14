// ============================================================================
// Sena — the booking confirmation, proven printable and scannable.
//
// The confirmation is the guest's proof of a paid stay, so the two failure
// modes that matter are (1) claiming PAID for a booking that is not, and
// (2) carrying a QR that checks in somebody else. This drives a real booking
// through the real gates to paid, renders the document from what is actually
// in the database, and then decodes the QR back out to prove it burns THIS
// booking's number.
//
// It also proves the receipt property: the document still renders AFTER the
// guest has checked in and the ID is dead — receipts outlive stays.
//
// Run: npm run test:confirmation
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
import { buildConfirmationHtml } from '../src/confirmation.mjs';
import { useServices } from '../src/services.mjs';
import confirmationHandler from '../api/sena/confirmation.mjs';

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

// ── A real booking, through the real gates, to paid ─────────────────────────
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

const call = { providerCallId: 'conf_test', dialedNumber: '+27101234567', fromNumber: '+27821234567' };

const avail = await router.handle('check_availability', { check_in: day(20), check_out: day(23), guests: 2 }, call);
const held = await router.handle(
  'hold_room',
  { room_id: avail.rooms[0].room_id, check_in: day(20), check_out: day(23), guests_count: 2 },
  call
);
await router.handle(
  'save_guest_details',
  {
    booking_id: held.booking_id,
    full_name: 'Naledi Dlamini',
    phone: '+27831234567',
    email: 'naledi@example.com',
    nationality: 'South African',
    guests_count: 2,
    double_confirmed: true,
  },
  call
);
await router.handle('send_payment_link', { booking_id: held.booking_id }, call);
const { rows: pay } = await db.query(`select provider_reference from sena_payments where booking_id = $1`, [
  held.booking_id,
]);
await applyChargeSuccess(db, {
  event: 'charge.success',
  data: { reference: pay[0].provider_reference, amount: held.total * 100 },
});
const pkg = await router.handle('send_confirmation_package', { booking_id: held.booking_id }, call);
ok(pkg.ok, `a real booking reached confirmed — ${pkg.reference}`);

// ── Render from what is actually in the database ────────────────────────────
const fetchRow = async () => {
  const { rows } = await db.query(
    `select to_jsonb(gi.*) as guest_id, to_jsonb(b.*) as booking, to_jsonb(g.*) as guest,
            to_jsonb(r.*)  as room,     to_jsonb(h.*) as hotel,   to_jsonb(p.*) as payment
       from sena_guest_ids gi
       join sena_bookings b on b.id = gi.booking_id
       join sena_rooms    r on r.id = b.room_id
       join sena_hotels   h on h.id = b.hotel_id
       join sena_guests   g on g.id = b.guest_id
       left join lateral (
         select * from sena_payments where booking_id = b.id and status = 'paid'
          order by paid_at desc nulls last limit 1
       ) p on true
      where gi.booking_id = $1`,
    [held.booking_id]
  );
  return { ...rows[0], guestId: rows[0].guest_id };
};

const row = await fetchRow();
ok(!!row.payment, 'the paid payment row is joined in — PAID is claimed from data, not assumed');

const html = await buildConfirmationHtml(row);
pass('the confirmation renders with no Chrome — this is what Vercel will serve');
ok(!/\{\{\s*\w+\s*\}\}/.test(html), 'no unfilled placeholder survived onto the document');

// ── §7's required fields are all on it ──────────────────────────────────────
ok(html.includes('Naledi Dlamini'), "the guest's name is on it");
ok(html.includes(row.booking.reference), 'the booking reference is on it');
ok(html.includes(row.guest_id.verification_number), 'the verification number is on it');
ok(html.includes(row.payment.provider_reference), 'the payment reference is on it');
ok(html.includes((Number(row.booking.total_cents) / 100).toFixed(2)), 'the total paid is on it');
ok(html.includes(row.hotel.cancellation_policy), 'the cancellation policy is quoted verbatim');
ok(html.includes('Built by MuleSoo'), 'the MuleSoo credit stamp is on it (§0.0 house rule)');
ok(html.includes(row.hotel.brand_primary), `themed from the hotel's own colour (${row.hotel.brand_primary})`);

// ── The QR is the card's QR: paper checks in like a screen does ─────────────
const m = html.match(/src="(data:image\/png;base64,[^"]+)"/);
ok(!!m, 'a QR image is embedded in the document');
const png = PNG.sync.read(Buffer.from(m[1].split(',')[1], 'base64'));
const hit = jsQR(Uint8ClampedArray.from(png.data), png.width, png.height);
ok(!!hit, `the embedded QR decodes (${png.width}×${png.height})`);
ok(
  JSON.parse(hit.data).v === row.guest_id.verification_number,
  'and it carries THIS booking’s verification number'
);

// ── The endpoint, exactly as Vercel calls it ────────────────────────────────
useServices({ db }); // the handler resolves its db through the same seam demo mode uses

const fakeRes = () => {
  const r = { headers: {}, code: 200, body: null };
  r.setHeader = (k, v) => (r.headers[k] = v);
  r.status = (c) => ((r.code = c), r);
  r.send = (b) => ((r.body = b), r);
  r.json = (o) => ((r.body = JSON.stringify(o)), r);
  return r;
};

let res = fakeRes();
await confirmationHandler({ query: { v: row.guest_id.verification_number }, url: '/x' }, res);
ok(res.code === 200 && res.body.includes(row.booking.reference), 'GET /api/sena/confirmation serves it');
ok(res.headers['X-Robots-Tag']?.includes('noindex'), 'and it is marked noindex — this page is personal data');

res = fakeRes();
await confirmationHandler({ query: { v: 'NOSUCHCODE99' }, url: '/x' }, res);
ok(res.code === 404, 'an unknown code is a 404, not somebody else’s booking');

// ── The receipt property: it outlives the check-in ──────────────────────────
await db.query(`select * from sena_knock_out_guest_id($1, $2)`, [
  row.guest_id.verification_number,
  'front-desk-test',
]);
res = fakeRes();
await confirmationHandler({ query: { v: row.guest_id.verification_number }, url: '/x' }, res);
ok(
  res.code === 200 && res.body.includes(row.booking.reference),
  'the confirmation still serves AFTER check-in — receipts outlive stays (the card dies, this must not)'
);

console.log(
  failures === 0
    ? '\n  ── the confirmation prints, proves payment, and outlives the stay ──\n'
    : `\n  ── ${failures} FAILING ──\n`
);

await db.close();
