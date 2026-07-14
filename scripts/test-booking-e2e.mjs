// ============================================================================
// A whole booking, over HTTP, exactly as the voice agent makes it.
//
// The other suites attack the router by calling it directly. This one refuses to:
// it starts the dev server, and then speaks to it the way voice-agent/agent/
// speaks to it — a POST per tool, with the shared secret, over the wire, through
// the envelope. Everything between the model and the money is exercised for real.
//
// WHAT THIS CATCHES THAT THE OTHERS CANNOT. The unit tests hold the router to its
// contract. They cannot tell you the ENDPOINT is wrong: that the secret header is
// spelled differently on the two sides, that the envelope lost a field, that
// hotel_id never reaches resolveHotelId, that a tool result comes back in a shape
// the model cannot read. Every one of those is a bug that passes `npm test` and
// fails on a call to a real guest.
//
// It is the closest thing to a phone call that does not need a microphone.
//
// Run: npm run test:e2e
// ============================================================================

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'demo-secret';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, detail) => {
  console.error(`  FAIL  ${m}${detail ? `\n        ${detail}` : ''}`);
  failures++;
};
const ok = (cond, m, detail) => (cond ? pass(m) : fail(m, detail));

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// ── The call ────────────────────────────────────────────────────────────────
// One room, one guest, one conversation. The room name IS the call id, exactly
// as bot.py builds it.
const CALL = { id: `sena-e2e-${Date.now()}`, hotel_id: null };

/** Exactly what SenaClient.call_tool does, in Python, on a real call. */
async function tool(name, args = {}) {
  const res = await fetch(`${BASE}/api/sena/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sena-secret': SECRET },
    body: JSON.stringify({ type: 'tool-call', tool: name, args, call: CALL }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${name} → HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body.result;
}

// ── Boot the server the same way a developer does ───────────────────────────
const server = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATABASE_URL: '', SENA_WEBHOOK_SECRET: SECRET },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const die = (msg) => {
  console.error(`\n${msg}\n\n--- server log ---\n${serverLog}`);
  server.kill();
  process.exit(1);
};

// PGlite has to apply the whole install before it can answer anything.
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/sena/tool`, { method: 'POST' });
      if (res.status === 401 || res.status === 400) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  die('dev server never came up');
}

console.log('\na whole booking, over HTTP, as the agent makes it\n');
await waitForServer();

// The hotel the demo server seeded. bot.py gets this from /api/sena/hotel, so we
// do too — that endpoint is part of what is under test.
const hotelRes = await fetch(`${BASE}/api/sena/hotel`, { headers: { 'x-sena-secret': SECRET } });
const hotel = await hotelRes.json();
ok(hotelRes.status === 200, 'the agent can fetch the hotel it is answering for');
CALL.hotel_id = hotel.hotel_id;

// Every {{...}} in system-prompt.md must be here, or Sena reads the braces aloud.
const NEEDED = ['hotel_name', 'currency', 'check_in_time', 'check_out_time',
                'hold_minutes', 'cancellation_policy', 'early_late_policy', 'today'];
const missing = NEEDED.filter((k) => !hotel.prompt_vars?.[k]);
ok(missing.length === 0, 'every prompt placeholder has a value', `missing: ${missing.join(', ')}`);

