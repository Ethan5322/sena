// ============================================================================
// Sena — what happens when money lands.
//
// Deliberately separated from the HTTP handler so it can be ATTACKED by the test
// suite: the underpayment check and the idempotency of confirmation are the two
// rules standing between the hotel and a free room, and rules that live inside a
// request handler are rules nobody ever tests.
//
// The handler's job is now only: verify the HMAC, then call this.
// ============================================================================

import crypto from 'node:crypto';
import { cents, toMajor } from './db.mjs';

// Same alphabet as the router: unambiguous down a phone line and on a scanner.
const SAFE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const code = (n) =>
  Array.from(crypto.randomBytes(n), (b) => SAFE_ALPHABET[b % SAFE_ALPHABET.length]).join('');

/**
 * Apply a Paystack `charge.success` event. Safe to call twice with the same
 * event — Paystack retries, and a retry must not re-confirm or re-issue.
 */
export async function applyChargeSuccess(db, event) {
  const reference = event.data?.reference;
  const paid = cents(event.data?.amount);

  const { rows } = await db.query(
    `select p.id as payment_id, p.amount_cents,
            b.id as booking_id, b.reference
       from sena_payments p
       join sena_bookings b on b.id = p.booking_id
      where p.provider_reference = $1`,
    [reference]
  );

  // Signed by Paystack, unknown to us. Never throw here: a 500 makes Paystack
  // retry forever. Acknowledge, and leave a loud line in the log for a human.
  if (!rows.length) return { ok: true, outcome: 'unknown_reference', reference };

  const row = rows[0];

  // A genuine, correctly-signed charge for the wrong amount is still the wrong
  // amount. Without this, a tampered link buys a R4,800 suite for one rand.
  if (paid < cents(row.amount_cents)) {
    await db.query(`update sena_payments set status = 'failed', raw = $1 where id = $2`, [
      event,
      row.payment_id,
    ]);
    return {
      ok: true,
      outcome: 'underpaid',
      reference,
      paid_cents: paid,
      owed_cents: cents(row.amount_cents),
    };
  }

  // Claim the payment. `status <> 'paid'` is the whole idempotency mechanism:
  // exactly one webhook delivery wins the race and does the work.
  const { rows: claimed } = await db.query(
    `update sena_payments
        set status = 'paid', paid_at = now(), raw = $1
      where id = $2 and status <> 'paid'
      returning id`,
    [event, row.payment_id]
  );

  if (!claimed.length) return { ok: true, outcome: 'already_processed', reference };

  // The hold can lapse while the guest is on the payment page — or overnight.
  // The money is real and we never refuse it, but the room may have been
  // RESOLD in the meantime. sena_confirm_paid_booking() re-checks availability
  // under the same lock the hold took: a late payment only confirms if the
  // room is truly still free; otherwise the outcome is paid_room_gone and a
  // human decides between refund and re-accommodation (the webhook alerts
  // them). Blindly confirming here is how one room gets two guests.
  const { rows: gate } = await db.query(`select * from sena_confirm_paid_booking($1)`, [
    row.booking_id,
  ]);

  return { ok: true, outcome: gate[0].outcome, reference: gate[0].reference || reference };
}

/**
 * Issue the confirmation package for a PAID booking: mint the single-use guest
 * ID (idempotently — one booking, one QR, ever), email the guest their
 * check-in code and card link, email the owner, and write every leg to the
 * ledger.
 *
 * TWO CALLERS, ONE PROMISE. The Paystack webhook calls this the moment money
 * lands, so the guest's code arrives AUTOMATICALLY even if the phone call is
 * already over. Sena's send_confirmation_package tool calls it too, mid-call.
 * Whoever runs second finds 'guest_confirmation' already in
 * sena_notifications_log and re-sends nothing — the guest gets exactly one
 * confirmation, and both callers get back the same guest ID number.
 *
 * Returns { ok, reference, guest_id_number, delivered, already? } or
 * { ok:false, reason } — it never throws for business reasons; the webhook
 * must stay a 200 no matter what.
 */
