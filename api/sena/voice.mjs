// ============================================================================
// /api/sena/voice — the door between "Call Sena" and the voice stack.
//
// The voice stack (the switchboard + LiveKit) is the one part of Sena that does
// not run on Vercel — it lives on whatever box the hotel runs it on, and that
// box's public address can change on every restart (a laptop behind a free
// cloudflared tunnel gets a new URL each time). So the box REGISTERS itself:
//
//   POST, x-sena-secret, {url}   the box announcing "the voice line is HERE" —
//                                sent on startup and heartbeated every few
//                                minutes by scripts/voice-online.mjs
//   GET                          the guest tapping "Call Sena". A fresh
//                                registration → 302 with ?call=1, and the call
//                                starts itself. A quiet heartbeat → an honest,
//                                branded holding page that still routes the
//                                guest somewhere useful.
//
// SENA_VOICE_URL, when set, overrides the whole dance — that is the "the voice
// box has a real permanent address now" case, and it needs no heartbeat.
//
// A dead button that 404s reads as a broken hotel. This is never dead.
// ============================================================================

import { getServices } from '../../src/services.mjs';
import { secretOk } from './tool.mjs';

// A heartbeat every ~4 minutes; anything older than this is a box that went
// away without saying goodbye — a closed laptop, a dropped tunnel.
const FRESH_MS = 15 * 60 * 1000;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function redirect(res, target) {
  // ?call=1 → reception.html starts the call by itself: the guest taps
  // "Call Sena" once and the next thing they do is talk.
  let dest = target;
  try {
    const u = new URL(target);
    u.searchParams.set('call', '1');
    dest = u.toString();
  } catch {
    // Not a parseable URL — pass it through untouched rather than break it.
  }
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 302;
  res.setHeader('Location', dest);
  return res.end();
}

export default async function handler(req, res) {
  const { db } = getServices();

  // ── The box announcing itself ──────────────────────────────────────────────
  if (req.method === 'POST') {
    if (!secretOk(req.headers['x-sena-secret'])) {
      return res.status(401).json({ ok: false, error: 'unauthorised' });
    }
    const url = String(req.body?.url || '').trim();
    if (url && !/^https:\/\/[\w.-]+/.test(url)) {
      return res.status(400).json({ ok: false, error: 'url must be https' });
    }
    // Empty url = a clean sign-off: the box is going away and says so, and the
    // button falls back to the holding page immediately instead of in 15 min.
    await db.query(
      `update sena_hotels set voice_url = $1, voice_url_updated_at = $2 where is_demo`,
      [url || null, url ? new Date() : null]
    );
    return res.status(200).json({ ok: true, registered: url || null });
  }

  // ── The guest tapping "Call Sena" ──────────────────────────────────────────
  if (process.env.SENA_VOICE_URL) return redirect(res, process.env.SENA_VOICE_URL);

  let phone = null;
  let live = null;
  try {
    const { rows } = await db.query(
      `select escalation_phone, voice_url, voice_url_updated_at
         from sena_hotels where is_demo limit 1`
    );
    if (rows.length) {
      phone = rows[0].escalation_phone || null;
      const at = rows[0].voice_url_updated_at ? new Date(rows[0].voice_url_updated_at).getTime() : 0;
      if (rows[0].voice_url && Date.now() - at < FRESH_MS) live = rows[0].voice_url;
    }
  } catch {
    // The page must render even if the database is unreachable.
  }

  if (live) return redirect(res, live);

  // No live voice box right now. Say so like a hotel, not a stack trace — and
  // give the guest their real options, including the phone.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reception — Sena</title>
<style>
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
         background:#F7F5F2; color:#0B1220;
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { width:min(26rem,92vw); text-align:center; padding:2rem; }
  h1 { font-size:1.4rem; margin:0 0 .5rem; }
  p { color:#6B7280; margin:0 0 1.6rem; font-size:.95rem; }
  a.btn { display:block; margin-top:.85rem; padding:1rem 1.25rem; border-radius:999px;
          text-decoration:none; font-weight:600;
          background:#0B1220; color:#fff; }
  a.btn.ghost { background:#fff; color:#0B1220; border:1px solid #D6D9E0; }
</style>
<main>
  <h1>The voice line is closed right now</h1>
  <p>Sena's web call isn't available at this moment.
     ${phone ? 'You can phone reception directly, or' : 'You can'} check in
     below if you already have a booking code.</p>
  ${phone ? `<a class="btn" href="tel:${esc(phone)}">Phone reception ${esc(phone)}</a>` : ''}
  <a class="btn ghost" href="/api/sena/checkin">Check in with my code</a>
</main>
</html>`);
}
