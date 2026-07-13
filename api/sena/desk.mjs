// ============================================================================
// GET /api/sena/desk — the front desk. A clerk opens this on a phone, points it
// at the guest's QR, and the guest is checked in.
//
// This is the other half of the knock-out (CLAUDE.md §7, §2 stage 11). The SQL
// that burns a QR on first scan has been written and tested since day one and
// nothing has ever called it. This calls it.
//
// AUTHORISATION IS NOT DONE HERE. The page talks to Supabase directly with the
// ANON key — which, by design, can read nothing (policies.sql grants the public
// key no policy at all, and in Postgres RLS "no policy" means deny). The clerk
// signs in with Supabase Auth, and the ONLY thing they can then do is call
// sena_staff_check_in(), a SECURITY DEFINER function that checks they work at
// the property the code belongs to before it burns anything.
//
// So: the anon key is safe to ship in this page. That is the whole point of
// having written the policies first.
//
// The manual-entry box is not a convenience. A cracked screen, a dead camera, or
// a guest whose phone is at 1% all happen at 6am, and a front desk that can only
// scan is a front desk that stops.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let jsqr;
const jsQrSource = () =>
  (jsqr ??= fs.readFileSync(path.join(ROOT, 'node_modules', 'jsqr', 'dist', 'jsQR.js'), 'utf8'));

