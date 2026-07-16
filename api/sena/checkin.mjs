// ============================================================================
// /api/sena/checkin — the guest checks themselves in (CLAUDE.md §2 stage 11).
//
// The arrival moment, self-service. The guest scanned the hotel's QR, chose
// "I have a booking", and is now standing in the lobby with the verification
// code from their confirmation email. This page takes the code, shows them
// their own booking, asks for a photo (camera or gallery, auto-cropped to an
// ID-photo frame on the guest's own device), and checks them in. Their guest
// ID becomes an in-stay photo pass, valid until check-out.
//
// GET  → the page. Static, no personal data — everything arrives via POST
//        after the guest proves they hold the code.
// POST → JSON. Two actions:
//          lookup   {code}          → the booking behind the code, plus what
//                                     state it is in (ready / too early / …)
//          checkin  {code, photo}   → sena_self_check_in(), atomically
//
// THE CODE IS THE CREDENTIAL — the same trust model as the card URL (see
// src/card.mjs): 12 characters from a 31-symbol alphabet, ~59 bits. Whoever
// holds it can check in, once, on the right day, with their face on the
// resulting pass. That is strictly stronger than the paper voucher it
// replaces.
//
// EVERY GATE LIVES IN THE DATABASE. The page checks nothing that matters; the
// lookup's "state" is UX, and a forged POST straight to `checkin` still hits
// sena_self_check_in(), which refuses unpaid, cancelled, early, late, spent
// and photo-less attempts inside one locked transaction.
//
// THE PHOTO never touches the voice stack and never leaves this wire: browser
// → this handler → sena_guest_ids.photo, and the daily cron deletes it the
// day the stay ends (POPIA — biometric data does not outlive the stay).
// ============================================================================

import { getServices } from '../../src/services.mjs';

const database = () => getServices().db;

// A data-URI JPEG/PNG, and nothing else. 2.5 MB of base64 (~1.8 MB of image) is
// generous for a 900×1200 ID crop; anything bigger is not a face, it is a
// storage attack.
const PHOTO_RE = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const PHOTO_MAX = 2_500_000;

const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6,20}$/;

