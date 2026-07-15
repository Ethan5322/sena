// ============================================================================
// GET /api/sena/cron — the work nobody is on the phone for.
//
// Runs once a day (vercel.json → crons). Expires abandoned holds, completes
// stays that ended, emails tomorrow's guests, and sends the owner their morning
// arrivals list.
//
// The logic lives in src/daily.mjs so it can be tested. This file only proves
// the request is really Vercel's cron and not a stranger — without that check,
// anyone could hammer this URL and re-send every guest their reminder.
// ============================================================================

import crypto from 'node:crypto';
// getServices(), not a hand-rolled pair: the daily emails must leave through
// the SAME notifier the rest of the system uses — Resend when RESEND_API_KEY
// is set, SMTP otherwise, owner WhatsApp riding along. A cron with its own
// private mailer is how "the reminders stopped" goes unnoticed for a month.
import { getServices } from '../../src/services.mjs';
import { runDailyJobs } from '../../src/daily.mjs';

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  // Vercel Cron sends: Authorization: Bearer <CRON_SECRET>
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (!authorised(req)) return res.status(401).json({ error: 'unauthorised' });

  try {
    const { db, notifier } = getServices();
    const result = await runDailyJobs(db, notifier);
    console.log('[sena] daily jobs:', result);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[sena] daily jobs failed:', err);
    return res.status(500).json({ error: 'daily jobs failed' });
  }
}
