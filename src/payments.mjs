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

import { cents } from './db.mjs';

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

  // The hold can lapse while the guest is on the payment page. The money is
  // real and we do not refuse it — but the room may have been resold in the
  // meantime, so `expired` is confirmable here and the owner is told.
  const { rows: confirmed } = await db.query(
    `update sena_bookings
        set status = 'confirmed', hold_expires_at = null
      where id = $1 and status in ('pending', 'expired')
      returning reference`,
    [row.booking_id]
  );

  if (!confirmed.length) return { ok: true, outcome: 'paid_but_not_confirmable', reference };

  return { ok: true, outcome: 'confirmed', reference: confirmed[0].reference };
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
