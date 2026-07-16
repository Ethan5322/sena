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

/**
 * Render the guest ID card to standalone HTML. No network, no Chrome.
 *
 * The card has two faces, decided by `mode`:
 *
 *   'arrival'  (default) — the QR pass. The code is live; the desk or the
 *              self check-in page will burn it exactly once.
 *   'instay'   — after check-in. The QR is spent, so the column shows the
 *              guest's PHOTO instead (taken at self check-in), and the card
 *              reads as the pass they carry until check-out. A guest checked
 *              in at the desk has no photo; they keep the (dead) QR face.
 *
 * `chrome: true` appends the download bar — save as PNG or PDF, generated on
 * the guest's own device (html2canvas + jsPDF, inlined like everything else;
 * a CDN outage must not eat a guest's ID). Off for offline/PNG rendering so
 * the sample images and print pipeline stay clean.
 */
export async function buildCardHtml({
  hotel,
  booking,
  guest,
  guestId,
  room,
  mode = 'arrival',
  chrome = false,
  // Money not yet landed: the amber PAYMENT PENDING strip renders on either
  // face until it does. The owner's rule — an unpaid guest still checks in,
  // and the card says so instead of anyone having to remember.
  paymentPending = false,
}) {
  const payload = qrPayload({ guestId, booking, guest });
  const instay = mode === 'instay';
  const hasPhoto = instay && Boolean(guestId.photo);

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

    // Which face of the card this is (see the doc comment above).
    show_paystrip: paymentPending ? '' : 'hidden',
    badge_text: instay ? 'Checked In' : 'Single Use',
    scan_label: instay ? (hasPhoto ? 'Guest photo ID' : 'Checked in') : 'Scan at reception',
    show_qr: hasPhoto ? 'hidden' : '',
    show_photo: hasPhoto ? '' : 'hidden',
    photo_data_uri: hasPhoto ? guestId.photo : '',
    lifecycle_html: instay
      ? `Checked in. This pass is valid until <b>check-out on ${day(booking.check_out)} ` +
        `at ${String(hotel.check_out_time).slice(0, 5)}</b>, then it expires automatically ` +
        `and the photo is deleted.`
      : `Valid for <b>one check-in only, within 48 hours of your check-in time</b>. ` +
        `Cancelled the moment it is used; it cannot be reused or shared.`,
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
${chrome ? downloadBar(booking.reference) : ''}
</body>`
  );
}

// ── The download bar ─────────────────────────────────────────────────────────
// "Save as photo" / "Save as PDF", both generated ON THE GUEST'S DEVICE from
// the very pixels they are looking at, and both downloading immediately on tap.
// The bar itself is excluded from the capture, and hidden from print.
//
// Sizing note: the card page has a fixed 1370px layout (it is a document, not a
// site), so a phone renders it zoomed out — the buttons are sized for THAT, not
// for a desktop cursor.
function downloadBar(reference) {
  const html2canvas = fs.readFileSync(
    path.join(ROOT, 'node_modules', 'html2canvas', 'dist', 'html2canvas.min.js'),
    'utf8'
  );
  const jspdf = fs.readFileSync(
    path.join(ROOT, 'node_modules', 'jspdf', 'dist', 'jspdf.umd.min.js'),
    'utf8'
  );
  const file = `guest-id-${String(reference).replace(/[^\w-]/g, '')}`;

  return `<div id="sena-actions">
  <button id="dl-png" type="button">Save as photo</button>
  <button id="dl-pdf" type="button">Save as PDF</button>
</div>
<style>
  #sena-actions { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%);
                  display: flex; gap: 24px; z-index: 9; }
  #sena-actions button {
    font: 600 40px/1 'DM Sans', system-ui, sans-serif; color: #0B1220;
    background: #fff; border: 2px solid #0B122040; border-radius: 999px;
    padding: 30px 52px; cursor: pointer; box-shadow: 0 14px 34px -14px #00000077;
  }
  #sena-actions button:disabled { opacity: .5; }
  @media print { #sena-actions { display: none; } }
</style>
<script>${html2canvas}</script>
<script>${jspdf}</script>
<script>
  (function () {
    var FILE = ${JSON.stringify(file)};
    function capture() {
      return html2canvas(document.body, {
        scale: 1,
        ignoreElements: function (el) { return el.id === 'sena-actions'; }
      });
    }
    function busy(btn, on) { btn.disabled = on; }
    document.getElementById('dl-png').onclick = function () {
      var btn = this; busy(btn, true);
      capture().then(function (c) {
        var a = document.createElement('a');
        a.download = FILE + '.png';
        a.href = c.toDataURL('image/png');
        a.click();
      }).finally(function () { busy(btn, false); });
    };
    document.getElementById('dl-pdf').onclick = function () {
      var btn = this; busy(btn, true);
      capture().then(function (c) {
        // CR80: 85.6 × 54 mm — the PDF is the physical card, exactly.
        var doc = new jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: [85.6, 54] });
        doc.addImage(c.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 85.6, 54);
        doc.save(FILE + '.pdf');
      }).finally(function () { busy(btn, false); });
    };
  })();
</script>`;
}