export async function issueConfirmationPackage(db, notifier, bookingReference, publicUrl = '') {
  const { rows } = await db.query(
    `select to_jsonb(b.*) as booking, to_jsonb(h.*) as hotel, to_jsonb(g.*) as guest
       from sena_bookings b
       join sena_hotels  h on h.id = b.hotel_id
  left join sena_guests  g on g.id = b.guest_id
      where b.reference = $1`,
    [bookingReference]
  );
  if (!rows.length) return { ok: false, reason: 'unknown_booking' };
  const { booking, hotel, guest } = rows[0];

  // The revenue gate, same as the router's: no package for an unpaid room.
  const { rows: paidRows } = await db.query(
    `select 1 from sena_payments where booking_id = $1 and status = 'paid' limit 1`,
    [booking.id]
  );
  if (!paidRows.length || booking.status !== 'confirmed') {
    return { ok: false, reason: 'not_paid' };
  }
  if (!guest) return { ok: false, reason: 'no_guest' };

  // One booking, one guest ID — the unique key makes a retry re-read, not re-mint.
  const { rows: minted } = await db.query(
    `insert into sena_guest_ids (booking_id, guest_id_number, verification_number)
          values ($1, $2, $3)
     on conflict (booking_id) do nothing
      returning *`,
    [booking.id, `${booking.reference}-${code(4)}`, code(12)]
  );
  const guestId = minted.length
    ? minted[0]
    : (await db.query(`select * from sena_guest_ids where booking_id = $1`, [booking.id])).rows[0];

  // Already confirmed once (the other caller won)? Same answer, no second email.
  const { rows: sentBefore } = await db.query(
    `select 1 from sena_notifications_log
      where booking_id = $1 and template = 'guest_confirmation' and status = 'sent' limit 1`,
    [booking.id]
  );
  if (sentBefore.length) {
    return {
      ok: true,
      already: true,
      reference: booking.reference,
      guest_id_number: guestId.guest_id_number,
      delivered: true,
    };
  }

  const pkg = {
    hotel,
    booking,
    guest,
    guest_id: guestId,
    total: toMajor(booking.total_cents),
    card_url: publicUrl
      ? `${publicUrl}/api/sena/card?v=${encodeURIComponent(guestId.verification_number)}`
      : null,
    confirmation_url: publicUrl
      ? `${publicUrl}/api/sena/confirmation?v=${encodeURIComponent(guestId.verification_number)}`
      : null,
  };

  const guestSend = await notifier.sendConfirmation({ to: guest.email, pkg });
  const ownerSend = await notifier.notifyOwner({ to: hotel.email, pkg });

  const legs = [
    [notifier.channel, guest.email, 'guest_confirmation', guestSend],
    [notifier.channel, hotel.email, 'owner_new_booking', ownerSend],
  ];
  if (ownerSend.whatsapp && !ownerSend.whatsapp.skipped) {
    legs.push(['whatsapp', hotel.escalation_whatsapp, 'owner_new_booking', ownerSend.whatsapp]);
  }
  for (const [channel, recipient, template, sent] of legs) {
    await db.query(
      `insert into sena_notifications_log
              (booking_id, channel, recipient, template, status, provider_message_id, error)
            values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        booking.id,
        channel,
        recipient || 'unknown',
        template,
        sent.ok ? 'sent' : 'failed',
        sent.id || null,
        sent.ok ? null : String(sent.error || 'send failed'),
      ]
    );
  }

  return {
    ok: true,
    reference: booking.reference,
    guest_id_number: guestId.guest_id_number,
    delivered: guestSend.ok,
  };
}

/**
 * The alarm bell: money arrived but the booking could NOT be confirmed —
 * the room was resold while the payment link sat unpaid, or the booking was
 * cancelled after the link went out. Sena never decides refunds (§3); this
 * hands the owner everything they need to, loudly, on both channels.
 */
export async function notifyPaymentProblem(db, notifier, bookingReference, outcome) {
  try {
    const { rows } = await db.query(
      `select b.id as booking_id, b.reference, b.check_in, b.check_out, b.total_cents,
              g.full_name, g.email, g.phone,
              r.name as room_name,
              h.name as hotel_name, h.email as hotel_email, h.escalation_whatsapp, h.currency
         from sena_bookings b
         join sena_rooms  r on r.id = b.room_id
         join sena_hotels h on h.id = b.hotel_id
    left join sena_guests g on g.id = b.guest_id
        where b.reference = $1`,
      [bookingReference]
    );
    if (!rows.length) return;
    const b = rows[0];
    const amount = `${b.currency} ${(Number(b.total_cents) / 100).toFixed(2)}`;
    const why =
      outcome === 'paid_room_gone'
        ? `The room was RESOLD while the payment link sat unpaid — the hold had lapsed.`
        : `The booking was CANCELLED before this payment arrived.`;

    const sent = await notifier.alertOwner({
      to: b.hotel_email,
      whatsappTo: b.escalation_whatsapp,
      subject: `⚠ Paid but NOT confirmed — ${amount} (${b.reference})`,
      text:
        `PAYMENT RECEIVED, BOOKING NOT CONFIRMED\n\n` +
        `${b.full_name || 'guest'} · ${b.phone || ''} · ${b.email || 'no email'}\n` +
        `${b.room_name} · ${b.check_in} → ${b.check_out}\n` +
        `${amount} · ${b.reference}\n\n` +
        `${why}\n\n` +
        `THE DECISION IS YOURS: refund, or offer another room/dates and confirm ` +
        `manually. The guest has NOT been told they are confirmed.`,
    });

    await db.query(
      `insert into sena_notifications_log (booking_id, channel, recipient, template, status)
            values ($1, $2, $3, 'owner_payment_problem', $4)`,
      [b.booking_id, notifier.channel, b.hotel_email || 'unknown', sent.ok ? 'sent' : 'failed']
    );
  } catch (err) {
    console.error('[sena] payment-problem alert failed:', err);
  }
}

/**
 * Tell the owner THE MOMENT money lands (CLAUDE.md §8) — WhatsApp first,
 * email as the record. Call this only when applyChargeSuccess() returned
 * outcome 'confirmed': that outcome fires exactly once per booking (the
 * status<>'paid' claim is the idempotency), so the owner is pinged exactly
 * once no matter how many times the gateway retries the webhook.
 *
 * Never throws — a webhook must acknowledge the money even if the owner's
 * phone is unreachable. Failures land in sena_notifications_log instead.
 */
export async function notifyPaymentLanded(db, notifier, bookingReference) {
  try {
    const { rows } = await db.query(
      `select b.id as booking_id, b.reference, b.check_in, b.check_out, b.total_cents,
              g.full_name, g.nationality,
              r.name as room_name,
              h.name as hotel_name, h.email as hotel_email,
              h.escalation_whatsapp, h.currency
         from sena_bookings b
         join sena_rooms  r on r.id = b.room_id
         join sena_hotels h on h.id = b.hotel_id
    left join sena_guests g on g.id = b.guest_id
        where b.reference = $1`,
      [bookingReference]
    );
    if (!rows.length) return;
    const b = rows[0];
    const amount = `${b.currency} ${(Number(b.total_cents) / 100).toFixed(2)}`;

    const sent = await notifier.alertOwner({
      to: b.hotel_email,
      whatsappTo: b.escalation_whatsapp,
      subject: `💰 Payment received — ${amount} (${b.reference})`,
      text:
        `PAYMENT RECEIVED\n\n` +
        `${b.full_name || 'guest'} · ${b.nationality || 'nationality not given'}\n` +
        `${b.room_name}\n${b.check_in} → ${b.check_out}\n` +
        `${amount} · ${b.reference}\n\n` +
        `The booking is confirmed; the guest's documents are on their way.`,
    });

    for (const [channel, leg] of [
      ['email', sent],
      ['whatsapp', sent.whatsapp],
    ]) {
      if (!leg || leg.skipped) continue; // unconfigured is a state, not a failure
      await db.query(
        `insert into sena_notifications_log
                (booking_id, channel, recipient, template, status, provider_message_id, error)
              values ($1, $2, $3, 'owner_payment_received', $4, $5, $6)`,
        [
          b.booking_id,
          channel,
          channel === 'whatsapp' ? b.escalation_whatsapp : b.hotel_email || 'unknown',
          leg.ok ? 'sent' : 'failed',
          leg.id || null,
          leg.ok ? null : String(leg.error || 'send failed'),
        ]
      );
    }
  } catch (err) {
    console.error('[sena] payment-landed alert failed:', err);
  }
}
