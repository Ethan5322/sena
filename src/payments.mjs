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
