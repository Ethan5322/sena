// ============================================================================
// Sena — the Hotel Guest ID (CLAUDE.md §7).
//
// WHY THIS IS A WEB PAGE AND NOT A PDF
//
// The obvious build is headless Chrome → PDF, which is what scripts/render-sample
// does. It cannot run on Vercel: there is no Chrome binary in a serverless
// function, and shipping one costs ~50MB and a cold start the guest waits
// through while Sena is still on the line.
//
// So the card is rendered as HTML and served at an unguessable URL. The guest
// gets a link on WhatsApp, taps it at the front desk, and shows the screen. On a
// phone-first market that is better than an attachment nobody can find again.
// The same template still renders to PDF offline for anyone who wants paper.
//
// THE URL IS THE CREDENTIAL. It carries the verification_number — 12 characters
// from a 31-symbol alphabet, about 59 bits, not guessable. Holding the URL is
// exactly equivalent to holding the QR, which is the same trust model a printed
// card has: whoever has it can present it. That is safe because the ID dies on
// first scan (§7) — a forwarded card checks in once, and the second person is
// refused at the desk.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const b64 = (p) => fs.readFileSync(p).toString('base64');
const dataUri = (p, mime = 'image/png') => `data:${mime};base64,${b64(p)}`;

// Headless Chrome had no network; a guest's phone does, but a card whose fonts
// arrive late is a card that reflows while they are holding it up to a scanner.
// Inline everything.
const FONTS = [
  ['Sora', 600, 'sora-latin-600-normal.woff2'],
  ['Sora', 800, 'sora-latin-800-normal.woff2'],
  ['DM Sans', 400, 'dm-sans-latin-400-normal.woff2'],
  ['DM Sans', 500, 'dm-sans-latin-500-normal.woff2'],
];

let cachedChrome = null;
function fontFaces() {
  if (cachedChrome) return cachedChrome;
  cachedChrome = FONTS.map(([family, weight, file]) => {
    const p = path.join(ROOT, 'assets', 'fonts', file);
    return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;
      src:url(data:font/woff2;base64,${b64(p)}) format('woff2');}`;
  }).join('\n');
  return cachedChrome;
}

const fill = (tpl, vars) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, String(v ?? '')), tpl);

const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

const day = (d) =>
  new Date(d).toLocaleDateString('en-ZA', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/**
 * The QR payload. It carries the whole booking so the desk can read a guest's
 * name off a scan even with no signal — but `v` is the only field that matters:
 * sena_knock_out_guest_id() burns THAT, and nothing else on the card is trusted.
 */
export function qrPayload({ guestId, booking, guest }) {
  return JSON.stringify({
    v: guestId.verification_number,
    id: guestId.guest_id_number,
    ref: booking.reference,
    name: guest.full_name,
    in: booking.check_in,
    out: booking.check_out,
  });
}

/** Render the guest ID card to standalone HTML. No network, no Chrome. */
export async function buildCardHtml({ hotel, booking, guest, guestId, room }) {
  const payload = qrPayload({ guestId, booking, guest });

  const qr = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 0,
    width: 640,
    color: { dark: '#0B1220', light: '#FFFFFF' },
  });

  const credit = dataUri(
    path.join(
      ROOT,
      'assets',
      'brand',
      hotel.card_style === 'light'
        ? 'mulesoo-credit-compact-on-light.png'
        : 'mulesoo-credit-compact-on-dark.png'
    )
  );

  const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'guest-id-card.html'), 'utf8');

  const html = fill(tpl, {
    hotel_name: hotel.name,
    brand_primary: hotel.brand_primary,
    brand_accent: hotel.brand_accent,
    brand_ink: hotel.brand_ink,
    check_in_time: String(hotel.check_in_time).slice(0, 5),
    check_out_time: String(hotel.check_out_time).slice(0, 5),

    guest_name: guest.full_name,
    nationality: guest.nationality || '—',
    guest_id_number: guestId.guest_id_number,
    verification_number: guestId.verification_number,
    booking_reference: booking.reference,
    room_name: room.plan ? `${room.name} · ${room.plan}` : room.name,
    check_in: day(booking.check_in),
    check_out: day(booking.check_out),

    font_faces: fontFaces(),
    hotel_logo_html: initials(hotel.name),
    qr_data_uri: qr,
    barcode_data_uri: '', // drawn in-page below — JsBarcode needs a canvas
    credit_data_uri: credit,
  });

  const unfilled = html.match(/\{\{\s*[\w_]+\s*\}\}/g);
  // A card that ships with a raw {{guest_name}} on it is worse than no card.
  if (unfilled) throw new Error(`unfilled placeholders: ${[...new Set(unfilled)].join(', ')}`);

  // The Code128 strip is drawn on the guest's own device. Hand-rolling a barcode
  // encoder produces one that looks perfect and scans as nothing — so we use the
  // same library the offline renderer does, and let the browser's canvas do it.
  const jsbarcode = fs.readFileSync(
    path.join(ROOT, 'node_modules', 'jsbarcode', 'dist', 'JsBarcode.all.min.js'),
    'utf8'
  );

  return html.replace(
    '</body>',
    `<script>${jsbarcode}</script>
<script>
  (function () {
    var img = document.querySelector('.barcode img');
    if (!img) return;
    var c = document.createElement('canvas');
    JsBarcode(c, ${JSON.stringify(guestId.verification_number)}, {
      format: 'CODE128', displayValue: false, margin: 0,
      height: 70, width: 2, background: '#ffffff', lineColor: '#0B1220'
    });
    img.src = c.toDataURL('image/png');
  })();
</script>
</body>`
  );
}
