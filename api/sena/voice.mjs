// ============================================================================
// GET /api/sena/voice — the door between "Call Sena" and the voice stack.
//
// The voice stack (LiveKit + the switchboard serving reception.html) is the one
// part of Sena that does not run on Vercel — it lives on whatever box the hotel
// runs it on (docs/voice-stack.md). This endpoint is the stable public address
// the QR landing page can always link to:
//
//   SENA_VOICE_URL set   → 302 to the live reception page. Deploying the voice
//                          box, or pointing a tunnel at the laptop, is ONE env
//                          var — the QR posters never have to be reprinted.
//   SENA_VOICE_URL empty → an honest, branded "the voice line opens soon" page
//                          that still routes the guest somewhere useful
//                          (check-in, or the hotel's phone number).
//
// A dead button that 404s reads as a broken hotel. This is never dead.
// ============================================================================

import { getServices } from '../../src/services.mjs';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default async function handler(req, res) {
  const target = process.env.SENA_VOICE_URL;

  if (target) {
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 302;
    res.setHeader('Location', target);
    return res.end();
  }

  // No voice box on the public internet yet. Say so like a hotel, not a stack
  // trace — and give the guest their real options, including the phone.
  let phone = null;
  try {
    const { db } = getServices();
    const { rows } = await db.query(
      `select escalation_phone from sena_hotels where is_demo limit 1`
    );
    phone = rows[0]?.escalation_phone || null;
  } catch {
    // The page must render even if the database is unreachable.
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
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
  <h1>The voice line opens soon</h1>
  <p>Sena's web call isn't switched on for this address yet.
     ${phone ? 'You can phone reception directly, or' : 'You can'} check in
     below if you already have a booking code.</p>
  ${phone ? `<a class="btn" href="tel:${esc(phone)}">Phone reception ${esc(phone)}</a>` : ''}
  <a class="btn ghost" href="/api/sena/checkin">Check in with my code</a>
</main>
</html>`);
}
