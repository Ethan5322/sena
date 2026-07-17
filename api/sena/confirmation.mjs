// ============================================================================
// GET /api/sena/confirmation?v=<verification_number> — the Booking Confirmation
// document (CLAUDE.md §7, document 1). The printable proof of a paid stay.
//
// Same credential as the card: the verification_number in the URL. Same privacy
// rules too — it shows a guest's name, phone and nationality, so no indexing
// and no shared caching (POPIA, §9).
//
// One deliberate difference from /api/sena/card: a USED guest ID still shows
// its confirmation. The card is a key and dies on first turn; this is a receipt
// and receipts outlive the stay — that is what they are for.
// ============================================================================

import { getServices } from '../../src/services.mjs';
import { buildConfirmationHtml } from '../../src/confirmation.mjs';

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function notice(title, body) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<div style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:2rem;
            text-align:center;color:#0B1220">
  <h1 style="font-size:1.4rem;margin:0 0 .5rem">${escape(title)}</h1>
  <p style="margin:0;opacity:.75">${escape(body)}</p>
</div>`;
}

export default async function handler(req, res) {
  const v = req.query?.v || new URL(req.url, 'http://x').searchParams.get('v');

  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!v) return res.status(400).send(notice('Not found', 'This link is missing its code.'));

  const { db } = getServices();
  const { rows } = await db.query(
    `select
        to_jsonb(gi.*) as guest_id,
        to_jsonb(b.*)  as booking,
        to_jsonb(g.*)  as guest,
        to_jsonb(r.*)  as room,
        to_jsonb(h.*)  as hotel,
        to_jsonb(p.*)  as payment
       from sena_guest_ids gi
       join sena_bookings  b on b.id = gi.booking_id
       join sena_rooms     r on r.id = b.room_id
       join sena_hotels    h on h.id = b.hotel_id
       left join sena_guests g on g.id = b.guest_id
       left join lateral (
         select * from sena_payments
          where booking_id = b.id and status = 'paid'
          order by paid_at desc nulls last limit 1
       ) p on true
      where gi.verification_number = $1`,
    [v]
  );

  if (!rows.length) {
    return res.status(404).send(notice('Not found', 'This booking confirmation does not exist.'));
  }

  const { guest_id: guestId, booking, guest, room, hotel, payment } = rows[0];

  // The guest ID is minted WITH the payment link, so unpaid bookings reach
  // this page too — deliberately. A pay-on-arrival guest downloads this
  // document and it says PAYMENT PENDING in amber; the desk collects. A
  // cancelled booking, though, gets no confirmation to wave around.
  if (booking.status === 'cancelled') {
    return res
      .status(410)
      .send(notice('Booking cancelled', 'This booking was cancelled. Please contact the hotel if that is unexpected.'));
  }

  try {
    const html = await buildConfirmationHtml({ hotel, booking, guest, guestId, room, payment });
    return res.status(200).send(html);
  } catch (err) {
    console.error('[sena] confirmation render failed:', err);
    return res
      .status(500)
      .send(notice('Something went wrong', 'Please quote your booking reference to the hotel instead.'));
  }
}
