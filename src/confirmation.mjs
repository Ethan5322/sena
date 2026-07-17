// ============================================================================
// Sena — the Booking Confirmation document (CLAUDE.md §7, document 1).
//
// Same architecture as the guest ID card (src/card.mjs, and read the essay
// there): rendered as standalone HTML at an unguessable URL, printable to an
// honest A4 PDF by the browser the guest is already holding. No Chrome on the
// server, no attachment lost in a mail app.
//
// THE URL IS THE SAME CREDENTIAL AS THE CARD — the verification_number. One
// secret per booking, two documents on it. Unlike the card, this page does NOT
// die when the ID is scanned: a confirmation is proof of a paid stay, and the
// proof must outlive the check-in (disputes, expense claims, POPIA access
// requests all arrive after the guest has left).
//
// The QR on it is the card's QR, byte for byte. A guest who prints this page
// and leaves the phone in the taxi still checks in — the desk scans paper
// instead of a screen, and the same single-use rule burns the same number.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { qrPayload } from './card.mjs';
import { toMajor } from './db.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const b64 = (p) => fs.readFileSync(p).toString('base64');

// Same inlined fonts as the card, for the same reason: a document that reflows
// while it is being printed is not a document.
const FONTS = [
  ['Sora', 600, 'sora-latin-600-normal.woff2'],
  ['Sora', 800, 'sora-latin-800-normal.woff2'],
  ['DM Sans', 400, 'dm-sans-latin-400-normal.woff2'],
  ['DM Sans', 500, 'dm-sans-latin-500-normal.woff2'],
];

let cachedFonts = null;
function fontFaces() {
  if (cachedFonts) return cachedFonts;
  cachedFonts = FONTS.map(([family, weight, file]) => {
    const p = path.join(ROOT, 'assets', 'fonts', file);
    return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;
      src:url(data:font/woff2;base64,${b64(p)}) format('woff2');}`;
  }).join('\n');
  return cachedFonts;
}

const fill = (tpl, vars) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, String(v ?? '')), tpl);

// Everything on this page came out of the database, and some of it (names,
// special requests, policy text) was typed by a person. It renders into HTML.
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const day = (d) =>
  new Date(d).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

const nightsBetween = (checkIn, checkOut) =>
  Math.round((new Date(checkOut) - new Date(checkIn)) / 86_400_000);

/** Render the booking confirmation to standalone HTML. No network, no Chrome. */
export async function buildConfirmationHtml({ hotel, booking, guest, guestId, room, payment }) {
  // The same payload the card carries, so paper checks in like a screen does.
  const qr = await QRCode.toDataURL(qrPayload({ guestId, booking, guest }), {
    errorCorrectionLevel: 'M',
    margin: 0,
    width: 480,
    color: { dark: '#0B1220', light: '#FFFFFF' },
  });

  // The full credit stamp (§0.0) — this is an A4 letterhead document, not a
  // CR80 card, so it takes the stamp rather than the compact lockup.
  const credit = `data:image/png;base64,${b64(
    path.join(ROOT, 'assets', 'brand', 'mulesoo-credit-stamp-on-light.png')
  )}`;

  const nights = nightsBetween(booking.check_in, booking.check_out);
  const total = toMajor(booking.total_cents);

  const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'booking-confirmation.html'), 'utf8');

  const html = fill(tpl, {
    font_faces: fontFaces(),
    brand_primary: esc(hotel.brand_primary),
    brand_accent: esc(hotel.brand_accent),

    hotel_name: esc(hotel.name),
    hotel_address: esc(hotel.address || ''),
    hotel_phone: esc(hotel.phone),
    hotel_email: esc(hotel.email || ''),
    check_in_time: esc(String(hotel.check_in_time).slice(0, 5)),
    check_out_time: esc(String(hotel.check_out_time).slice(0, 5)),
    cancellation_policy: esc(hotel.cancellation_policy),

    reference: esc(booking.reference),
    check_in: esc(day(booking.check_in)),
    check_out: esc(day(booking.check_out)),
    nights,
    guests_count: esc(booking.guests_count),

    guest_name: esc(guest.full_name),
    guest_phone: esc(guest.phone),
    guest_email: esc(guest.email || '—'),
    nationality: esc(guest.nationality || '—'),

    room_name: esc(room.plan ? `${room.name} · ${room.plan}` : room.name),
    rate: (toMajor(room.rate_cents)).toFixed(2),
    currency: esc(hotel.currency),
    total: total.toFixed(2),

    // Paid and pending are both real states of a real booking. Pay-on-arrival
    // guests carry this document to the desk, so it must say the truth in
    // amber rather than refuse to exist.
    badge_text: payment ? '✓ PAID' : 'PAYMENT PENDING',
    badge_style: payment ? '' : 'background:#FEF3C7;color:#92400E;border:1px solid #F59E0B',
    payment_note: payment
      ? `Paid via ${esc(payment.provider)} · ref ${esc(payment.provider_reference)} · ${
          payment.paid_at ? new Date(payment.paid_at).toLocaleString('en-ZA') : '—'
        }`
      : 'Payable online (link in your email) or at the front desk on arrival. ' +
        'If you have not arrived within 48 hours of your check-in time, this booking expires.',
    state_color: payment ? '#15803D' : '#B45309',
    state_text: payment ? 'PAID' : 'PENDING',
    total_label: payment ? 'Total paid' : 'Total due',

    guest_id_number: esc(guestId.guest_id_number),
    verification_number: esc(guestId.verification_number),
    qr_data_uri: qr,
    credit_data_uri: credit,
    issued_at: new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }),
  });

  // Same discipline as the card: a confirmation with a raw {{total}} on it is
  // worse than no confirmation.
  const unfilled = html.match(/\{\{\s*[\w_]+\s*\}\}/g);
  if (unfilled) throw new Error(`unfilled placeholders: ${[...new Set(unfilled)].join(', ')}`);

  return html;
}
