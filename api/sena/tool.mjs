// ============================================================================
// POST /api/sena/tool — the endpoint every one of Sena's tools posts to.
//
// vapi-config.json points `server.url` here and signs each request with
// `server.secret`. This handler verifies that secret, routes on the tool name,
// and hands the result back in the shape Vapi expects.
//
// WHY THE SECRET CHECK IS NOT OPTIONAL: this endpoint holds a room, saves a
// guest and reads bookings. Unauthenticated, it is a public API for reserving a
// hotel's entire inventory and reading its guest list — names, phones,
// nationalities. That is a POPIA breach with a URL.
// ============================================================================

import crypto from 'node:crypto';
import { createPgDb } from '../../src/db.mjs';
import { createRouter, ToolError } from '../../src/router.mjs';
import { createPaystack } from '../../src/adapters/paystack.mjs';
import { createNotifier } from '../../src/adapters/notifier.mjs';

// Reused across warm invocations; a fresh pool per call exhausts Supabase.
let cached;
function services() {
  if (cached) return cached;

  const db = createPgDb(process.env.DATABASE_URL);
  const paystack = createPaystack({
    secretKey: process.env.PAYSTACK_SECRET_KEY,
    callbackUrl: process.env.PAYSTACK_CALLBACK_URL,
  });
  const notifier = createNotifier({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM,
  });

  cached = {
    db,
    router: createRouter({
      db,
      paystack,
      notifier,
      defaultHotelId: process.env.SENA_DEFAULT_HOTEL_ID || null,
      publicUrl: process.env.SENA_PUBLIC_URL || '',
    }),
  };
  return cached;
}

/** Constant-time, so the secret cannot be recovered a byte at a time. */
function secretOk(given) {
  const want = process.env.SENA_WEBHOOK_SECRET;
  if (!want || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  if (!secretOk(req.headers['x-vapi-secret'])) {
    return res.status(401).json({ error: 'unauthorised' });
  }

  const message = req.body?.message;
  if (!message) return res.status(400).json({ error: 'no message' });

  const { router } = services();

  const call = message.call || {};
  const ctx = {
    providerCallId: call.id,
    // The number the guest dialled — this is what identifies WHICH hotel Sena is
    // answering for. Multi-tenancy is decided right here.
    dialedNumber: call.phoneNumber?.number || message.phoneNumber?.number || null,
    fromNumber: call.customer?.number || message.customer?.number || null,
  };

  try {
    if (message.type === 'end-of-call-report') {
      await router.saveTranscript({
        providerCallId: ctx.providerCallId,
        transcript: message.artifact?.transcript || message.transcript,
        outcome: message.endedReason,
      });
      return res.status(200).json({ ok: true });
    }

    if (message.type !== 'tool-calls') {
      return res.status(200).json({ ok: true, ignored: message.type });
    }

    const results = [];
    for (const tc of message.toolCallList || []) {
      const name = tc.function?.name || tc.name;
      let args = tc.function?.arguments ?? tc.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }

      try {
        const result = await router.handle(name, args, ctx);
        results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
      } catch (err) {
        // Sena's prompt: never explain an error to a guest — escalate. So we
        // hand her an instruction, not a stack trace. The detail goes to the log.
        console.error(`[sena] tool ${name} failed:`, err);
        results.push({
          toolCallId: tc.id,
          result: JSON.stringify({
            ok: false,
            reason: err instanceof ToolError ? 'tool_error' : 'internal_error',
            say: 'Something went wrong on our side. Apologise, and escalate to a person.',
          }),
        });
      }
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error('[sena] handler failed:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
