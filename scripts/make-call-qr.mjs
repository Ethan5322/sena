// ============================================================================
// Sena — the "scan to call reception" QR poster.
//
// The guest journey starts with a scan: a QR on the hotel's front door, desk
// tent, brochure or website. What the QR ENCODES depends on what the hotel has
// bought (CLAUDE.md §0.0):
//
//   TODAY (free stack, no phone number):
//     the QR carries the reception page URL. The guest scans, the browser
//     opens, one tap on "Call Reception" and Sena answers. Two taps total.
//
//   LATER (LiveKit SIP trunk + a real number):
//     pass --tel and the QR carries tel:+27... — the phone's own dialler
//     opens with the number filled in. One tap, a normal phone call. Nothing
//     else in the system changes; this script is the whole difference.
//
// A tel: QR without a number to answer it is a poster that dials a dead line,
// which is why tel: is a flag and not the default.
//
// Run:  npm run qr                                   → URL mode, from SENA_RECEPTION_URL or the arg
//       node scripts/make-call-qr.mjs https://hotel.example/reception
//       node scripts/make-call-qr.mjs --tel +27101234567
// Out:  docs/samples/call-sena-qr.png        (just the code, for layouts)
//       docs/samples/call-sena-poster.html   (print-ready A5, open and Ctrl+P)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'samples');
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const telIx = args.indexOf('--tel');
const HOTEL = process.env.SENA_QR_HOTEL_NAME || 'Jacaranda Court Hotel';

let payload, instruction;
if (telIx !== -1) {
  const number = args[telIx + 1];
  if (!number || !/^\+\d{7,15}$/.test(number)) {
    console.error('  --tel needs a number in international format, e.g. --tel +27101234567');
    process.exit(1);
  }
  payload = `tel:${number}`;
  instruction = 'Scan with your phone camera — it will offer to call reception.';
} else {
  payload =
    args.find((a) => !a.startsWith('--')) ||
    process.env.SENA_RECEPTION_URL ||
    'http://localhost:8080/';
  instruction = 'Scan with your phone camera, open the link, and tap “Call Reception”.';
}

const png = await QRCode.toBuffer(payload, {
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 1024,
  color: { dark: '#0B1220', light: '#FFFFFF' },
});
fs.writeFileSync(path.join(OUT, 'call-sena-qr.png'), png);

const credit = fs
  .readFileSync(path.join(ROOT, 'assets', 'brand', 'mulesoo-credit-stamp-on-light.png'))
  .toString('base64');

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

fs.writeFileSync(
  path.join(OUT, 'call-sena-poster.html'),
  `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Call Reception — ${esc(HOTEL)}</title>
<style>
  @page { size: A5; margin: 12mm; }
  * { box-sizing: border-box; margin: 0; }
  body { font: 16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; color: #0B1220;
         background: #EDEFF2; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .poster { max-width: 148mm; min-height: 200mm; margin: 1.5rem auto; background: #fff;
            padding: 14mm; text-align: center; display: flex; flex-direction: column;
            box-shadow: 0 8px 30px rgba(11,18,32,.12); }
  @media print { body { background:#fff } .poster { margin:0; box-shadow:none; min-height:0 } }
  h1 { font-size: 1.5rem; letter-spacing: -.01em; }
  .sub { color: #6B7280; margin-top: .3rem; }
  .qr { width: 78mm; height: 78mm; margin: 1.6rem auto; display: block; }
  .how { font-size: .95rem; color: #374151; max-width: 26rem; margin: 0 auto; }
  .ai { margin-top: 1.2rem; font-size: .8rem; color: #6B7280; }
  footer { margin-top: auto; padding-top: 1.5rem; }
  footer img { height: 40px; }
</style>
<div class="poster">
  <h1>${esc(HOTEL)}</h1>
  <p class="sub">Reception, any hour of the day</p>
  <img class="qr" src="data:image/png;base64,${png.toString('base64')}" alt="QR code to call reception">
  <p class="how">${esc(instruction)}<br>Sena, our reception assistant, will help you book a room,
     check a booking, or answer any question.</p>
  <p class="ai">Sena is an AI assistant and will say so when it answers.</p>
  <footer><img src="data:image/png;base64,${credit}" alt="Built by MuleSoo Digital Services"></footer>
</div>
</html>`
);

console.log(`\n  QR encodes:  ${payload}`);
console.log(`  ${OUT}\\call-sena-qr.png`);
console.log(`  ${OUT}\\call-sena-poster.html   (open, then Ctrl+P for the print version)\n`);
