// ============================================================================
// GET /api/sena/dashboard?key=<SENA_OWNER_KEY> — the owner's live view.
//
// AUTH: one long random key in the URL, compared in constant time — the same
// trust model as the guest card, for the same reason: the owner opens this on
// a phone and on the reception PC, and a login page in front of a read-only
// dashboard is how owners end up not looking at it. The key guards names,
// phones and nationalities (POPIA), so it must be long, random and rotatable:
// change the env var and every old link dies.
//
// It is NOT the webhook secret. The webhook secret can hold rooms and read the
// guest list through the router; this key can only look at this page. Reusing
// one for the other would silently upgrade a leaked dashboard link into a
// booking API.
// ============================================================================

import crypto from 'node:crypto';
import { getServices } from '../../src/services.mjs';
import { renderDashboard } from '../../src/dashboard.mjs';

function keyOk(given) {
  const want = process.env.SENA_OWNER_KEY;
  if (!want || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!process.env.SENA_OWNER_KEY) {
    return res
      .status(500)
      .send('<p>SENA_OWNER_KEY is not set on this deployment, so the dashboard is switched off.</p>');
  }

  const key = req.query?.key || new URL(req.url, 'http://x').searchParams.get('key');
  if (!keyOk(key)) {
    return res.status(401).send('<p>This dashboard link is not valid. Ask for the current one.</p>');
  }

  try {
    const { db } = getServices();
    const html = await renderDashboard({
      db,
      hotelId: process.env.SENA_DEFAULT_HOTEL_ID || null,
    });
    return res.status(200).send(html);
  } catch (err) {
    console.error('[sena] dashboard failed:', err);
    return res.status(500).send('<p>The dashboard could not load. Check the server logs.</p>');
  }
}
