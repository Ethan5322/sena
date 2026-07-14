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
import { createPgDb } from '../../src/db.mjs';
import { createNotifier } from '../../src/adapters/notifier.mjs';
import { runDailyJobs } from '../../src/daily.mjs';

let cached;
function services() {
  if (cached) return cached;
  const db = createPgDb(process.env.DATABASE_URL);
  const notifier = createNotifier({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM,
  });
  cached = { db, notifier };
  return cached;
}

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
    const { db, notifier } = services();
    const result = await runDailyJobs(db, notifier);
    console.log('[sena] daily jobs:', result);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[sena] daily jobs failed:', err);
    return res.status(500).json({ error: 'daily jobs failed' });
  }
}
