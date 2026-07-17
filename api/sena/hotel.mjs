// ============================================================================
// GET /api/sena/hotel?hotel_id=… — the variables that fill Sena's system prompt.
//
// voice-agent/system-prompt.md is written with {{hotel_name}}, {{check_in_time}},
// {{cancellation_policy}} and the rest left as holes. Somebody has to fill them
// before the bot opens its mouth, and that somebody is the agent — it calls this
// once, at the start of a call, and renders the prompt.
//
// WHY THE AGENT DOES NOT JUST READ THE DATABASE: it is the same rule that kept
// Vapi away from Postgres. The voice layer is the least trusted thing in the
// system — it runs a language model that a caller is actively trying to talk
// into things. It gets an HTTP endpoint that returns seven strings, not a
// connection string. If the agent host is ever compromised, the blast radius is
// a hotel's check-in time, not its guest list.
//
// Behind the same secret as the tool endpoint, for the same reason.
// ============================================================================

import { getServices } from '../../src/services.mjs';
import { secretOk } from './tool.mjs';

const database = () => getServices().db;

export default async function handler(req, res) {
  if (!secretOk(req.headers['x-sena-secret'])) {
    return res.status(401).json({ error: 'unauthorised' });
  }

  const hotelId = req.query?.hotel_id || process.env.SENA_DEFAULT_HOTEL_ID;
  if (!hotelId) return res.status(400).json({ error: 'no hotel_id' });

  try {
    const { rows } = await database().query(
      `select id, name, address, currency, timezone, check_in_time, check_out_time,
              hold_minutes, cancellation_policy, early_late_policy,
              escalation_phone, escalation_whatsapp, knowledge
         from sena_hotels
        where id = $1`,
      [hotelId]
    );

    if (!rows.length) return res.status(404).json({ error: 'unknown hotel' });
    const h = rows[0];

    // The hotel's own reference document, rendered as a whole block so an empty
    // guide leaves NO dangling heading in the prompt (the .md has one hole,
    // {{hotel_reference}}, and this fills it). Clipped: a voice prompt the model
    // must hold in its head every turn should not carry a novel.
    const guide = (h.knowledge || '').trim().slice(0, 5000);
    const hotelReference = guide
      ? `Hotel reference — answer guest questions from this, do not go beyond it:\n"""\n${guide}\n"""`
      : 'The hotel has not supplied a reference document yet, so if a guest asks ' +
        'anything a tool cannot answer, say you will check with the front desk.';

    return res.status(200).json({
      hotel_id: h.id,
      // Exactly the {{...}} holes in system-prompt.md, and nothing else. If you
      // add a placeholder there, add it here, or Sena will read the guest the
      // literal string "{{early_late_policy}}" down the phone.
      prompt_vars: {
        hotel_name: h.name,
        currency: h.currency,
        check_in_time: String(h.check_in_time).slice(0, 5),
        check_out_time: String(h.check_out_time).slice(0, 5),
        hold_minutes: String(h.hold_minutes),
        cancellation_policy: h.cancellation_policy,
        // Nullable in the schema. Left as null it renders the four characters
        // "null" into the prompt, and Sena quotes them to a guest as policy.
        early_late_policy:
          h.early_late_policy || 'The hotel has no published early/late policy — ask the owner.',
        // Sena has no clock. Without this she cannot resolve "tomorrow", and a
        // guest who says "next Friday" gets a booking in the wrong week.
        today: new Date().toISOString().slice(0, 10),
        // The one contact detail Sena is ALLOWED to say aloud: on escalation
        // she reads this out and asks the guest to WhatsApp their situation to
        // the manager directly (see system-prompt.md, Escalation).
        escalation_whatsapp: h.escalation_whatsapp,
        // The hotel's reference document, as a ready-to-drop prompt block.
        hotel_reference: hotelReference,
        // For the "Good morning/afternoon/evening" greeting — the bot computes
        // the time of day in the HOTEL's timezone, not the server's.
        timezone: h.timezone || 'Africa/Johannesburg',
      },
      // Not a prompt variable — the agent needs it when escalate_to_human fires
      // and there is no line to transfer to.
      escalation_phone: h.escalation_phone,
    });
  } catch (err) {
    console.error('[sena] hotel context failed:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
