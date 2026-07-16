// ============================================================================
// POST /api/sena/paystack-webhook — the moment a hold becomes a booking.
//
// This is the ONLY place in the system that may set a booking to `confirmed`.
// Sena cannot do it. The front desk cannot do it. Money landing does it.
//
// This handler does exactly two things: it proves the request really came from
// Paystack, then hands off to applyChargeSuccess() in src/payments.mjs — where
// the underpayment and idempotency rules live, and where the tests can attack
// them. Nothing that matters is decided in this file.
//
// The signature check is not optional. Without it, this endpoint is a public URL
// that confirms free hotel bookings for anyone who reads our source.
// ============================================================================

import crypto from 'node:crypto';
import { getServices } from '../../src/services.mjs';
import {
  applyChargeSuccess,
  notifyPaymentLanded,
  notifyPaymentProblem,
  issueConfirmationPackage,
} from '../../src/payments.mjs';

export const config = {
  // The HMAC is computed over the RAW bytes. Let Vercel parse the body first and
  // the signature will never match. This must stay off.
  api: { bodyParser: false },
};

// getServices(), not a raw pool: same database, and it brings the notifier —
// the owner's "money landed" ping leaves from here.
const database = () => getServices().db;

const readRaw = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(500).json({ error: 'not configured' });

  const raw = await readRaw(req);

  const expected = crypto.createHmac('sha512', secret).update(raw).digest('hex');
  const given = Buffer.from(String(req.headers['x-paystack-signature'] || ''));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'bad signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'bad json' });
  }

  // Acknowledge anything else, or Paystack retries it forever.
  if (event.event !== 'charge.success') {
    return res.status(200).json({ ok: true, ignored: event.event });
  }

  try {
    const result = await applyChargeSuccess(database(), event);
    if (result.outcome === 'paid_room_gone' || result.outcome === 'paid_but_cancelled') {
      // Real money, no room. A human decides — loudly, on both channels.
      console.error(`[sena] paystack ${result.outcome} on ${result.reference}`, result);
      await notifyPaymentProblem(database(), getServices().notifier, result.reference, result.outcome);
    } else if (result.outcome !== 'confirmed') {
      console.error(`[sena] paystack ${result.outcome} on ${result.reference}`, result);
    } else {
      // §8: the owner hears about money the moment it lands — WhatsApp +
      // email. 'confirmed' fires exactly once per booking, so this does too.
      await notifyPaymentLanded(database(), getServices().notifier, result.reference);

      // And the GUEST's confirmation — the check-in code, the card link — goes
      // out automatically, right now. The guest must never depend on the call
      // still being live, or on anyone remembering: money in, code out.
      try {
        const pkg = await issueConfirmationPackage(
          database(),
          getServices().notifier,
          result.reference,
          process.env.SENA_PUBLIC_URL || ''
        );
        if (!pkg.ok) console.error(`[sena] auto-confirmation not issued: ${pkg.reason}`, result);
      } catch (err) {
        console.error('[sena] auto-confirmation failed:', err);
      }
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('[sena] paystack webhook failed:', err);
    // A 500 tells Paystack to retry, which is what we want for a transient
    // database blip — the money is real and the booking must eventually confirm.
    return res.status(500).json({ error: 'internal error' });
  }
}
