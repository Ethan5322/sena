// ============================================================================
// Sena — self check-in, attacked.
//
// The arrival flow (api/sena/checkin.mjs + sena_self_check_in) is a door into
// the building that no staff member watches. So this does not test that the
// happy path is happy — it tests that every way of walking through the door
// wrongly is refused: no photo, a fake photo, the wrong day, a cancelled
// booking, a spent code, a code that never existed. Then it proves the POPIA
// promise: the photo is deleted the day the stay ends.
//
// It drives the REAL handler (api/sena/checkin.mjs) over fake req/res, on the
// REAL schema (sena-all-in-one.sql), through the REAL router — the same wiring
// a guest's phone hits in production.
//
// Run: npm run test:checkin
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createRouter } from '../src/router.mjs';
import { applyChargeSuccess, notifyPaymentLanded, notifyPaymentProblem } from '../src/payments.mjs';
import { createWhatsApp } from '../src/adapters/whatsapp.mjs';
import { useServices } from '../src/services.mjs';
import checkinHandler from '../api/sena/checkin.mjs';
import cardHandler from '../api/sena/card.mjs';
import voiceHandler from '../api/sena/voice.mjs';

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

// ── The real database ─────────────────────────────────────────────────────────
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
const notifier = {
  channel: 'email',
  sendPaymentLink: noop,
  sendConfirmation: noop,
  notifyOwner: noop,
  // Shaped like the real alertOwner: an email result carrying a whatsapp leg.
  alertOwner: async () => ({ ok: true, id: 'x', whatsapp: { ok: true, id: 'wa-1' } }),
};
const router = createRouter({
  db,
  paystack: { initialize: async ({ reference }) => ({ authorization_url: `https://pay.test/${reference}` }) },
  notifier,
  publicUrl: 'https://sena.test',
});

// The handler asks getServices() for the world; hand it this one.
useServices({ db, notifier, router, paystack: null });
process.env.SENA_PUBLIC_URL = 'https://sena.test';

