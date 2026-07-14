// ============================================================================
// GET /api/sena/card?v=<verification_number> — the guest's Hotel Guest ID.
//
// This is the link Sena sends on WhatsApp. The guest opens it at the front desk
// and shows the screen; the clerk scans the QR on it.
//
// It is deliberately readable WITHOUT a login. The URL is the credential (see
// src/card.mjs), and a card that demands an account before a tired traveller can
// prove who they are is a card nobody uses.
//
// The card shows a guest's name, nationality and dates — personal information
// under POPIA. So: no indexing, no caching by a shared proxy, and the moment the
// ID is spent the card says so rather than continuing to look valid.
// ============================================================================

// getServices(), not a raw pool: in production it builds the same pg pool this
// used to, and in demo mode it is the in-process Postgres — so the card link in
// the demo mail actually opens, which is the moment a prospect judges.
import { getServices } from '../../src/services.mjs';
import { buildCardHtml } from '../../src/card.mjs';

const database = () => getServices().db;

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function notice(title, body, tone = '#0B1220') {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<div style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:2rem;
            text-align:center;color:${tone}">
  <h1 style="font-size:1.4rem;margin:0 0 .5rem">${escape(title)}</h1>
  <p style="margin:0;opacity:.75">${escape(body)}</p>
</div>`;
}

export default async function handler(req, res) {
  const v = req.query?.v || new URL(req.url, 'http://x').searchParams.get('v');

  // A guest ID is personal information. It must never be indexed, and it must
  // never sit in a CDN cache where the next request could be served someone
  // else's card.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!v) return res.status(400).send(notice('Not found', 'This link is missing its code.'));

  const { rows } = await database().query(
    `select
        to_jsonb(gi.*) as guest_id,
        to_jsonb(b.*)  as booking,
        to_jsonb(g.*)  as guest,
        to_jsonb(r.*)  as room,
        to_jsonb(h.*)  as hotel
       from sena_guest_ids gi
       join sena_bookings  b on b.id = gi.booking_id
       join sena_rooms     r on r.id = b.room_id
       join sena_hotels    h on h.id = b.hotel_id
       left join sena_guests g on g.id = b.guest_id
      where gi.verification_number = $1`,
    [v]
  );

  if (!rows.length) {
    return res.status(404).send(notice('Not found', 'This guest ID does not exist.'));
  }

  const { guest_id: guestId, booking, guest, room, hotel } = rows[0];

  // Spent. Showing the card as though it still works is how a guest arrives
  // believing they are checked in when someone already used their code.
  if (guestId.status !== 'active') {
    return res
      .status(410)
      .send(
        notice(
          'Already used',
          `This guest ID was checked in on ${new Date(guestId.used_at).toLocaleString('en-ZA')}. ` +
            `Please speak to the front desk.`
        )
      );
  }

  try {
    const html = await buildCardHtml({ hotel, booking, guest, guestId, room });
    return res.status(200).send(html);
  } catch (err) {
    console.error('[sena] card render failed:', err);
    return res
      .status(500)
      .send(notice('Something went wrong', 'Please show your booking reference at the front desk.'));
  }
}