// pg hands dates back as Date objects, PGlite sometimes as strings. The page
// needs plain YYYY-MM-DD — and NOT via toISOString(), which rolls a local
// midnight back into yesterday in UTC.
const isoDay = (d) => {
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

async function lookup(code) {
  const { rows } = await database().query(
    `select gi.status as id_status, gi.used_at, gi.photo_taken_at,
            b.id as booking_id, b.reference, b.check_in, b.check_out,
            b.status as booking_status, b.guests_count,
            g.full_name, g.nationality,
            r.name as room_name, r.plan,
            h.id as hotel_id, h.name as hotel_name, h.email as hotel_email,
            h.escalation_whatsapp, h.check_in_time, h.check_out_time,
            (now() at time zone h.timezone)::date as hotel_today
       from sena_guest_ids gi
       join sena_bookings b on b.id = gi.booking_id
       join sena_rooms    r on r.id = b.room_id
       join sena_hotels   h on h.id = b.hotel_id
  left join sena_guests   g on g.id = b.guest_id
      where gi.verification_number = $1`,
    [code]
  );
  return rows[0] || null;
}

/** What the guest should see for this booking, right now. UX only — the
 *  database re-decides all of it inside sena_self_check_in(). */
function stateOf(row) {
  if (row.booking_status === 'cancelled') return 'cancelled';
  if (row.id_status === 'used') return 'already_checked_in';
  if (row.id_status === 'expired' || row.booking_status === 'completed') return 'expired';
  if (row.booking_status !== 'confirmed') return 'see_front_desk';
  if (row.hotel_today < row.check_in) return 'too_early';
  if (row.hotel_today > row.check_out) return 'expired';
  return 'ready';
}

// Best-effort per-IP throttle. The codes are 59-bit so guessing is hopeless —
// what this blunts is a bot burning database connections and email quota. It is
// per warm lambda instance (Vercel gives no shared state for free), which is
// exactly the honest amount of protection a free tier can buy: enough to stop
// a naive script, documented as not being a WAF.
const BUCKET = new Map(); // ip → recent request timestamps
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

function throttled(req) {
  const ip =
    String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const now = Date.now();
  const seen = (BUCKET.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  seen.push(now);
  BUCKET.set(ip, seen);
  if (BUCKET.size > 5000) BUCKET.clear(); // memory guard beats precision here
  return seen.length > RATE_LIMIT;
}

export default async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(PAGE);
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });

  if (throttled(req)) {
    return res.status(429).json({ ok: false, reason: 'Too many attempts — please wait a minute and try again.' });
  }

  const body = req.body || {};
  const code = String(body.code || '').trim().toUpperCase();

  if (!CODE_RE.test(code)) {
    return res.status(400).json({ ok: false, reason: 'That does not look like a check-in code.' });
  }

  try {
    if (body.action === 'lookup') {
      const row = await lookup(code);
      if (!row) return res.status(404).json({ ok: false, reason: 'unknown code' });

      const publicUrl = process.env.SENA_PUBLIC_URL || '';
      return res.status(200).json({
        ok: true,
        state: stateOf(row),
        guest_name: row.full_name || 'Guest',
        hotel_name: row.hotel_name,
        room: row.plan ? `${row.room_name} · ${row.plan}` : row.room_name,
        reference: row.reference,
        check_in: isoDay(row.check_in),
        check_out: isoDay(row.check_out),
        check_in_time: String(row.check_in_time).slice(0, 5),
        guests_count: row.guests_count,
        card_url: publicUrl ? `${publicUrl}/api/sena/card?v=${encodeURIComponent(code)}` : null,
      });
    }

    if (body.action === 'checkin') {
      const photo = String(body.photo || '');
      if (!PHOTO_RE.test(photo) || photo.length > PHOTO_MAX) {
        return res.status(400).json({ ok: false, reason: 'The photo did not come through — please try again.' });
      }

      const { rows } = await database().query(
        `select * from sena_self_check_in($1, $2, $3)`,
        [code, photo, 'guest-self-checkin']
      );
      const result = rows[0];

      if (!result.ok) return res.status(409).json({ ok: false, reason: result.reason });

      // §2 stage 11 — owner visibility: real-time check-in confirmation. The
      // guest is not kept waiting on the owner's inbox: failures are logged,
      // not surfaced.
      try {
        const row = await lookup(code);
        const { notifier } = getServices();
        const sent = await notifier.alertOwner({
          to: row.hotel_email,
          whatsappTo: row.escalation_whatsapp,
          subject: `Checked in — ${result.guest_name} (${result.booking_reference})`,
          text:
            `GUEST CHECKED IN (self-service)\n\n` +
            `${result.guest_name}\n${result.booking_reference} · ${row.room_name}\n` +
            `Staying until ${row.check_out}\n\n` +
            `Photo ID issued; it expires automatically at check-out.`,
        });
        await database().query(
          `insert into sena_notifications_log (booking_id, channel, recipient, template, status)
                values ($1, $2, $3, 'owner_checkin', $4)`,
          [row.booking_id, notifier.channel, row.hotel_email || 'unknown', sent.ok ? 'sent' : 'failed']
        );
      } catch (err) {
        console.error('[sena] owner check-in alert failed:', err);
      }

      const publicUrl = process.env.SENA_PUBLIC_URL || '';
      return res.status(200).json({
        ok: true,
        guest_name: result.guest_name,
        reference: result.booking_reference,
        valid_until: isoDay(result.check_out),
        card_url: publicUrl ? `${publicUrl}/api/sena/card?v=${encodeURIComponent(code)}` : null,
      });
    }

    return res.status(400).json({ ok: false, reason: 'unknown action' });
  } catch (err) {
    console.error('[sena] checkin failed:', err);
    return res.status(500).json({ ok: false, reason: 'Something went wrong — please see the front desk.' });
  }
}