/** Take a booking all the way to paid + confirmed, return its verification code. */
async function paidBooking({ checkIn, checkOut, callId }) {
  const call = { providerCallId: callId, dialedNumber: '+27101234567', fromNumber: '+27821234567' };
  const avail = await router.handle(
    'check_availability',
    { check_in: checkIn, check_out: checkOut, guests: 2 },
    call
  );
  const held = await router.handle(
    'hold_room',
    { room_id: avail.rooms[0].room_id, check_in: checkIn, check_out: checkOut, guests_count: 2 },
    call
  );
  await router.handle(
    'save_guest_details',
    {
      booking_id: held.booking_id,
      full_name: 'Naledi Dlamini',
      phone: '+27821234567',
      email: 'naledi@example.com',
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
  await router.handle('send_confirmation_package', { booking_id: held.booking_id }, call);
  const { rows: gi } = await db.query(
    `select verification_number from sena_guest_ids where booking_id = $1`,
    [held.booking_id]
  );
  return { bookingId: held.booking_id, code: gi[0].verification_number };
}

/** Drive the real HTTP handler with a fake req/res pair. */
async function hit(body) {
  const res = {
    code: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(b) { this.body = b; return this; },
  };
  await checkinHandler({ method: 'POST', body }, res);
  return res;
}

const PHOTO = 'data:image/jpeg;base64,' + 'A'.repeat(4000);

/** Drive the real card page with a fake GET. */
async function hitCard(v) {
  const res = {
    code: 200,
    headers: {},
    body: null,
    setHeader(k, val) { this.headers[k] = val; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(b) { this.body = b; return this; },
  };
  await cardHandler({ method: 'GET', query: { v }, url: `/api/sena/card?v=${v}` }, res);
  return res;
}

// ── A guest arriving today, paid up ───────────────────────────────────────────
const today = await paidBooking({ checkIn: day(0), checkOut: day(2), callId: 'ci_today' });

const found = await hit({ action: 'lookup', code: today.code });
ok(found.body.ok && found.body.state === 'ready', `lookup on arrival day → ready (${found.body.reference})`);
ok(found.body.guest_name === 'Naledi Dlamini', 'the lookup shows the guest their own booking');
ok(String(found.body.card_url).includes(today.code), 'and where their card will be');

// ── Money landing pings the owner (§8) ────────────────────────────────────────
const { rows: refRow } = await db.query(`select reference from sena_bookings where id = $1`, [
  today.bookingId,
]);
await notifyPaymentLanded(db, notifier, refRow[0].reference);
const { rows: pings } = await db.query(
  `select channel, status from sena_notifications_log
    where booking_id = $1 and template = 'owner_payment_received' order by channel`,
  [today.bookingId]
);
ok(
  pings.length === 2 && pings[0].channel === 'email' && pings[1].channel === 'whatsapp' &&
    pings.every((p) => p.status === 'sent'),
  'money landing pings the owner on email AND WhatsApp, and the ledger records both'
);

const waUnconfigured = await createWhatsApp({}).send({ to: '+27820000000', text: 'x' });
ok(waUnconfigured.skipped === true, 'unconfigured WhatsApp declares itself skipped — email remains the guaranteed lane');

// ── The card before check-in: the arrival QR pass ─────────────────────────────
const cardBefore = await hitCard(today.code);
ok(cardBefore.code === 200 && cardBefore.body.includes('Single Use'), 'before check-in the card is the Single Use QR pass');
ok(cardBefore.body.includes('Save as photo') && cardBefore.body.includes('Save as PDF'), 'with Save-as-photo and Save-as-PDF on it');

// ── Everything that must be refused ───────────────────────────────────────────
const ghost = await hit({ action: 'lookup', code: 'XXXXXXXXXXXX' });
ok(ghost.code === 404 && !ghost.body.ok, 'a code that never existed → 404');

const noPhoto = await hit({ action: 'checkin', code: today.code });
ok(noPhoto.code === 400, 'check-in with NO photo is refused by the API');

const badPhoto = await hit({ action: 'checkin', code: today.code, photo: 'data:text/html;base64,PGI+' });
ok(badPhoto.code === 400, 'a non-image "photo" is refused by the API');

const { rows: sqlNoPhoto } = await db.query(`select * from sena_self_check_in($1, $2)`, [
  today.code,
  'x',
]);
ok(!sqlNoPhoto[0].ok, `the DATABASE also refuses a missing photo — "${sqlNoPhoto[0].reason}" (defence in depth)`);

// Too early: a paid booking whose stay starts next week.
const early = await paidBooking({ checkIn: day(7), checkOut: day(9), callId: 'ci_early' });
const earlyLookup = await hit({ action: 'lookup', code: early.code });
ok(earlyLookup.body.state === 'too_early', 'lookup a week before arrival → too_early');
const earlyTry = await hit({ action: 'checkin', code: early.code, photo: PHOTO });
ok(earlyTry.code === 409 && /too early/.test(earlyTry.body.reason), `and the check-in itself is refused — "${earlyTry.body.reason}"`);

// Cancelled after paying: the code must die with the booking.
const cancelled = await paidBooking({ checkIn: day(0), checkOut: day(3), callId: 'ci_cxl' });
await router.handle('cancel_booking', { booking_id: cancelled.bookingId }, {
  providerCallId: 'ci_cxl2', dialedNumber: '+27101234567',
});
const cxlTry = await hit({ action: 'checkin', code: cancelled.code, photo: PHOTO });
ok(cxlTry.code === 409 && /cancelled/.test(cxlTry.body.reason), 'a cancelled booking cannot walk in');

// ── The happy path, exactly once ──────────────────────────────────────────────
const done = await hit({ action: 'checkin', code: today.code, photo: PHOTO });
ok(done.body.ok, `the real guest checks in — valid until ${done.body.valid_until}`);
ok(/^\d{4}-\d{2}-\d{2}$/.test(done.body.valid_until), 'dates cross the wire as plain YYYY-MM-DD, not Date-object noise');

const { rows: after } = await db.query(
  `select gi.status, gi.photo, gi.used_by, b.status as booking_status
     from sena_guest_ids gi join sena_bookings b on b.id = gi.booking_id
    where gi.verification_number = $1`,
  [today.code]
);
ok(after[0].status === 'used' && after[0].used_by === 'guest-self-checkin', 'the code is burned, attributed to self check-in');
ok(after[0].photo === PHOTO, 'the photo is on the record');
ok(after[0].booking_status === 'checked_in', 'the booking is checked_in');

const again = await hit({ action: 'checkin', code: today.code, photo: PHOTO });
ok(again.code === 409 && /already checked in/.test(again.body.reason), 'the same code a second time is REFUSED');

const desk = await db.query(`select * from sena_knock_out_guest_id($1, 'front-desk')`, [today.code]);
ok(!desk.rows[0].ok, 'the desk scanner also refuses the spent code — one door, one use');

const backAgain = await hit({ action: 'lookup', code: today.code });
ok(backAgain.body.state === 'already_checked_in', 'a re-lookup tells the guest they are already in, and offers the card');

// ── The card after check-in: the in-stay PHOTO pass ──────────────────────────
const cardDuring = await hitCard(today.code);
ok(cardDuring.code === 200 && cardDuring.body.includes('Checked In'), 'after check-in the card renders as the Checked In pass');
ok(cardDuring.body.includes(PHOTO), "with the guest's photo on it");
ok(!/class="qr"\s*>/.test(cardDuring.body), 'and the spent QR panel is hidden — one scannable code, ever');
ok(cardDuring.body.includes('valid until <b>check-out'), 'and it says how long it stays valid');

// ── The POPIA promise: the photo dies with the stay ──────────────────────────
await db.query(
  `update sena_bookings set check_in = current_date - 5, check_out = current_date - 2 where id = $1`,
  [today.bookingId]
);
const { rows: purged } = await db.query(`select sena_expire_ended_guest_ids() as n`);
ok(Number(purged[0].n) >= 1, `the nightly purge found ${purged[0].n} ended pass(es)`);

const { rows: gone } = await db.query(
  `select status, photo, photo_taken_at from sena_guest_ids where verification_number = $1`,
  [today.code]
);
ok(gone[0].status === 'expired', 'the pass expired with the stay');
ok(gone[0].photo === null && gone[0].photo_taken_at === null, 'and the photo is DELETED — biometric data does not outlive the stay');

// The cancelled booking's photo/code must be purged too.
const { rows: cxlGone } = await db.query(
  `select status from sena_guest_ids where verification_number = $1`,
  [cancelled.code]
);
ok(cxlGone[0].status === 'expired', "a cancelled booking's code is expired by the same purge");

// ── The card after the stay: an honest notice, never a live-looking pass ─────
const cardAfter = await hitCard(today.code);
ok(cardAfter.code === 410 && String(cardAfter.body).includes('No longer valid'), 'after the stay the card page says so, instead of impersonating a valid pass');

// ── The unpaid guest: checked in, stamped, and the desk collects ──────────────
// The owner's rule: payment is not a door. The code ships with the payment
// email; an unpaid guest checks in normally and their pass says PAYMENT
// PENDING until money lands.
console.log('\n  ── payment pending ──');

async function unpaidBooking({ checkIn, checkOut, callId }) {
  const call = { providerCallId: callId, dialedNumber: '+27101234567', fromNumber: '+27821234567' };
  const avail = await router.handle('check_availability', { check_in: checkIn, check_out: checkOut, guests: 2 }, call);
  const held = await router.handle(
    'hold_room',
    { room_id: avail.rooms[0].room_id, check_in: checkIn, check_out: checkOut, guests_count: 2 },
    call
  );
  await router.handle(
    'save_guest_details',
    {
      booking_id: held.booking_id,
      full_name: 'Sipho Ndlovu',
      phone: '+27835550000',
      email: 'sipho@example.com',
      nationality: 'South African',
      guests_count: 2,
      double_confirmed: true,
    },
    call
  );
  const link = await router.handle('send_payment_link', { booking_id: held.booking_id }, call);
  const { rows: gi } = await db.query(
    `select verification_number from sena_guest_ids where booking_id = $1`,
    [held.booking_id]
  );
  return { bookingId: held.booking_id, code: gi[0]?.verification_number, linkOk: link.ok };
}

const unpaid = await unpaidBooking({ checkIn: day(0), checkOut: day(2), callId: 'ci_unpaid' });
ok(Boolean(unpaid.code), 'the CHECK-IN CODE is minted WITH the payment link — before any money moves');

const upLookup = await hit({ action: 'lookup', code: unpaid.code });
ok(
  upLookup.body.state === 'ready' && upLookup.body.payment_pending === true,
  'lookup on an unpaid booking → ready, flagged payment_pending'
);

const upDone = await hit({ action: 'checkin', code: unpaid.code, photo: PHOTO });
ok(upDone.body.ok && upDone.body.payment_pending === true, 'the unpaid guest checks in — the system says so instead of turning them away');

const upCard = await hitCard(unpaid.code);
ok(
  /class="paystrip"\s*>/.test(upCard.body) && upCard.body.includes('Payment pending'),
  "and their pass wears the amber PAYMENT PENDING strip"
);

// A reference-shaped mistake gets a helpful answer, not a shrug.
const refMistake = await hit({ action: 'lookup', code: 'JA-WX2MQ' });
ok(
  refMistake.code === 400 && /booking reference/.test(refMistake.body.reason),
  'typing the booking reference is answered specifically — the exact confusion a real test hit'
);

// A paid guest's card must NOT wear the strip.
const paidFresh = await paidBooking({ checkIn: day(0), checkOut: day(2), callId: 'ci_paid2' });
const paidCard = await hitCard(paidFresh.code);
ok(/class="paystrip"\s+hidden/.test(paidCard.body), "a PAID guest's pass carries no payment strip");

// ── The 48-hour no-show window ────────────────────────────────────────────────
const noShow = await unpaidBooking({ checkIn: day(0), checkOut: day(5), callId: 'ci_noshow' });
await db.query(
  `update sena_bookings set check_in = current_date - 3, check_out = current_date + 2 where id = $1`,
  [noShow.bookingId]
);
await db.query(`select sena_expire_ended_guest_ids()`);
const { rows: ns } = await db.query(
  `select status from sena_guest_ids where verification_number = $1`,
  [noShow.code]
);
ok(ns[0].status === 'expired', 'a code unused 48 hours past check-in time EXPIRES — no-shows do not hold keys');

// ── The voice door: the box announces itself, the button follows ─────────────
console.log('\n  ── the voice door ──');
process.env.SENA_WEBHOOK_SECRET = 'voice-test-secret';
delete process.env.SENA_VOICE_URL;

async function hitVoice(method, { body, secret } = {}) {
  const res = {
    code: 200, headers: {}, body: null, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
  await voiceHandler({ method, body, headers: { 'x-sena-secret': secret } }, res);
  return res;
}

const badReg = await hitVoice('POST', { body: { url: 'https://x.trycloudflare.com' }, secret: 'wrong' });
ok(badReg.code === 401, 'registering a voice line without the secret → 401');

const reg = await hitVoice('POST', {
  body: { url: 'https://demo-line.trycloudflare.com' },
  secret: 'voice-test-secret',
});
ok(reg.code === 200 && reg.body.registered, 'the box registers its public URL');

const follow = await hitVoice('GET');
ok(
  // Vercel-style handlers set res.statusCode directly for redirects.
  follow.statusCode === 302 && follow.headers.Location === 'https://demo-line.trycloudflare.com/?call=1',
  '"Call Sena" follows the fresh registration — with ?call=1, so the call starts itself'
);

// The heartbeat goes quiet: an old registration must NOT be followed.
await db.query(`update sena_hotels set voice_url_updated_at = now() - interval '1 hour' where is_demo`);
const stale = await hitVoice('GET');
ok(stale.code === 200 && String(stale.body).includes('voice line is closed'), 'a stale heartbeat gets the honest holding page, never a dead redirect');

const bye = await hitVoice('POST', { body: { url: '' }, secret: 'voice-test-secret' });
const afterBye = await hitVoice('GET');
ok(bye.code === 200 && afterBye.code === 200 && String(afterBye.body).includes('Check in with my code'), 'a clean sign-off flips to the holding page, which still routes the guest');

// ── The late payment and the resold room ─────────────────────────────────────
// A payment link outlives its 20-minute hold. If the guest pays overnight and
// the room was resold in between, confirming anyway double-books the room.
console.log('\n  ── the overbooking gate ──');

const { rows: [suite] } = await db.query(
  `select id, inventory, rate_cents from sena_rooms where name = 'Executive Suite'`
);

const { rows: [hotelRow] } = await db.query(`select id from sena_hotels where is_demo`);

async function lapsedPaidAttempt(tag, from, to) {
  const { rows: [held] } = await db.query(
    `select * from sena_hold_room($1, $2, $3::date, $4::date, 2)`,
    [hotelRow.id, suite.id, from, to]
  );
  await db.query(
    `insert into sena_payments (booking_id, provider_reference, amount_cents, currency)
          values ($1, $2, $3, 'ZAR')`,
    [held.booking_id, tag, held.total_cents]
  );
  // The guest walks away; the hold lapses overnight.
  await db.query(`update sena_bookings set hold_expires_at = now() - interval '1 hour' where id = $1`, [
    held.booking_id,
  ]);
  return held;
}

// Room resold while the link sat unpaid: fill the suite's whole inventory.
const oversold = await lapsedPaidAttempt('OVB-GONE', day(30), day(32));
for (let i = 0; i < suite.inventory; i++) {
  await db.query(`select * from sena_hold_room($1, $2, $3::date, $4::date, 2)`, [
    hotelRow.id, suite.id, day(30), day(32),
  ]);
  await db.query(
    `update sena_bookings set status = 'confirmed', hold_expires_at = null
      where room_id = $1 and status = 'pending' and check_in = $2::date
        and id <> $3`,
    [suite.id, day(30), oversold.booking_id]
  );
}

const late = await applyChargeSuccess(db, {
  event: 'charge.success',
  data: { reference: 'OVB-GONE', amount: Number(oversold.total_cents) },
});
ok(late.outcome === 'paid_room_gone', `late payment on a RESOLD room is NOT confirmed — "${late.outcome}"`);

const { rows: [ovbB] } = await db.query(`select status from sena_bookings where id = $1`, [oversold.booking_id]);
ok(ovbB.status !== 'confirmed', 'the booking stays unconfirmed — one room never gets two guests');
const { rows: [ovbP] } = await db.query(
  `select status from sena_payments where provider_reference = 'OVB-GONE'`
);
ok(ovbP.status === 'paid', 'but the money is recorded as received — the refund decision has its paper trail');

await notifyPaymentProblem(db, notifier, oversold.reference, 'paid_room_gone');
const { rows: alarm } = await db.query(
  `select 1 from sena_notifications_log where booking_id = $1 and template = 'owner_payment_problem' and status = 'sent'`,
  [oversold.booking_id]
);
ok(alarm.length === 1, 'and the owner is alarmed on both channels — a human decides, not the webhook');

// Same lapse, but the room is still free: the late payment confirms normally.
const fine = await lapsedPaidAttempt('OVB-FINE', day(40), day(42));
const lateFine = await applyChargeSuccess(db, {
  event: 'charge.success',
  data: { reference: 'OVB-FINE', amount: Number(fine.total_cents) },
});
ok(lateFine.outcome === 'confirmed', 'a late payment on a room still free confirms as before');

console.log(
  failures === 0
    ? '\n  ── the door opens once, on the right day, for a paid guest with a face ──\n'
    : `\n  ── ${failures} FAILING ──\n`
);

await db.close();
