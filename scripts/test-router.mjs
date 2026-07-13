// ============================================================================
// Sena — the tool router, attacked.
//
// The router is what a real guest's phone call actually runs through. The SQL
// tests (test-schema.mjs) prove the database cannot oversell a room or reuse a
// QR. These prove the layer ABOVE it cannot be talked into doing the same thing.
//
// The system prompt asks Sena not to save an unconfirmed guest or confirm an
// unpaid booking. A prompt is a request. An LLM with a persuasive caller on the
// line will eventually make the call anyway — so every one of those rules is
// re-checked in code, and every one of those checks is attacked here.
//
// Run: npm run test:router
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createRouter } from '../src/router.mjs';
import { applyChargeSuccess } from '../src/payments.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  console.error(`  FAIL  ${m}`);
  failures++;
  process.exitCode = 1;
};
const ok = (cond, m) => (cond ? pass(m) : fail(m));

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// ── Fakes for the outside world ─────────────────────────────────────────────
// Nothing here reaches Paystack or WhatsApp. We assert on what the router TRIED
// to send, which is the part we own.
const sent = [];
const paystack = {
  initialize: async ({ reference, amount_cents }) => {
    sent.push({ kind: 'paystack', reference, amount_cents });
    return { authorization_url: `https://pay.test/${reference}`, reference };
  },
};
const messenger = {
  send: async ({ channel, to, text }) => {
    sent.push({ kind: 'message', channel, to, text });
    return { ok: true, id: `msg_${sent.length}` };
  },
  sendConfirmation: async ({ to, pkg }) => {
    sent.push({ kind: 'confirmation', to, guest_id: pkg.guest_id.guest_id_number });
    return { ok: true, id: 'conf_1' };
  },
  notifyOwner: async ({ to, pkg }) => {
    sent.push({ kind: 'owner', to, reference: pkg.booking.reference });
    return { ok: true, id: 'own_1' };
  },
  alertOwner: async ({ to, text }) => {
    sent.push({ kind: 'alert', to, text });
    return { ok: true, id: 'alert_1' };
  },
};

// ── A database that behaves exactly like production's ───────────────────────
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

const router = createRouter({ db, paystack, messenger });

// The dialled number is what tells Sena WHICH hotel she is answering for.
const DEMO_LINE = '+27101234567';
let callSeq = 0;
const newCall = () => ({
  providerCallId: `call_${++callSeq}`,
  dialedNumber: DEMO_LINE,
  fromNumber: '+27821234567',
});

console.log('\n  ── a real booking, end to end ──\n');

// ── 1. Intent + availability ────────────────────────────────────────────────
const call = newCall();
await router.handle('log_call_intent', { intent: 'new_booking', language: 'en' }, call);

const avail = await router.handle(
  'check_availability',
  { check_in: day(30), check_out: day(32), guests: 2 },
  call
);
ok(avail.ok && avail.rooms.length > 0, `check_availability → ${avail.rooms.length} rooms offered`);
ok(avail.rooms.length <= 3, 'never offers more than three rooms — the prompt says three, so we send three');
ok(avail.rooms[0].rate === 950, `cheapest first, in rand not cents (R${avail.rooms[0].rate})`);

// ── 2. Hold ─────────────────────────────────────────────────────────────────
const suite = avail.rooms.find((r) => r.name === 'Standard Double') || avail.rooms[0];
const held = await router.handle(
  'hold_room',
  { room_id: suite.room_id, check_in: day(30), check_out: day(32), guests_count: 2 },
  call
);
ok(held.ok && held.booking_id, `hold_room → ${held.reference} (R${held.total}, ${held.hold_minutes}min)`);

console.log('\n  ── the gates ──\n');

