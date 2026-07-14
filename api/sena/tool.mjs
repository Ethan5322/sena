// ============================================================================
// POST /api/sena/tool — the endpoint every one of Sena's tools posts to.
//
// The voice agent (voice-agent/agent/) calls this over HTTP and signs each
// request with SENA_WEBHOOK_SECRET. This handler verifies that secret, routes on
// the tool name, and hands the result back.
//
// THE CONTRACT IS OURS NOW. It used to be Vapi's: a `toolCallList` envelope, an
// `x-vapi-secret` header, a `{results:[{toolCallId, result}]}` reply, all of it
// shaped by a vendor. It is now one tool per request, in the plainest shape that
// works:
//
//   → { "type": "tool-call", "tool": "hold_room", "args": {...}, "call": {...} }
//   ← { "ok": true, "result": { ... } }
//
//   → { "type": "call-ended", "call": {...}, "transcript": "...", "outcome": "booked" }
//   ← { "ok": true }
//
// That is the whole surface. Anything that can speak HTTP can be Sena's voice —
// a Pipecat bot on webRTC today, a SIP trunk tomorrow, a test harness always.
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
export function secretOk(given) {
  const want = process.env.SENA_WEBHOOK_SECRET;
  if (!want || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  if (!secretOk(req.headers['x-sena-secret'])) {
    return res.status(401).json({ error: 'unauthorised' });
  }

  const body = req.body || {};
  const call = body.call || {};

  // Validate the envelope BEFORE touching the database. A malformed request
  // should not open a Postgres pool, and this endpoint should be answerable
  // without one — that is what makes it testable.
  if (body.type !== 'tool-call' && body.type !== 'call-ended') {
    return res.status(400).json({ error: `unknown type: ${body.type}` });
  }
  if (body.type === 'tool-call' && !body.tool) {
    return res.status(400).json({ error: 'no tool named' });
  }

  const ctx = {
    providerCallId: call.id,
    // Which hotel Sena is answering for. On webRTC the room carries it (the
    // server chose it when it minted the token — the browser cannot pick). On a
    // phone line it is the number the guest dialled. See resolveHotelId().
    hotelId: call.hotel_id || null,
    dialedNumber: call.dialed_number || null,
    fromNumber: call.from_number || null,
  };

  const { router } = services();

  try {
    if (body.type === 'call-ended') {
      await router.saveTranscript({
        providerCallId: ctx.providerCallId,
        transcript: body.transcript,
        outcome: body.outcome,
      });
      return res.status(200).json({ ok: true });
    }

    try {
      const result = await router.handle(body.tool, body.args ?? {}, ctx);
      return res.status(200).json({ ok: true, result });
    } catch (err) {
      // Sena's prompt: never explain an error to a guest — escalate. So we hand
      // her an instruction, not a stack trace. The detail goes to the log.
      //
      // 200, not 500, on purpose: this is a tool RESULT, and the agent must put
      // it in front of the model as one. An HTTP error would be retried or
      // swallowed, and Sena would sit in silence while the guest waits.
      console.error(`[sena] tool ${body.tool} failed:`, err);
      return res.status(200).json({
        ok: true,
        result: {
          ok: false,
          reason: err instanceof ToolError ? 'tool_error' : 'internal_error',
          say: 'Something went wrong on our side. Apologise, and escalate to a person.',
        },
      });
    }
  } catch (err) {
    console.error('[sena] handler failed:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