try {
  // ── Stage 3: why did they call ─────────────────────────────────────────────
  const intent = await tool('log_call_intent', { intent: 'new_booking', language: 'en' });
  ok(intent.ok, 'the call is logged against the right hotel');

  // ── Stage 4: what is free ─────────────────────────────────────────────────
  const avail = await tool('check_availability', {
    check_in: day(30), check_out: day(32), guests: 2,
  });
  ok(avail.ok && avail.rooms.length > 0, `rooms come back with real rates (${avail.rooms?.length} offered)`);
  ok(avail.rooms.length <= 3, 'never more than three, so Sena does not read a menu');

  const room = avail.rooms[0];
  ok(typeof room.rate === 'number' && room.rate > 0, `a rate Sena can say out loud (${room.currency} ${room.rate})`);

  // ── Stage 4: hold it ──────────────────────────────────────────────────────
  const held = await tool('hold_room', {
    room_id: room.room_id, check_in: day(30), check_out: day(32), guests_count: 2,
  });
  ok(held.ok && held.booking_id, `the room is held (${held.reference})`);
  const booking_id = held.booking_id;

  // ── THE GATE: no guest without double-confirmation ────────────────────────
  const notConfirmed = await tool('save_guest_details', {
    booking_id, full_name: 'Thandi Mokoena', phone: '+27821234567',
    email: 'thandi@example.com', guests_count: 2, double_confirmed: false,
  });
  ok(!notConfirmed.ok && notConfirmed.reason === 'not_double_confirmed',
     'a guest who was not double-confirmed is REFUSED — over HTTP, not just in a unit test');
  ok(/read the whole block back/i.test(notConfirmed.say || ''),
     'and Sena is told what to say, not shown an error');

  // ── THE GATE: no payment link before a guest exists ───────────────────────
  const early = await tool('send_payment_link', { booking_id });
  ok(!early.ok && early.reason === 'no_guest_yet', 'no payment link before the guest is saved');

  // ── Stage 6: now properly confirmed ───────────────────────────────────────
  const saved = await tool('save_guest_details', {
    booking_id, full_name: 'Thandi Mokoena', phone: '+27821234567',
    email: 'thandi@example.com', nationality: 'South African',
    guests_count: 2, arrival_time: '15:30', double_confirmed: true,
  });
  ok(saved.ok && saved.guest_id, 'double-confirmed, so the guest is saved');

  // ── Stage 7: the money ────────────────────────────────────────────────────
  const link = await tool('send_payment_link', { booking_id });
  ok(link.ok && link.sent_to === 'thandi@example.com', `the payment link is emailed (${link.currency} ${link.total})`);

  const unpaid = await tool('check_payment_status', { booking_id });
  ok(unpaid.ok && unpaid.paid === false, 'and it is not paid yet');

  // ── THE GATE: no confirmation on an unpaid booking ────────────────────────
  const premature = await tool('send_confirmation_package', { booking_id });
  ok(!premature.ok && premature.reason === 'not_paid',
     'an UNPAID booking cannot be confirmed — no QR code for a room nobody paid for');

  // ── The guest pays ────────────────────────────────────────────────────────
  // Straight through applyChargeSuccess, the same function the signed Paystack
  // webhook calls.
  const payRef = serverLog.match(/\/demo\/pay\?ref=([A-Za-z0-9\-]+)/)?.[1];
  ok(!!payRef, 'the payment link is real enough to click');
  const payRes = await fetch(`${BASE}/demo/pay?ref=${payRef}`);
  ok(payRes.status === 200, 'the guest pays');

  const paid = await tool('check_payment_status', { booking_id });
  ok(paid.ok && paid.paid === true && paid.booking_status === 'confirmed',
     'the money landed, and ONLY now is the booking confirmed');

  // ── Stage 8/9: the package ────────────────────────────────────────────────
  const pkg = await tool('send_confirmation_package', { booking_id });
  ok(pkg.ok && pkg.guest_id_number, `the QR guest ID is issued (${pkg.guest_id_number})`);

  // A retried tool call must not mint a second valid QR for the same stay.
  const again = await tool('send_confirmation_package', { booking_id });
  ok(again.ok && again.guest_id_number === pkg.guest_id_number,
     'calling it twice re-sends the SAME id — no second valid QR');

  // ── Stage 12: they call back and cancel ───────────────────────────────────
  const found = await tool('lookup_booking', { reference: held.reference });
  ok(found.ok && found.found, 'a guest calling back is found by reference');

  const cancelled = await tool('cancel_booking', {
    reference: held.reference, reason: 'work trip moved',
  });
  ok(cancelled.ok && cancelled.was_paid === true, 'the booking cancels, and it knows money was taken');
  ok(typeof cancelled.policy === 'string' && cancelled.policy.length > 0,
     'and Sena is handed the cancellation policy to read VERBATIM');
  ok(/do not promise a refund/i.test(cancelled.say || ''),
     'and told not to promise a refund — that is a human decision');

  // ── Wrap up ───────────────────────────────────────────────────────────────
  const ended = await tool('end_call', { outcome: 'booked' });
  ok(ended.ok, 'the call ends cleanly');

  // ── The one the model must never get away with ────────────────────────────
  const ghost = await tool('drop_all_tables');
  ok(!ghost.ok && /wrong on our side/i.test(ghost.say || ''),
     'a tool that does not exist is refused, and Sena escalates rather than inventing a success');

} catch (err) {
  fail('the conversation threw', err.message);
}

console.log(
  failures
    ? `\n${failures} failed\n`
    : `\nthe whole booking path works over HTTP — the wire the agent speaks on\n`
);

// Shut the child down and let Node exit on its own. Calling process.exit() here
// tears the event loop down while the child's stdio pipes are still closing, and
// libuv aborts on Windows — which turns a passing suite into exit code 127. A
// test that reports failure when it passed is worse than no test.
process.exitCode = failures ? 1 : 0;
await new Promise((resolve) => {
  server.once('exit', resolve);
  server.kill();
  setTimeout(resolve, 3000).unref?.();
});