// ── GATE 1: the double-confirmation gate ────────────────────────────────────
// Sena is TOLD to read the block back twice. This proves that if she doesn't,
// the router refuses her anyway.
const notConfirmed = await router.handle(
  'save_guest_details',
  {
    booking_id: held.booking_id,
    full_name: 'Thabo Mokoena',
    phone: '+27821234567',
    email: 'thabo@example.com',
    guests_count: 2,
    double_confirmed: false,
  },
  call
);
ok(
  !notConfirmed.ok && notConfirmed.reason === 'not_double_confirmed',
  'save_guest_details REFUSED without double-confirmation'
);
const { rows: leaked } = await db.query(`select count(*)::int n from sena_guests`);
ok(leaked[0].n === 0, 'and nothing was written to sena_guests — the gate holds, it does not just warn');

// ── GATE 2: no payment link before a guest exists ───────────────────────────
const earlyLink = await router.handle('send_payment_link', { booking_id: held.booking_id }, call);
ok(
  !earlyLink.ok && earlyLink.reason === 'no_guest_yet',
  'send_payment_link REFUSED before the guest is saved'
);

// ── Now do it properly ──────────────────────────────────────────────────────
const saved = await router.handle(
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
ok(saved.ok, 'save_guest_details accepted once double-confirmed');

// ── GATE 3: no confirmation package on an unpaid booking ────────────────────
// This is the one that hands a guest a working QR code for a room they have not
// paid for.
const earlyPkg = await router.handle(
  'send_confirmation_package',
  { booking_id: held.booking_id },
  call
);
ok(
  !earlyPkg.ok && earlyPkg.reason === 'not_paid',
  'send_confirmation_package REFUSED on an unpaid booking'
);
const { rows: noIds } = await db.query(`select count(*)::int n from sena_guest_ids`);
ok(noIds[0].n === 0, 'and no guest ID was minted — no QR exists for an unpaid room');

console.log('\n  ── the money ──\n');

// ── 3. Payment link ─────────────────────────────────────────────────────────
const link = await router.handle(
  'send_payment_link',
  { booking_id: held.booking_id, channel: 'whatsapp' },
  call
);
ok(link.ok && link.total === held.total, `payment link sent for R${link.total} — the held total, not a new one`);

const { rows: payRows } = await db.query(
  `select provider_reference, amount_cents, status from sena_payments where booking_id = $1`,
  [held.booking_id]
);
ok(payRows.length === 1 && payRows[0].status === 'pending', 'a pending payment row exists');
ok(
  Number(payRows[0].amount_cents) === held.total * 100,
  'Paystack is billed in CENTS — the guest is charged R1,900, not R19'
);

const notPaidYet = await router.handle('check_payment_status', { booking_id: held.booking_id }, call);
ok(!notPaidYet.paid, 'check_payment_status says not paid — Sena may not confirm');

// ── GATE 4: underpayment ────────────────────────────────────────────────────
// A real, correctly-signed Paystack charge for the wrong amount is still wrong.
const ref = payRows[0].provider_reference;
const under = await applyChargeSuccess(db, {
  event: 'charge.success',
  data: { reference: ref, amount: 100 }, // R1 for a R1,900 room
});
ok(under.outcome === 'underpaid', 'a R1 charge for a R1,900 room is REFUSED as underpayment');

const { rows: stillPending } = await db.query(
  `select status from sena_bookings where id = $1`,
  [held.booking_id]
);
ok(stillPending[0].status !== 'confirmed', 'and the booking is NOT confirmed by an underpayment');

// ── 4. The real charge ──────────────────────────────────────────────────────
await db.query(`update sena_payments set status = 'pending' where booking_id = $1`, [
  held.booking_id,
]);
const charge = {
  event: 'charge.success',
  data: { reference: ref, amount: held.total * 100 },
};
const confirmed = await applyChargeSuccess(db, charge);
ok(confirmed.outcome === 'confirmed', `payment cleared → booking ${confirmed.reference} confirmed`);

// ── GATE 5: idempotency. Paystack retries. ──────────────────────────────────
const retry = await applyChargeSuccess(db, charge);
ok(retry.outcome === 'already_processed', 'a retried webhook is ignored — no double-confirm');

console.log('\n  ── the package ──\n');

const paid = await router.handle('check_payment_status', { booking_id: held.booking_id }, call);
ok(paid.paid, 'check_payment_status now says paid — Sena may confirm');

const pkg = await router.handle('send_confirmation_package', { booking_id: held.booking_id }, call);
ok(pkg.ok && pkg.guest_id_number, `confirmation package sent — guest ID ${pkg.guest_id_number}`);
ok(sent.some((s) => s.kind === 'owner'), 'the owner was notified on WhatsApp (§8)');

// One booking, one QR. A retried tool call must NOT mint a second valid ID.
const pkgAgain = await router.handle('send_confirmation_package', { booking_id: held.booking_id }, call);
ok(
  pkgAgain.guest_id_number === pkg.guest_id_number,
  'sending the package twice re-sends the SAME guest ID — never a second valid QR'
);
const { rows: idCount } = await db.query(`select count(*)::int n from sena_guest_ids`);
ok(idCount[0].n === 1, 'exactly one guest ID exists for this booking');

console.log('\n  ── what goes wrong on a real call ──\n');

// ── The last room goes while the guest is still talking ─────────────────────
// The Executive Suite is the fourth-cheapest, so check_availability deliberately
// does not offer it — Sena only ever hears three. Take its id straight from the
// database: hold_room must stand on its own guard, not on having been handed a
// room the availability call vetted.
const { rows: execRows } = await db.query(
  `select id, inventory from sena_rooms where name = 'Executive Suite'`
);
const exec = execRows[0];
ok(exec.inventory === 2, 'the Executive Suite has an inventory of two');

for (let i = 0; i < exec.inventory; i++) {
  const taken = await router.handle(
    'hold_room',
    { room_id: exec.id, check_in: day(60), check_out: day(62), guests_count: 2 },
    newCall()
  );
  ok(taken.ok, `suite ${i + 1} of ${exec.inventory} held (${taken.reference})`);
}

const gone = await router.handle(
  'hold_room',
  { room_id: exec.id, check_in: day(60), check_out: day(62), guests_count: 2 },
  newCall()
);
ok(
  !gone.ok && gone.reason === 'room_gone',
  'the last room going mid-call is reported honestly, not crashed on'
);
ok(/just gone/i.test(gone.say), 'and Sena is told what to SAY, not shown an error');

// ── Escalation ──────────────────────────────────────────────────────────────
const esc = await router.handle(
  'escalate_to_human',
  { reason: 'complaint', summary: 'Guest is upset about a charge on a previous stay.' },
  newCall()
);
ok(esc.ok && esc.transfer_to === '+27688529333', `escalation returns the hotel's human line (${esc.transfer_to})`);
ok(sent.some((s) => s.kind === 'alert'), 'and the owner is alerted on WhatsApp immediately');

// ── A tool that does not exist ──────────────────────────────────────────────
// The worst failure mode in the whole system: Vapi calls a tool we never built,
// we quietly return nothing, and Sena narrates a success to a real guest.
let threw = false;
try {
  await router.handle('refund_everything', {}, newCall());
} catch {
  threw = true;
}
ok(threw, 'an unknown tool THROWS — Sena can never narrate a success that did not happen');

// ── Cross-tenant ────────────────────────────────────────────────────────────
// Hotel B must never be one forged booking_id away from hotel A's guests.
await db.query(
  `insert into sena_hotels (name, phone, cancellation_policy, escalation_phone, escalation_whatsapp)
        values ('Other Hotel', '+27119999999', 'n/a', '+27110000000', '+27110000000')`
);
const { rows: other } = await db.query(`select id from sena_hotels where name = 'Other Hotel'`);
const foreign = createRouter({ db, paystack, messenger, defaultHotelId: other[0].id });
let blocked = false;
try {
  await foreign.handle(
    'send_confirmation_package',
    { booking_id: held.booking_id },
    { providerCallId: 'call_foreign', dialedNumber: '+27119999999', fromNumber: '+27800000000' }
  );
} catch {
  blocked = true;
}
ok(blocked, "another hotel cannot read this hotel's booking — tenancy holds in the router too");

console.log(
  failures === 0
    ? '\n  ── the booking path holds under attack ──\n'
    : `\n  ── ${failures} FAILING ──\n`
);

await db.close();