// ── The page ─────────────────────────────────────────────────────────────────
// One file, no framework, same design language as reception.html. The page's
// own JavaScript deliberately uses no ${} template literals so this outer
// template literal never needs escaping.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Check in</title>
<style>
  :root { --ink:#0B1220; --accent:#C8A24B; --paper:#F7F5F2; --line:#E5E7EB;
          --mut:#6B7280; --bad:#B42318; --ok:#15803D; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100dvh; background:var(--paper); color:var(--ink);
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
         display:grid; place-items:start center; }
  main { width:min(28rem,94vw); padding:2.5rem 1.25rem 3rem; text-align:center; }
  h1 { font-size:1.5rem; margin:0 0 .3rem; letter-spacing:-.01em; }
  .sub { color:var(--mut); margin:0 0 2rem; font-size:.95rem; }
  .hide { display:none !important; }

  .card { background:#fff; border:1px solid var(--line); border-radius:16px;
          padding:1.4rem 1.25rem; text-align:left; box-shadow:0 10px 30px -20px #0B122033; }

  input.code { width:100%; padding:.9rem 1rem; border:1px solid var(--line); border-radius:12px;
               font:600 1.25rem/1.2 ui-monospace,Consolas,monospace; letter-spacing:.35em;
               text-transform:uppercase; text-align:center; }
  input.code:focus { outline:2px solid var(--accent); border-color:var(--accent); }

  button, .btn { width:100%; padding:1rem 1.25rem; border:0; border-radius:999px;
    background:var(--ink); color:#fff; font:600 1.02rem/1.2 inherit; font-family:inherit;
    cursor:pointer; display:block; text-align:center; text-decoration:none;
    transition:transform .08s ease,opacity .2s ease; margin-top:.8rem; }
  button:hover:not(:disabled), .btn:hover { transform:translateY(-1px); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .ghost { background:#fff; color:var(--ink); border:1px solid var(--line); }
  .gold  { background:var(--accent); color:var(--ink); }

  .status { margin-top:1.1rem; min-height:1.4rem; font-size:.9rem; color:var(--mut); }
  .status[data-error="true"] { color:var(--bad); font-weight:600; }

  .rows { margin:0; }
  .rows div { display:flex; justify-content:space-between; gap:1rem;
              padding:.55rem 0; border-bottom:1px solid var(--line); font-size:.95rem; }
  .rows div:last-child { border-bottom:0; }
  .rows .k { color:var(--mut); }
  .rows .v { font-weight:600; text-align:right; }

  .note { border-radius:12px; padding:.9rem 1rem; font-size:.92rem; margin-top:1rem; text-align:left; }
  .note.ok   { background:#DCFCE7; color:var(--ok); }
  .note.warn { background:#FEF3C7; color:#92400E; }
  .note.bad  { background:#FEE2E2; color:var(--bad); }

  video { width:100%; aspect-ratio:3/4; object-fit:cover; border-radius:14px;
          background:#000; transform:scaleX(-1); }
  img.preview { width:min(16rem,70vw); aspect-ratio:3/4; object-fit:cover;
                border-radius:14px; border:3px solid var(--accent); display:block; margin:0 auto; }

  .bigtick { font-size:3rem; line-height:1; }
  .done h1 { margin-top:.4rem; }

  .privacy { margin-top:2.2rem; padding-top:1.1rem; border-top:1px solid var(--line);
             font-size:.78rem; color:#9CA3AF; }
</style>
</head>
<body>
<main>
  <!-- Step 1 · the code -->
  <section id="s-code">
    <h1>Check in</h1>
    <p class="sub">Enter the check-in code from your confirmation email.</p>
    <div class="card">
      <input id="code" class="code" maxlength="20" autocomplete="one-time-code"
             autocapitalize="characters" spellcheck="false" placeholder="XXXX XXXX XXXX">
      <button id="find">Find my booking</button>
    </div>
    <p class="status" id="st1">&nbsp;</p>
  </section>

  <!-- Step 2 · your booking -->
  <section id="s-details" class="hide">
    <h1 id="hi">Welcome</h1>
    <p class="sub" id="hotel"></p>
    <div class="card">
      <div class="rows" id="rows"></div>
      <div id="verdict"></div>
      <button id="tophoto" class="hide">Continue — take my photo</button>
      <a id="opencard" class="btn gold hide" href="#">Open my Guest ID</a>
      <button id="back" class="ghost">Use a different code</button>
    </div>
  </section>

  <!-- Step 3 · the photo -->
  <section id="s-photo" class="hide">
    <h1>Your ID photo</h1>
    <p class="sub">Look at the camera, or choose a clear photo of your face.</p>
    <div class="card">
      <div id="picker">
        <button id="usecam">Take a photo</button>
        <button id="usegallery" class="ghost">Choose from gallery</button>
        <input id="file" type="file" accept="image/*" class="hide">
      </div>
      <div id="camview" class="hide">
        <video id="cam" playsinline muted autoplay></video>
        <button id="snap" class="gold">Take photo</button>
        <button id="camcancel" class="ghost">Cancel</button>
      </div>
      <div id="cropview" class="hide">
        <img id="preview" class="preview" alt="Your ID photo">
        <button id="usephoto" class="gold">Use this photo &amp; check in</button>
        <button id="retake" class="ghost">Retake</button>
      </div>
    </div>
    <p class="status" id="st3">&nbsp;</p>
  </section>

  <!-- Step 4 · done -->
  <section id="s-done" class="done hide">
    <div class="bigtick">✓</div>
    <h1 id="donename">You're checked in</h1>
    <p class="sub" id="donesub"></p>
    <a id="donecard" class="btn gold" href="#">Open my Guest ID</a>
    <p class="status">You can download it as a photo or a PDF from the card.</p>
  </section>

  <p class="privacy">
    Your photo is used only on your guest ID and is deleted automatically when
    your stay ends. Powered by Sena, the AI front desk.
  </p>
</main>

<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var CODE = '', LOOKUP = null, PHOTO = null, stream = null;

  function show(step) {
    ['s-code', 's-details', 's-photo', 's-done'].forEach(function (s) {
      $(s).classList.toggle('hide', s !== step);
    });
    window.scrollTo(0, 0);
  }
  function say(el, text, isErr) {
    el.textContent = text || '\\u00a0';
    el.dataset.error = String(!!isErr);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function post(payload) {
    return fetch(location.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json().then(function (b) { b._http = r.status; return b; }); });
  }
  function day(d) {
    return new Date(d + 'T00:00:00').toLocaleDateString(undefined,
      { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // ── Step 1 → 2 ─────────────────────────────────────────────────────────────
  $('find').onclick = function () {
    CODE = $('code').value.replace(/\\s/g, '').toUpperCase();
    if (CODE.length < 6) return say($('st1'), 'That code looks too short.', true);
    $('find').disabled = true;
    say($('st1'), 'Looking up your booking…');
    post({ action: 'lookup', code: CODE }).then(function (b) {
      $('find').disabled = false;
      if (!b.ok) return say($('st1'), b.reason === 'unknown code'
        ? 'We could not find that code. Check your confirmation email and try again.'
        : (b.reason || 'Something went wrong.'), true);
      LOOKUP = b;
      renderDetails(b);
      say($('st1'), '');
      show('s-details');
    }).catch(function () {
      $('find').disabled = false;
      say($('st1'), 'Could not reach the hotel system. Please try again.', true);
    });
  };
  $('code').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('find').click(); });

  function renderDetails(b) {
    $('hi').textContent = 'Welcome, ' + (b.guest_name.split(' ')[0] || 'Guest');
    $('hotel').textContent = b.hotel_name;
    $('rows').innerHTML =
      '<div><span class="k">Booking</span><span class="v">' + esc(b.reference) + '</span></div>' +
      '<div><span class="k">Room</span><span class="v">' + esc(b.room) + '</span></div>' +
      '<div><span class="k">Check-in</span><span class="v">' + esc(day(b.check_in)) + ' from ' + esc(b.check_in_time) + '</span></div>' +
      '<div><span class="k">Check-out</span><span class="v">' + esc(day(b.check_out)) + '</span></div>' +
      '<div><span class="k">Guests</span><span class="v">' + esc(b.guests_count) + '</span></div>';

    var v = $('verdict'), photoBtn = $('tophoto'), cardBtn = $('opencard');
    photoBtn.classList.add('hide'); cardBtn.classList.add('hide');

    if (b.state === 'ready') {
      v.innerHTML = '<div class="note ok">Everything is in order. One quick photo and your guest ID is issued.</div>';
      photoBtn.classList.remove('hide');
    } else if (b.state === 'already_checked_in') {
      v.innerHTML = '<div class="note ok">You are already checked in. Your guest ID is ready.</div>';
      if (b.card_url) { cardBtn.href = b.card_url; cardBtn.classList.remove('hide'); }
    } else if (b.state === 'too_early') {
      v.innerHTML = '<div class="note warn">A little early — check-in opens on ' + esc(day(b.check_in)) +
        ' from ' + esc(b.check_in_time) + '. Come back then, or speak to the front desk.</div>';
    } else if (b.state === 'cancelled') {
      v.innerHTML = '<div class="note bad">This booking was cancelled. Please speak to the front desk.</div>';
    } else {
      v.innerHTML = '<div class="note bad">This code is no longer valid. Please speak to the front desk.</div>';
    }
  }
  $('back').onclick = function () { $('code').value = ''; show('s-code'); };
  $('tophoto').onclick = function () { show('s-photo'); };

  // ── Step 3 · camera / gallery / auto-crop ──────────────────────────────────
  $('usecam').onclick = function () {
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    }).then(function (s) {
      stream = s;
      $('cam').srcObject = s;
      $('picker').classList.add('hide');
      $('camview').classList.remove('hide');
      say($('st3'), '');
    }).catch(function () {
      say($('st3'), 'Camera not available — choose a photo from your gallery instead.', true);
    });
  };
  function stopCam() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    $('camview').classList.add('hide');
  }
  $('camcancel').onclick = function () { stopCam(); $('picker').classList.remove('hide'); };

  $('snap').onclick = function () {
    var v = $('cam');
    var c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    stopCam();
    crop(c);
  };

  $('usegallery').onclick = function () { $('file').click(); };
  $('file').onchange = function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var img = new Image();
    img.onload = function () { URL.revokeObjectURL(img.src); crop(img); };
    img.onerror = function () { say($('st3'), 'Could not read that image — try another one.', true); };
    img.src = URL.createObjectURL(f);
    this.value = '';
  };

  // The corporate auto-crop. ID-photo framing: 3:4 portrait, face centred, eyes
  // in the upper third. FaceDetector where the browser has it; a clean centre
  // crop everywhere else. All on the guest's device — the server only ever sees
  // the finished 900×1200 JPEG.
  function crop(src) {
    var W = src.naturalWidth || src.width, H = src.naturalHeight || src.height;
    var finish = function (box) {
      var cw, ch, cx, cy;
      if (box) {
        ch = Math.min(H, box.height * 2.4);
        cw = ch * 3 / 4;
        if (cw > W) { cw = W; ch = cw * 4 / 3; }
        cx = box.x + box.width / 2 - cw / 2;
        cy = box.y + box.height / 2 - ch * 0.42;
      } else {
        if (W / H > 3 / 4) { ch = H; cw = H * 3 / 4; } else { cw = W; ch = W * 4 / 3; }
        cx = (W - cw) / 2; cy = (H - ch) / 2;
      }
      cx = Math.max(0, Math.min(cx, W - cw));
      cy = Math.max(0, Math.min(cy, H - ch));
      var c = document.createElement('canvas');
      c.width = 900; c.height = 1200;
      c.getContext('2d').drawImage(src, cx, cy, cw, ch, 0, 0, 900, 1200);
      PHOTO = c.toDataURL('image/jpeg', 0.85);
      $('preview').src = PHOTO;
      $('picker').classList.add('hide');
      $('cropview').classList.remove('hide');
    };

    if ('FaceDetector' in window) {
      new window.FaceDetector({ fastMode: true }).detect(src).then(function (faces) {
        if (!faces.length) return finish(null);
        faces.sort(function (a, b) {
          return b.boundingBox.width * b.boundingBox.height - a.boundingBox.width * a.boundingBox.height;
        });
        finish(faces[0].boundingBox);
      }).catch(function () { finish(null); });
    } else {
      finish(null);
    }
  }

  $('retake').onclick = function () {
    PHOTO = null;
    $('cropview').classList.add('hide');
    $('picker').classList.remove('hide');
  };

  // ── Step 3 → 4 · the check-in itself ───────────────────────────────────────
  $('usephoto').onclick = function () {
    if (!PHOTO) return;
    $('usephoto').disabled = true;
    say($('st3'), 'Issuing your guest ID…');
    post({ action: 'checkin', code: CODE, photo: PHOTO }).then(function (b) {
      $('usephoto').disabled = false;
      if (!b.ok) return say($('st3'), b.reason || 'Could not check you in — please see the front desk.', true);
      $('donename').textContent = "You're checked in, " + (b.guest_name.split(' ')[0] || 'Guest');
      $('donesub').textContent = 'Your photo ID is issued and stays valid until ' + day(b.valid_until) + '.';
      if (b.card_url) $('donecard').href = b.card_url; else $('donecard').classList.add('hide');
      show('s-done');
    }).catch(function () {
      $('usephoto').disabled = false;
      say($('st3'), 'Could not reach the hotel system. Please try again.', true);
    });
  };
})();
</script>
</body>
</html>`;
