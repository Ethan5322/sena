// ============================================================================
// Sena — the work nobody is on the phone for.
//
// CLAUDE.md §2 stages 10 and 13, and §8: the pre-arrival reminder, the daily
// arrivals list for the owner, and the stay that quietly finishes. None of it
// involves a guest on a call, so none of it happens unless something wakes up
// and does it. That something is api/sena/cron.mjs, once a day.
//
// Separated from the HTTP handler for the same reason payments.mjs is: a job
// that can only be run by a cron trigger is a job nobody ever tests, and these
// touch every booking in the database.
//
// EVERY STEP IS IDEMPOTENT. A cron that fires twice — a retry, a redeploy, a
// human clicking "run now" — must not email the same guest twice or double-count
// a night's revenue. sena_notifications_log is the ledger that makes that true:
// before sending, we ask whether we already did.
// ============================================================================

import { toMajor } from './db.mjs';

/** Have we already sent this template for this booking? The ledger decides. */
async function alreadySent(db, bookingId, template) {
  const { rows } = await db.query(
    `select 1 from sena_notifications_log
      where booking_id = $1 and template = $2 and status = 'sent' limit 1`,
    [bookingId, template]
  );
  return rows.length > 0;
}

async function logSent(db, bookingId, channel, recipient, template, sent) {
  await db.query(
    `insert into sena_notifications_log
            (booking_id, channel, recipient, template, status, provider_message_id, error)
          values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      bookingId,
      channel,
      recipient || 'unknown',
      template,
      sent.ok ? 'sent' : 'failed',
      sent.id || null,
      sent.ok ? null : String(sent.error || 'send failed'),
    ]
  );
}

export async function runDailyJobs(db, notifier) {
  const result = { expired: 0, completed: 0, reminded: 0, summaries: 0 };

  // ── 1. Abandoned holds ────────────────────────────────────────────────────
  // Availability already ignores a lapsed hold, so no room was ever lost. But
  // leaving them 'pending' forever means the owner's report counts every
  // abandoned call as a live booking.
  const { rows: exp } = await db.query(`select sena_expire_stale_holds() as n`);
  result.expired = Number(exp[0].n);

  // ── 2. Stays that ended ───────────────────────────────────────────────────
  // A guest who checked in and whose check-out date has passed has completed
  // their stay (§2 stage 13). Nothing else in the system ever sets this, so
  // without it every past guest looks like they are still in the building.
  const { rows: comp } = await db.query(
    `update sena_bookings
        set status = 'completed'
      where status = 'checked_in'
        and check_out < current_date
      returning id`
  );
  result.completed = comp.length;

  // ── 3. Pre-arrival reminders (§2 stage 10) ────────────────────────────────
  const { rows: arriving } = await db.query(
    `select b.id, b.reference, b.check_in, b.check_out,
            g.full_name, g.email,
            r.name as room_name,
            gi.verification_number,
            to_jsonb(h.*) as hotel
       from sena_bookings b
       join sena_hotels  h on h.id = b.hotel_id
       join sena_rooms   r on r.id = b.room_id
       join sena_guests  g on g.id = b.guest_id
  left join sena_guest_ids gi on gi.booking_id = b.id
      where b.status = 'confirmed'
        and b.check_in = current_date + 1
        and g.email is not null`
  );

  for (const b of arriving) {
    if (await alreadySent(db, b.id, 'pre_arrival')) continue;
    const sent = await notifier.sendPreArrival({ to: b.email, booking: b, hotel: b.hotel });
    await logSent(db, b.id, notifier.channel, b.email, 'pre_arrival', sent);
    if (sent.ok) result.reminded++;
  }

  // ── 4. The owner's morning list (§8) ──────────────────────────────────────
  // One email per hotel, not per booking. An owner with eight arrivals wants one
  // list, not eight notifications.
  const { rows: hotels } = await db.query(
    `select * from sena_hotels where email is not null`
  );

  for (const hotel of hotels) {
    const { rows: arrivals } = await db.query(
      `select b.reference, b.arrival_time, b.guests_count, b.needs_approval,
              b.special_requests, g.full_name, r.name as room_name
         from sena_bookings b
         join sena_rooms  r on r.id = b.room_id
    left join sena_guests g on g.id = b.guest_id
        where b.hotel_id = $1
          and b.status = 'confirmed'
          and b.check_in = current_date
        order by b.arrival_time nulls last`,
      [hotel.id]
    );

    const { rows: departures } = await db.query(
      `select b.reference, g.full_name, r.name as room_name
         from sena_bookings b
         join sena_rooms  r on r.id = b.room_id
    left join sena_guests g on g.id = b.guest_id
        where b.hotel_id = $1
          and b.status = 'checked_in'
          and b.check_out = current_date`,
      [hotel.id]
    );

    // Money that arrived yesterday. The one number an owner actually opens the
    // email for.
    const { rows: rev } = await db.query(
      `select coalesce(sum(p.amount_cents), 0) as cents, count(*)::int as n
         from sena_payments p
         join sena_bookings b on b.id = p.booking_id
        where b.hotel_id = $1
          and p.status = 'paid'
          and p.paid_at >= current_date - 1
          and p.paid_at <  current_date`,
      [hotel.id]
    );

    // Nothing happening is worth saying once, not never — an owner who gets no
    // email cannot tell "quiet day" from "the system is down".
    const sent = await notifier.sendDailySummary({
      to: hotel.email,
      hotel,
      arrivals,
      departures,
      revenue: { total: toMajor(rev[0].cents), count: rev[0].n },
    });
    if (sent.ok) result.summaries++;
  }

  return result;
}
