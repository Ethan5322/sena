// ============================================================================
// Sena — the owner dashboard, proven against a live hotel day.
//
// CLAUDE.md §2 promises the owner visibility at six stages. This builds that
// day for real — a paid arrival for tonight, a room on hold mid-call, an
// escalated call — and proves each one is VISIBLE on the rendered page, plus
// the two security properties: the wrong key sees nothing, and guest names
// render escaped (they were typed by strangers on the phone).
//
// Run: npm run test:dashboard
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createRouter } from '../src/router.mjs';
import { applyChargeSuccess } from '../src/payments.mjs';
import { renderDashboard } from '../src/dashboard.mjs';
import { useServices } from '../src/services.mjs';
import dashboardHandler from '../api/sena/dashboard.mjs';

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

// ── The hotel's day, built for real ──────────────────────────────────────────
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

const { rows: hotels } = await db.query(`select id, name from sena_hotels where is_demo limit 1`);
const hotel = hotels[0];

const noop = async () => ({ ok: true, id: 'x' });
const router = createRouter({
  db,
  paystack: { initialize: async ({ reference }) => ({ authorization_url: `https://pay.test/${reference}` }) },
  notifier: { channel: 'email', sendPaymentLink: noop, sendConfirmation: noop, notifyOwner: noop, alertOwner: noop },
  publicUrl: 'https://sena.test',
});

// 1. A PAID guest arriving TODAY — must show in arrivals, occupancy and bookings.
// The guest's "name" doubles as the XSS probe: it was typed by a stranger.
const callA = { providerCallId: 'dash_a', dialedNumber: '+27101234567' };
const availA = await router.handle('check_availability', { check_in: day(0), check_out: day(2), guests: 2 }, callA);
const heldA = await router.handle(
  'hold_room',
  { room_id: availA.rooms[0].room_id, check_in: day(0), check_out: day(2), guests_count: 2 },
  callA
);
await router.handle(
  'save_guest_details',
  {
    booking_id: heldA.booking_id,
    full_name: `Sipho <script>alert(1)</script> Ndlovu`,
    phone: '+27841234567',
    email: 'sipho@example.com',
    nationality: 'South African',
    guests_count: 2,
    double_confirmed: true,
  },
  callA
);
await router.handle('send_payment_link', { booking_id: heldA.booking_id }, callA);
const { rows: payA } = await db.query(`select provider_reference from sena_payments where booking_id = $1`, [
  heldA.booking_id,
]);
await applyChargeSuccess(db, {
  event: 'charge.success',
  data: { reference: payA[0].provider_reference, amount: heldA.total * 100 },
});
const pkgA = await router.handle('send_confirmation_package', { booking_id: heldA.booking_id }, callA);
ok(pkgA.ok, `arrival for tonight is booked and paid — ${pkgA.reference}`);

// 2. A room ON HOLD right now — a caller mid-payment. Must show under "on the
// phone right now" as awaiting payment.
const callB = { providerCallId: 'dash_b', dialedNumber: '+27101234567' };
const availB = await router.handle('check_availability', { check_in: day(10), check_out: day(12), guests: 1 }, callB);
const heldB = await router.handle(
  'hold_room',
  { room_id: availB.rooms[0].room_id, check_in: day(10), check_out: day(12), guests_count: 1 },
  callB
);
ok(!!heldB.booking_id, 'a second caller is holding a room mid-call');

// 3. An ESCALATED call (§3) — must be loud on the page.
await db.query(
  `insert into sena_calls (hotel_id, provider_call_id, intent, escalated, escalation_reason)
        values ($1, 'dash_c', 'complaint', true, 'guest describes a safety issue')`,
  [hotel.id]
);

// ── Render, and check every §2 promise is on the page ───────────────────────
const html = await renderDashboard({ db, hotelId: hotel.id });

ok(html.includes(hotel.name), 'the page carries the hotel’s name');
ok(html.includes(pkgA.reference), 'stage 8: the paid booking is on the page');
ok(html.includes('Sipho'), 'the guest is named');
ok(!html.includes('<script>alert(1)</script>'), 'and the name is ESCAPED — guests type their own names');
ok(html.includes('awaiting payment'), 'stage 4/7: the live hold shows, flagged awaiting payment');
ok(/min left/.test(html), 'with the minutes left on the hold');
ok(html.includes('ESCALATED'), '§3: the escalated call is loud');
ok(html.includes('guest describes a safety issue'), 'with its reason');
ok(html.includes('Arriving today'), 'the arrivals list exists');
ok(html.includes('refreshes every minute'), 'and the page declares its own refresh');

// The paid arrival must be in the occupancy count for tonight.
const occ = html.match(/(\d+)\/(\d+) rooms/);
ok(!!occ && Number(occ[1]) >= 1, `tonight's occupancy counts the arrival (${occ && occ[0]})`);

// ── The endpoint: the key is the whole gate ─────────────────────────────────
useServices({ db });
process.env.SENA_OWNER_KEY = 'test-owner-key';
process.env.SENA_DEFAULT_HOTEL_ID = hotel.id;

const fakeRes = () => {
  const r = { headers: {}, code: 200, body: null };
  r.setHeader = (k, v) => (r.headers[k] = v);
  r.status = (c) => ((r.code = c), r);
  r.send = (b) => ((r.body = b), r);
  r.json = (o) => ((r.body = JSON.stringify(o)), r);
  return r;
};

let res = fakeRes();
await dashboardHandler({ query: { key: 'wrong' }, url: '/x' }, res);
ok(res.code === 401, 'the wrong key gets 401 and no data');
ok(!res.body.includes('Sipho'), 'not a single guest name leaks past it');

res = fakeRes();
await dashboardHandler({ query: { key: 'test-owner-key' }, url: '/x' }, res);
ok(res.code === 200 && res.body.includes(pkgA.reference), 'the right key gets the live page');
ok(res.headers['X-Robots-Tag']?.includes('noindex'), 'which is noindex — it is a page of personal data');

console.log(
  failures === 0
    ? '\n  ── the owner can finally see what §2 promised ──\n'
    : `\n  ── ${failures} FAILING ──\n`
);

await db.close();
