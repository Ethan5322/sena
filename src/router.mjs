// ============================================================================
// Sena — the tool router
//
// Sena's ten tools (voice-agent/vapi-config.json) all post to one endpoint.
// This is the other side of that wire: it routes on the tool name, talks to
// Postgres, and hands back a result the model can say out loud.
//
// THE ROUTER IS THE LAST LINE OF DEFENCE.
//
// The system prompt tells Sena not to save an unconfirmed guest and not to
// confirm an unpaid booking. But a prompt is a request, not a guarantee — an
// LLM under pressure from a persuasive caller will eventually call the tool
// anyway. So every rule in the prompt that MATTERS is re-checked here, in code,
// where it cannot be talked out of it:
//
//   * save_guest_details          refuses unless double_confirmed is true
//   * save_guest_details          refuses once the hold has lapsed
//   * send_payment_link           refuses before the guest is saved
//   * send_confirmation_package   refuses unless the money actually landed
//
// Each of those refusals is a test in scripts/test-router.mjs. If you relax one,
// a test fails. That is the point.
//
// Every tool returns a plain object. `ok: false` is a normal, expected outcome
// (the room went, the hold lapsed) and carries a `say` line — the honest thing
// for Sena to tell the guest. It is not an error. Errors are thrown, and the
// prompt's rule for an error is: do not explain it, escalate.
// ============================================================================

import crypto from 'node:crypto';
import { cents, toMajor } from './db.mjs';

export class ToolError extends Error {}

// Unambiguous down a phone line and on a scanner: no 0/O, no 1/I/L.
const SAFE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const code = (n) =>
  Array.from(crypto.randomBytes(n), (b) => SAFE_ALPHABET[b % SAFE_ALPHABET.length]).join('');

const digitsOnly = (s) => (s || '').replace(/[^\d]/g, '');