export default function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (!url || !anon) {
    return res
      .status(500)
      .send('<p>SUPABASE_URL / SUPABASE_ANON_KEY are not set on this deployment.</p>');
  }

  return res.status(200).send(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Front Desk — Sena</title>
<style>
  :root { --ink:#0B1220; --line:#E3E6EC; --ok:#15803D; --bad:#B91C1C; --accent:#C8A24B; }
  * { box-sizing:border-box; }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
         color:var(--ink); background:#F6F7F9; }
  main { max-width:32rem; margin:0 auto; padding:1.25rem; }
  h1 { font-size:1.1rem; letter-spacing:.02em; text-transform:uppercase; margin:0 0 .25rem; }
  .sub { color:#6B7280; font-size:.875rem; margin:0 0 1.25rem; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:1rem; margin-bottom:1rem; }
  label { display:block; font-size:.8rem; font-weight:600; margin-bottom:.35rem; }
  input { width:100%; padding:.7rem .8rem; border:1px solid var(--line); border-radius:9px;
          font-size:1rem; font-family:inherit; }
  button { width:100%; padding:.8rem; border:0; border-radius:9px; background:var(--ink); color:#fff;
           font-size:1rem; font-weight:600; font-family:inherit; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  button.ghost { background:#fff; color:var(--ink); border:1px solid var(--line); }
  video { width:100%; border-radius:10px; background:#000; aspect-ratio:4/3; object-fit:cover; }
  .row { display:flex; gap:.6rem; margin-top:.6rem; }
  .result { padding:1rem; border-radius:12px; font-weight:600; margin-bottom:1rem; }
  .result.ok  { background:#DCFCE7; color:var(--ok);  border:1px solid #86EFAC; }
  .result.bad { background:#FEE2E2; color:var(--bad); border:1px solid #FCA5A5; }
  .result .who { font-size:1.35rem; display:block; margin-bottom:.15rem; }
  .result .meta { font-weight:400; font-size:.9rem; opacity:.85; }
  .hide { display:none; }
  footer { text-align:center; color:#9CA3AF; font-size:.75rem; padding:1rem 0 2rem; }
</style>

<main>
  <h1>Front Desk</h1>
  <p class="sub">Scan the guest's QR to check them in.</p>

  <div id="out"></div>

  <!-- Sign in -->
  <section id="login" class="card">
    <label for="email">Staff email</label>
    <input id="email" type="email" autocomplete="username" placeholder="reception@hotel.co.za">
    <div style="height:.7rem"></div>
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="current-password">
    <div class="row"><button id="signin">Sign in</button></div>
  </section>

  <!-- Scanner -->
  <section id="scanner" class="card hide">
    <video id="cam" playsinline muted></video>
    <div class="row">
      <button id="start">Start camera</button>
      <button id="stop" class="ghost hide">Stop</button>
    </div>
  </section>

  <!-- Manual fallback: cameras fail, screens crack, phones die. -->
  <section id="manual" class="card hide">
    <label for="code">Or type the code on the card</label>
    <input id="code" placeholder="e.g. 7KQ2M9XPTB4H" autocapitalize="characters" spellcheck="false">
    <div class="row"><button id="go" class="ghost">Check in</button></div>
  </section>

  <footer>Sena · built by MuleSoo Digital Services</footer>
</main>

<script>${jsQrSource()}</script>
<script>
const SUPABASE_URL = ${JSON.stringify(url)};
const ANON = ${JSON.stringify(anon)};

const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('sena_token') || null;

function show(kind, title, meta) {
  $('out').innerHTML =
    '<div class="result ' + kind + '"><span class="who">' + title + '</span>' +
    (meta ? '<span class="meta">' + meta + '</span>' : '') + '</div>';
}

function signedIn() {
  $('login').classList.add('hide');
  $('scanner').classList.remove('hide');
  $('manual').classList.remove('hide');
}
if (token) signedIn();

$('signin').onclick = async () => {
  $('signin').disabled = true;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('email').value.trim(), password: $('pw').value }),
    });
    const b = await r.json();
    if (!r.ok) throw new Error(b.error_description || b.msg || 'Sign-in failed');
    token = b.access_token;
    sessionStorage.setItem('sena_token', token);
    $('out').innerHTML = '';
    signedIn();
  } catch (e) {
    show('bad', 'Could not sign in', e.message);
  } finally {
    $('signin').disabled = false;
  }
};

// The whole check-in. One RPC. The database decides whether this clerk may burn
// this code, and whether the code has already been spent — not this page.
let busy = false;
async function checkIn(code) {
  if (busy || !code) return;
  busy = true;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/sena_staff_check_in', {
      method: 'POST',
      headers: {
        apikey: ANON,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_verification_number: code }),
    });
    const rows = await r.json();
    if (!r.ok) throw new Error(rows.message || 'Check-in failed');

    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row && row.ok) {
      show('ok', '✓ ' + (row.guest_name || 'Checked in'), 'Booking ' + row.booking_reference);
      if (navigator.vibrate) navigator.vibrate(80);
      stopCam();
    } else {
      show('bad', '✕ Not checked in', (row && row.reason) || 'unknown code');
      if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
    }
  } catch (e) {
    show('bad', 'Something went wrong', e.message);
  } finally {
    // A guest is standing there. Let the clerk try the next code quickly, but not
    // so quickly that one blurry frame fires ten check-ins.
    setTimeout(() => { busy = false; }, 1200);
  }
}

$('go').onclick = () => checkIn($('code').value.trim().toUpperCase());

// ── Camera ──────────────────────────────────────────────────────────────────
let stream = null, raf = null;
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

async function startCam() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }, audio: false,
    });
    $('cam').srcObject = stream;
    await $('cam').play();
    $('start').classList.add('hide');
    $('stop').classList.remove('hide');
    tick();
  } catch (e) {
    show('bad', 'No camera', 'Type the code from the card instead.');
  }
}

function stopCam() {
  if (raf) cancelAnimationFrame(raf);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $('start').classList.remove('hide');
  $('stop').classList.add('hide');
}

function tick() {
  const v = $('cam');
  if (v.readyState === v.HAVE_ENOUGH_DATA) {
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (hit) {
      // The card's QR is JSON; 'v' is the only field we trust. A hand-typed code
      // arrives bare. Accept both.
      let code = hit.data;
      try { code = JSON.parse(hit.data).v || code; } catch {}
      checkIn(code);
    }
  }
  raf = requestAnimationFrame(tick);
}

$('start').onclick = startCam;
$('stop').onclick = stopCam;
</script>
</html>`);
}
