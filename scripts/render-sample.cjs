/* Sena — render the guest ID card (and later the booking PDF) from the HTML
 * templates, with demo data, so a human can look at what a guest will actually
 * receive. This is the same path n8n uses in production: fill placeholders →
 * headless Chrome → PNG/PDF. If it renders wrong here, it renders wrong there.
 *
 * Run: node sena/scripts/render-sample.cjs
 * Out: sena/docs/samples/
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const QRCode = require('qrcode');

const SENA = path.join(__dirname, '..');
const OUT = path.join(SENA, 'docs', 'samples');
fs.mkdirSync(OUT, { recursive: true });

const b64 = (p) => fs.readFileSync(p).toString('base64');
const dataUri = (p, mime = 'image/png') => `data:${mime};base64,${b64(p)}`;

// ── Brand fonts, inlined (headless Chrome has no network) ───────────────────
const FONT_DIR = path.join(SENA, 'assets', 'fonts');
const FONTS = [
  ['Sora', 600, 'sora-latin-600-normal.woff2'],
  ['Sora', 800, 'sora-latin-800-normal.woff2'],
  ['DM Sans', 400, 'dm-sans-latin-400-normal.woff2'],
  ['DM Sans', 500, 'dm-sans-latin-500-normal.woff2'],
];
const fontFaces = () =>
  FONTS.map(([family, weight, file]) => {
    const p = path.join(FONT_DIR, file);
    if (!fs.existsSync(p)) throw new Error(`Missing font ${file}`);
    return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;
      src:url(data:font/woff2;base64,${b64(p)}) format('woff2');}`;
  }).join('\n');

// The MuleSoo agency credit — compact lockup, light ink (the demo card is dark).
// See the template header for why this card carries the lockup and not the QR stamp.
const CREDIT = dataUri(path.join(SENA, 'assets', 'brand', 'mulesoo-credit-compact-on-dark.png'));

// ── Demo booking (mirrors seed-demo-hotel.sql) ─────────────────────────────
const demo = {
  hotel_name: 'Jacaranda Court Hotel',
  brand_primary: '#1E1233',
  brand_accent: '#C8A24B',
  brand_ink: '#FFFFFF',
  check_in_time: '14:00',
  check_out_time: '10:00',

  guest_name: 'Thabo Mokoena',
  nationality: 'South African',
  guest_id_number: 'JC-G-004182',
  verification_number: 'VRF-8H2K9',
  booking_reference: 'JA-ZQ8SX',
  room_name: 'Executive Suite · Bed & Breakfast',
  check_in: 'Fri 5 Sep 2026',
  check_out: 'Sun 7 Sep 2026',
};

const fill = (tpl, vars) =>
  Object.entries(vars).reduce(
    (s, [k, v]) => s.replaceAll(`{{${k}}}`, String(v ?? '')),
    tpl
  );

function findChrome() {
  const c = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const hit = c.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('No Chrome found. Set CHROME_PATH.');
  return hit;
}

// Code128 is generated INSIDE the page by JsBarcode — the same library the
// MuleSoo corporate ID uses. A hand-rolled encoder that is subtly wrong produces
// a barcode that looks perfect and scans as nothing, which is the worst possible
// outcome for a document whose only job is to be scanned.
const JSBARCODE = fs.readFileSync(
  require.resolve('jsbarcode/dist/JsBarcode.all.min.js'),
  'utf8'
);

(async () => {
  // The QR carries the whole booking (§7) so the desk can verify even offline —
  // but the verification_number is what knock_out_guest_id() actually burns.
  const qrPayload = JSON.stringify({
    v: demo.verification_number,
    id: demo.guest_id_number,
    ref: demo.booking_reference,
    name: demo.guest_name,
    in: demo.check_in,
    out: demo.check_out,
  });

  const qr = await QRCode.toDataURL(qrPayload, {
    errorCorrectionLevel: 'M',
    margin: 0,
    width: 640,
    color: { dark: '#0B1220', light: '#FFFFFF' },
  });

  const tpl = fs.readFileSync(path.join(SENA, 'templates', 'guest-id-card.html'), 'utf8');
  const html = fill(tpl, {
    ...demo,
    font_faces: fontFaces(),
    hotel_logo_html: 'JC',              // no logo uploaded → initials on the crest
    qr_data_uri: qr,
    barcode_data_uri: '',               // drawn in-page by JsBarcode below
    credit_data_uri: CREDIT,

    // The sample shows the ARRIVAL face of the card (QR live, photo hidden) —
    // the same defaults src/card.mjs uses for mode: 'arrival'.
    badge_text: 'Single Use',
    scan_label: 'Scan at reception',
    show_qr: '',
    show_photo: 'hidden',
    show_paystrip: 'hidden',            // the sample shows a PAID stay
    photo_data_uri: '',
    lifecycle_html:
      'Valid for <b>one check-in only, within 48 hours of your check-in time</b>. ' +
      'Cancelled the moment it is used; it cannot be reused or shared.',
  });

  const left = html.match(/{{\s*[\w_]+\s*}}/g);
  if (left) throw new Error(`unfilled placeholders in the card: ${[...new Set(left)].join(', ')}`);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--font-render-hinting=none', '--force-color-profile=srgb'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1370, height: 864, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.addScriptTag({ content: JSBARCODE });
    await page.evaluate((code) => {
      const canvas = document.createElement('canvas');
      // eslint-disable-next-line no-undef
      JsBarcode(canvas, code, {
        format: 'CODE128',
        displayValue: false,
        margin: 0,
        height: 70,
        width: 2,
        background: '#ffffff',
        lineColor: '#0B1220',
      });
      document.querySelector('.barcode img').src = canvas.toDataURL('image/png');
    }, demo.verification_number);
    await page.evaluate(() => document.fonts.ready);

    const png = path.join(OUT, 'guest-id-card.png');
    await page.screenshot({ path: png, type: 'png' });
    console.log(`  guest-id-card.png   ${(fs.statSync(png).size / 1024).toFixed(0)} KB   1370×864 (CR80 @ 16px/mm)`);

    const pdf = path.join(OUT, 'guest-id-card.pdf');
    await page.pdf({ path: pdf, width: '85.6mm', height: '54mm', printBackground: true, pageRanges: '1' });
    console.log(`  guest-id-card.pdf   ${(fs.statSync(pdf).size / 1024).toFixed(0)} KB   85.6 × 54 mm`);

    // A card whose code does not scan is a card that fails at 6am at the front
    // desk. Decode the QR back OUT of the finished artwork — after fonts, after
    // the white tile, after JPEG-free PNG encoding — and prove it still reads.
    const decoded = await page.evaluate(async () => {
      const img = document.querySelector('.qr img');
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      return { data: Array.from(d.data), width: c.width, height: c.height };
    });
    const jsQRmod = require('jsqr');
    const jsQR = jsQRmod.default || jsQRmod;
    const hit = jsQR(Uint8ClampedArray.from(decoded.data), decoded.width, decoded.height);
    if (!hit) throw new Error('the QR on the finished card does NOT decode');
    const payload = JSON.parse(hit.data);
    if (payload.v !== demo.verification_number) {
      throw new Error(`QR decodes to the wrong booking: ${hit.data}`);
    }
    console.log(`  QR verified — decodes to ${payload.ref} / ${payload.v} (${payload.name})`);

    await page.close();
  } finally {
    await browser.close();
  }

  console.log(`\n  → sena/docs/samples/`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