export function createRouter({
  db,
  paystack,
  messenger,
  defaultHotelId = null,
  // Where the guest's ID card is served from. Without it the WhatsApp message
  // carries a number the guest cannot show to a scanner.
  publicUrl = process.env.SENA_PUBLIC_URL || '',
}) {
  // ── Session ───────────────────────────────────────────────────────────────
  // A call row exists from the moment the phone rings (CLAUDE.md §2 stage 1),
  // before we know anything about the caller. Every later row hangs off it.

  async function resolveHotelId(dialedNumber) {
    const dialed = digitsOnly(dialedNumber);
    if (dialed) {
      // Match on digits, so +27 10 123 4567 and +27101234567 are the same hotel.
      const { rows } = await db.query(
        `select id from sena_hotels
          where regexp_replace(phone, '[^0-9]', '', 'g') = $1
          limit 1`,
        [dialed]
      );
      if (rows.length) return rows[0].id;
    }
    if (defaultHotelId) return defaultHotelId;
    throw new ToolError(
      `no hotel is mapped to the dialled number ${dialedNumber || '(none)'} — ` +
        `set SENA_DEFAULT_HOTEL_ID or fix sena_hotels.phone`
    );
  }

  /** Upsert the call row. Safe to call on every tool invocation. */
  async function session(ctx) {
    if (ctx._session) return ctx._session;

    const hotelId = await resolveHotelId(ctx.dialedNumber);
    const { rows } = await db.query(
      `insert into sena_calls (hotel_id, provider_call_id, from_number)
            values ($1, $2, $3)
       on conflict (provider_call_id) do update
              set from_number = coalesce(excluded.from_number, sena_calls.from_number)
        returning id, hotel_id`,
      [hotelId, ctx.providerCallId, ctx.fromNumber || null]
    );

    const { rows: h } = await db.query(`select * from sena_hotels where id = $1`, [hotelId]);
    ctx._session = { callId: rows[0].id, hotelId, hotel: h[0] };
    return ctx._session;
  }

  /** Load a booking and refuse to touch one belonging to another hotel. */
  async function bookingFor(bookingId, hotelId) {
    const { rows } = await db.query(
      `select * from sena_bookings where id = $1 and hotel_id = $2`,
      [bookingId, hotelId]
    );
    if (!rows.length) throw new ToolError(`unknown booking ${bookingId}`);
    return rows[0];
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  async function log_call_intent(args, ctx) {
    const s = await session(ctx);
    await db.query(
      `update sena_calls set intent = $1::sena_call_intent, language = $2 where id = $3`,
      [args.intent, args.language, s.callId]
    );
    return { ok: true };
  }

  async function check_availability(args, ctx) {
    const s = await session(ctx);
    const { rows } = await db.query(
      `select * from sena_check_availability($1, $2::date, $3::date, $4)`,
      [s.hotelId, args.check_in, args.check_out, args.guests ?? 1]
    );

    if (!rows.length) {
      return {
        ok: true,
        rooms: [],
        say:
          `Nothing is free for those dates. Offer to check different dates — ` +
          `do not invent an alternative.`,
      };
    }

    // Sena is told never to read more than three options aloud, so we hand her
    // three. Sending ten and trusting her to stop at three is how a guest ends
    // up listening to a menu.
    return {
      ok: true,
      nights: rows[0].nights,
      rooms: rows.slice(0, 3).map((r) => ({
        room_id: r.room_id,
        name: r.name,
        plan: r.plan,
        rate: toMajor(r.rate_cents),
        total: toMajor(r.total_cents),
        currency: s.hotel.currency,
        sleeps: r.capacity,
        free: r.free_units,
        amenities: (r.amenities || []).slice(0, 3),
      })),
    };
  }

  async function hold_room(args, ctx) {
    const s = await session(ctx);
    try {
      const { rows } = await db.query(
        `select * from sena_hold_room($1, $2, $3::date, $4::date, $5, $6)`,
        [s.hotelId, args.room_id, args.check_in, args.check_out, args.guests_count, s.callId]
      );
      const b = rows[0];
      return {
        ok: true,
        booking_id: b.booking_id,
        reference: b.reference,
        total: toMajor(b.total_cents),
        currency: s.hotel.currency,
        hold_minutes: s.hotel.hold_minutes,
        hold_expires_at: b.hold_expires_at,
      };
    } catch (err) {
      // sena_hold_room raises check_violation when the last room went while the
      // guest was still talking. That is not a bug — it is the lock doing its
      // job, and it is the one failure Sena must relay honestly.
      if (err.code === '23514' || /no availability/i.test(err.message)) {
        return {
          ok: false,
          reason: 'room_gone',
          say: `That room has just gone. Tell the guest honestly and check availability again.`,
        };
      }
      throw err;
    }
  }

  // The double-confirmation gate (CLAUDE.md §2 stage 6). The most important
  // checkpoint in the journey: a wrong digit here means the guest never
  // receives their booking, and we would not find out until they arrived.
  async function save_guest_details(args, ctx) {
    const s = await session(ctx);

    if (args.double_confirmed !== true) {
      return {
        ok: false,
        reason: 'not_double_confirmed',
        say:
          `Not saved. Read the whole block back to the guest — name, phone, email, ` +
          `nationality, guest count — and get one more confirmation before saving.`,
      };
    }

    const booking = await bookingFor(args.booking_id, s.hotelId);

    // The hold can lapse mid-call if the guest went to find their ID. Writing a
    // guest against a dead hold produces a booking the room is no longer kept
    // for — the guest hears "confirmed" and arrives to no room.
    if (booking.status !== 'pending') {
      return {
        ok: false,
        reason: `booking_${booking.status}`,
        say: `That booking is no longer being held. Start again from availability.`,
      };
    }
    if (booking.hold_expires_at && new Date(booking.hold_expires_at) <= new Date()) {
      return {
        ok: false,
        reason: 'hold_expired',
        say: `The hold has lapsed. Apologise, re-check availability, and hold it again.`,
      };
    }

    const { rows: g } = await db.query(
      `insert into sena_guests (hotel_id, full_name, phone, email, nationality, notes)
            values ($1, $2, $3, $4, $5, $6)
        returning id`,
      [
        s.hotelId,
        args.full_name,
        args.phone,
        args.email || null,
        args.nationality || null,
        args.special_requests || null,
      ]
    );

    await db.query(
      `update sena_bookings
          set guest_id         = $1,
              guests_count     = coalesce($2, guests_count),
              arrival_time     = coalesce($3::time, arrival_time),
              special_requests = coalesce($4, special_requests),
              needs_approval   = coalesce($5, needs_approval)
        where id = $6`,
      [
        g[0].id,
        args.guests_count ?? null,
        args.arrival_time || null,
        args.special_requests || null,
        args.needs_approval ?? null,
        booking.id,
      ]
    );

    return { ok: true, guest_id: g[0].id, reference: booking.reference };
  }

  async function send_payment_link(args, ctx) {
    const s = await session(ctx);
    const booking = await bookingFor(args.booking_id, s.hotelId);

    // No guest, no payment. The Paystack receipt and the confirmation both need
    // somewhere to go, and a payment against an anonymous booking is unmatchable
    // when it lands.
    if (!booking.guest_id) {
      return {
        ok: false,
        reason: 'no_guest_yet',
        say: `Take the guest's details first, and confirm them, before sending the link.`,
      };
    }

    const { rows: g } = await db.query(`select * from sena_guests where id = $1`, [
      booking.guest_id,
    ]);
    const guest = g[0];

    if (!guest.email) {
      return {
        ok: false,
        reason: 'no_email',
        say: `Ask the guest for an email address — the payment receipt needs one.`,
      };
    }

    // A fresh gateway reference per attempt: a retried link must never collide
    // with the abandoned one, or the webhook cannot tell which attempt paid.
    const reference = `${booking.reference}-${code(4)}`;
    const amount = cents(booking.total_cents);

    const { authorization_url } = await paystack.initialize({
      reference,
      amount_cents: amount,
      currency: s.hotel.currency,
      email: guest.email,
      metadata: { booking_id: booking.id, hotel_id: s.hotelId, reference: booking.reference },
    });

    await db.query(
      `insert into sena_payments (booking_id, provider, provider_reference, amount_cents, currency, status)
            values ($1, 'paystack', $2, $3, $4, 'pending')`,
      [booking.id, reference, amount, s.hotel.currency]
    );

    const channel = args.channel || 'whatsapp';
    const text =
      `${s.hotel.name} — booking ${booking.reference}\n` +
      `${s.hotel.currency} ${toMajor(amount).toFixed(2)} to confirm your room.\n` +
      `Pay securely here: ${authorization_url}\n` +
      `This link holds your room for ${s.hotel.hold_minutes} minutes.`;

    const sent = await messenger.send({ channel, to: guest.phone, text });

    await db.query(
      `insert into sena_notifications_log
              (booking_id, channel, recipient, template, status, provider_message_id, error)
            values ($1, $2, $3, 'payment_link', $4, $5, $6)`,
      [
        booking.id,
        channel,
        guest.phone,
        sent.ok ? 'sent' : 'failed',
        sent.id || null,
        sent.ok ? null : String(sent.error || 'send failed'),
      ]
    );

    if (!sent.ok) {
      return {
        ok: false,
        reason: 'link_not_delivered',
        say: `The link did not go through. Offer to try SMS instead, or escalate.`,
      };
    }

    return {
      ok: true,
      total: toMajor(amount),
      currency: s.hotel.currency,
      channel,
      hold_minutes: s.hotel.hold_minutes,
    };
  }

  async function check_payment_status(args, ctx) {
    const s = await session(ctx);
    const booking = await bookingFor(args.booking_id, s.hotelId);

    const { rows } = await db.query(
      `select status from sena_payments
        where booking_id = $1
        order by (status = 'paid') desc, created_at desc
        limit 1`,
      [booking.id]
    );

    const status = rows.length ? rows[0].status : 'pending';
    const paid = status === 'paid';

    return {
      ok: true,
      paid,
      status,
      booking_status: booking.status,
      say: paid
        ? `Paid. You may now confirm the booking and send the package.`
        : `Not paid yet. Do NOT tell the guest they are confirmed.`,
    };
  }

  // The gate that protects the hotel's revenue: a confirmation package is proof
  // of a paid stay. Issuing one on an unpaid hold hands a guest a valid QR code
  // that opens a room they have not paid for.
  async function send_confirmation_package(args, ctx) {
    const s = await session(ctx);
    const booking = await bookingFor(args.booking_id, s.hotelId);

    const { rows: paidRows } = await db.query(
      `select 1 from sena_payments where booking_id = $1 and status = 'paid' limit 1`,
      [booking.id]
    );

    if (!paidRows.length || booking.status !== 'confirmed') {
      return {
        ok: false,
        reason: 'not_paid',
        say:
          `That booking is not paid, so it is not confirmed. Do not tell the guest ` +
          `it is. Keep waiting on the payment, or escalate.`,
      };
    }

    const { rows: g } = await db.query(`select * from sena_guests where id = $1`, [
      booking.guest_id,
    ]);
    const guest = g[0];

    // One booking, one guest ID — enforced by the unique key on booking_id, so a
    // retried tool call re-sends the SAME id rather than minting a second valid
    // QR for the same stay.
    const { rows: idRows } = await db.query(
      `insert into sena_guest_ids (booking_id, guest_id_number, verification_number)
            values ($1, $2, $3)
       on conflict (booking_id) do nothing
        returning *`,
      [booking.id, `${booking.reference}-${code(4)}`, code(12)]
    );

    const guestId = idRows.length
      ? idRows[0]
      : (await db.query(`select * from sena_guest_ids where booking_id = $1`, [booking.id])).rows[0];

    const pkg = {
      hotel: s.hotel,
      booking,
      guest,
      guest_id: guestId,
      total: toMajor(booking.total_cents),
      // The card itself (§7). The QR lives on this page; the guest opens it at
      // the desk and shows the screen.
      card_url: publicUrl
        ? `${publicUrl}/api/sena/card?v=${encodeURIComponent(guestId.verification_number)}`
        : null,
    };

    const guestSend = await messenger.sendConfirmation({ to: guest.phone, email: guest.email, pkg });
    const ownerSend = await messenger.notifyOwner({ to: s.hotel.escalation_whatsapp, pkg });

    for (const [recipient, template, sent] of [
      [guest.phone, 'guest_confirmation', guestSend],
      [s.hotel.escalation_whatsapp, 'owner_new_booking', ownerSend],
    ]) {
      await db.query(
        `insert into sena_notifications_log
                (booking_id, channel, recipient, template, status, provider_message_id, error)
              values ($1, 'whatsapp', $2, $3, $4, $5, $6)`,
        [
          booking.id,
          recipient,
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

  async function lookup_booking(args, ctx) {
    const s = await session(ctx);
    const { rows } = await db.query(
      `select b.reference, b.check_in, b.check_out, b.status, b.total_cents,
              r.name as room, g.full_name as guest_name
         from sena_bookings b
         join sena_rooms  r on r.id = b.room_id
    left join sena_guests g on g.id = b.guest_id
        where b.hotel_id = $1
          and b.status <> 'expired'
          and ( ($2::text is not null and upper(b.reference) = upper($2))
             or ($3::text is not null and regexp_replace(g.phone, '[^0-9]', '', 'g')
                                        = regexp_replace($3, '[^0-9]', '', 'g')) )
        order by b.created_at desc
        limit 3`,
      [s.hotelId, args.reference || null, args.phone || null]
    );

    if (!rows.length) {
      return { ok: true, found: false, say: `No booking found. Ask them to read the reference again.` };
    }

    return {
      ok: true,
      found: true,
      bookings: rows.map((b) => ({
        reference: b.reference,
        guest_name: b.guest_name,
        room: b.room,
        check_in: b.check_in,
        check_out: b.check_out,
        status: b.status,
        total: toMajor(b.total_cents),
      })),
    };
  }

  async function escalate_to_human(args, ctx) {
    const s = await session(ctx);

    await db.query(
      `update sena_calls
          set escalated = true, escalation_reason = $1, outcome = 'escalated'
        where id = $2`,
      [args.reason, s.callId]
    );

    await messenger.alertOwner({
      to: s.hotel.escalation_whatsapp,
      text:
        `SENA — call needs a person.\n` +
        `Reason: ${args.reason}\n` +
        `Caller: ${ctx.fromNumber || 'unknown'}\n` +
        `${args.summary}`,
    });

    // Vapi performs the transfer; the router only says where to.
    return { ok: true, transfer_to: s.hotel.escalation_phone };
  }

  async function end_call(args, ctx) {
    const s = await session(ctx);
    await db.query(
      `update sena_calls
          set outcome  = coalesce(outcome, $1),
              ended_at = now()
        where id = $2`,
      [args.outcome, s.callId]
    );
    return { ok: true };
  }

  const tools = {
    log_call_intent,
    check_availability,
    hold_room,
    save_guest_details,
    send_payment_link,
    check_payment_status,
    send_confirmation_package,
    lookup_booking,
    escalate_to_human,
    end_call,
  };

  return {
    /** Run one tool call. Throws ToolError for anything Sena should escalate on. */
    async handle(name, args, ctx) {
      const fn = tools[name];
      // A tool Vapi knows about but we do not is the worst possible failure: the
      // model would narrate a success that never happened. Fail loudly.
      if (!fn) throw new ToolError(`unknown tool: ${name}`);
      return fn(args ?? {}, ctx);
    },

    /** Vapi's end-of-call report. Consent to record is stated in the greeting (§9). */
    async saveTranscript({ providerCallId, transcript, outcome }) {
      await db.query(
        `update sena_calls
            set transcript = coalesce($1, transcript),
                outcome    = coalesce(outcome, $2),
                ended_at   = coalesce(ended_at, now())
          where provider_call_id = $3`,
        [transcript || null, outcome || null, providerCallId]
      );
    },

    toolNames: Object.keys(tools),
  };
}
