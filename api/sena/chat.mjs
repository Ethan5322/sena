// ============================================================================
// /api/sena/chat — talk to Sena by typing. The third door on the QR page.
//
// Same brain, same eleven tools, same gates as the voice line — the ROUTER
// decides everything, exactly as it does on a call. What changes is the medium:
// a chat can SHOW things a voice cannot say. The payment link becomes a Pay
// button in the thread; the check-in code arrives as text the guest can copy;
// the guest ID and confirmation PDF are one tap away.
//
//   GET   → the chat page. Static shell; the conversation lives in the
//           browser's sessionStorage and is replayed to the server each turn.
//   POST  → {session, messages} → the agentic loop: model → tool calls →
//           router → model … until Sena has something to say. Returns the new
//           messages plus "actions" (pay button, code, links) for the UI.
//
// STATELESS ON PURPOSE. Vercel functions share nothing; the client carrying
// its own transcript means any instance can serve any turn, and closing the
// tab is the guest hanging up. The tools the model may call come from
// voice-agent/agent-config.json — ONE list for every channel, so a tool the
// chat knows and the router does not cannot exist.
//
// The brain is whatever LLM_* points at (Gemini's free tier in the demo, the
// same OpenAI-compatible seam as the voice bot). No key → an honest 503 page
// state, never a hung spinner.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getServices } from '../../src/services.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The chat background — the hotel's own guest-ID card (name masked), read once
// and injected as a data URI. Full-screen and dimmed dark on the page, so it
// reads as a corporate hotel backdrop, not a distraction. ~19KB.
let cachedBg = null;
function chatBackground() {
  if (cachedBg !== null) return cachedBg;
  try {
    cachedBg =
      'data:image/jpeg;base64,' +
      fs.readFileSync(path.join(ROOT, 'assets', 'brand', 'chat-bg.jpg')).toString('base64');
  } catch {
    cachedBg = ''; // no asset → the page falls back to its dark colour
  }
  return cachedBg;
}

const MAX_MESSAGES = 60; // a booking chat runs ~20; 60 is a stuck loop, not a guest
const MAX_CHARS = 2000;
const MAX_TOOL_ROUNDS = 6;

// ── The eleven tools, translated once: Anthropic shape → OpenAI shape ────────
let cachedTools = null;
export function chatTools() {
  if (cachedTools) return cachedTools;
  const cfg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'voice-agent', 'agent-config.json'), 'utf8')
  );
  cachedTools = cfg.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  return cachedTools;
}

// ── The chat system prompt — the voice prompt's rules, retold for text ───────
function systemPrompt(h) {
  const t = (v) => String(v).slice(0, 5);
  const knowledge = (h.knowledge || '').trim().slice(0, 6000);
  return `You are Sena, the reception assistant for ${h.name}, chatting with a guest by text.
Today is ${new Date().toISOString().slice(0, 10)}.

ALWAYS DISCLOSE ONCE, in your first message: you are an AI assistant.

STAY ON THE JOB. You are the hotel's receptionist and nothing else:
- If the guest drifts off the subject (news, jokes, other businesses, your
  opinions), answer in ONE friendly sentence at most, then steer straight back
  to where you were: "…now, where were we — I still need your email address."
- Never abandon a booking in progress. You hold the thread, not the guest.
- A booking is FINISHED only when the guest has: paid (or chosen to pay at the
  desk), received their CHECK-IN CODE, and been shown the button to download
  their booking confirmation — the document that carries their verification
  number. Walk every booking all the way there.${knowledge ? `

HOTEL REFERENCE — the hotel's own document. Answer questions about the hotel
from THIS text; if the answer is not in it and no tool provides it, say you
will ask the front desk rather than guess:
"""
${knowledge}
"""` : ''}

STYLE — corporate front desk, in chat:
- Short messages. ONE question at a time, step by step. Never a form-load of questions.
- Warm, precise, never pushy. Use the guest's name once you have it.
- You may show links and codes in chat (unlike on a call).

YOU LEAD THE CONVERSATION. A receptionist walks the guest to a finished booking —
never sit back and wait to be asked. Every reply: acknowledge in a few words, then
take the NEXT step yourself. Never end a message without a question or an action
that moves the booking forward. The path for a new booking, in order:
1. Check-in and check-out dates (one question).
2. Call check_availability, then present the available rooms WITH their nightly
   rates and ask which one the guest would like.
3. Guest count, then the details of rule 5 below, one at a time.
4. The full read-back and explicit yes → save_guest_details (double_confirmed: true).
5. send_payment_link → explain the Pay button, the hold window, and the check-in code.
6. When the guest says they have paid: check_payment_status → if paid,
   send_confirmation_package → show the check-in code and the confirmation
   download button (their verification number is on that document), and close
   warmly. That is the finish line — reach it.
If the guest starts mid-path ("do you have a room Friday?"), pick the path up from
that point — do not restart it.
Dates without a year mean the NEXT such dates: state your reading inside your next
message ("July 20–22 this year — noted.") and move on; do not stop just to re-ask.
NEVER proceed to guest details until check_availability has confirmed the chosen
room and dates THIS conversation — even when the guest names a room themselves.

HARD RULES — these are enforced by the tools; do not fight them:
1. Never state a price, availability or policy you did not get from a tool THIS conversation.
2. Never guess names, dates, emails or amounts. Unclear twice → escalate_to_human.
3. Quote the cancellation policy VERBATIM: "${h.cancellation_policy}"
4. NEVER accept card numbers in chat. Payment happens only on the secure Paystack page (the Pay button).
5. Collect booking details ONE AT A TIME: name → phone → email (required — the code and documents go there) → nationality → guest count → special requests. Then repeat the WHOLE block back and ask "Is every detail correct?" Only after an explicit yes, call save_guest_details with double_confirmed: true.
6. After send_payment_link succeeds: tell the guest the Pay button below is theirs, the room is held ${h.hold_minutes} minutes, and their CHECK-IN CODE (shown in chat and emailed) is what they will type on arrival — even if payment completes later, they can check in and settle at the desk.
7. If the guest says they have paid: call check_payment_status, and only if paid, call send_confirmation_package, then show them their check-in code and links.
8. A guest who ALREADY paid earlier does not pay again: look up their booking (lookup_booking), and remind them their check-in code from the email is all they need at the door.
9. Escalation: call escalate_to_human, then give the guest the manager's WhatsApp ${h.escalation_whatsapp} to message directly.
10. Check-in ${t(h.check_in_time)}, check-out ${t(h.check_out_time)}. Early/late: "${h.early_late_policy || 'ask the front desk'}".

Open your FIRST message with exactly this greeting, then follow the guest:
"Welcome to ${h.name}. My name is Sena, the hotel's AI receptionist. I can help
you book a room, manage an existing booking, or answer questions about your
stay. How may I assist you today?"`;
}

// A whole-TURN time budget. A turn can make several LLM calls (the tool loop),
// each of which may retry a 429 — so the ceiling has to be enforced across the
// turn, not per call, or a busy free tier stacks retries past the function's
// own 60s limit and the guest gets a hard timeout instead of an answer.
//
// 18s, not 45: a healthy turn is 2–4s, a turn with a tool round ~8s, so this
// leaves comfortable headroom for a REAL answer — but when the free tier is
// hammered and every call 429s, the guest is handed the booking tree (instant,
// no AI) in eighteen seconds, not left watching a spinner for forty-five. A
// fast honest fallback beats a slow maybe.
const TURN_BUDGET_MS = 18_000;

// How long the free tier told us to wait, if it said. Gemini puts a
// "retryDelay":"5s" in the 429 body; honouring it beats guessing.
function retryDelayMs(body) {
  const m = JSON.stringify(body || {}).match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.min(Number(m[1]) * 1000, 12_000) : 0;
}

// ── One turn against the LLM ──────────────────────────────────────────────────
async function llm(messages, { tools = true, deadline = Date.now() + TURN_BUDGET_MS } = {}) {
  const base = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!base || !key || !model) return { unconfigured: true };

  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          // Disable Gemini's "thinking": on 2.5 models it silently reasons
          // before every reply and doubles the latency, for a receptionist
          // that just needs to ask the next question. A standard OpenAI field
          // other providers ignore.
          reasoning_effort: 'none',
          messages,
          ...(tools ? { tools: chatTools() } : {}),
        }),
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
    } catch (err) {
      // Timed out or network-dropped. Retry only if there is budget left.
      if (Date.now() + 1500 < deadline) { await new Promise((s) => setTimeout(s, 1000)); continue; }
      throw err;
    }
    if (r.status === 429 || r.status >= 500) {
      const body = await r.json().catch(() => ({}));
      const wait = retryDelayMs(body) || Math.min(1500 * (attempt + 1), 6000);
      if (Date.now() + wait + 1000 < deadline) {
        await new Promise((s) => setTimeout(s, wait));
        continue;
      }
      throw new Error(`llm said ${r.status}`);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `llm said ${r.status}`);
    return j.choices?.[0]?.message || { role: 'assistant', content: '' };
  }
}

// ── The guided booking flow — the tree that cannot fail ──────────────────────
// The LLM is a free tier that rate-limits, and a booking must never die with
// the brain (a real guest lost three turns to 429s; that is where this comes
// from). These steps call the ROUTER directly — the same gates, holds and
// double-confirmation the model would have used — with no model in the path.
// Sena the conversationalist is optional; Sena the booking engine is not.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handleFlow(flow, session, router, hotelId, res) {
  const ctx = { providerCallId: session, hotelId };
  const step = String(flow?.step || '');

  if (step === 'rooms') {
    const { check_in, check_out } = flow;
    const guests = Math.max(1, Math.min(8, parseInt(flow.guests, 10) || 1));
    if (!DATE_RE.test(check_in || '') || !DATE_RE.test(check_out || '') || check_out <= check_in) {
      return res.status(200).json({ ok: false, reason: 'Please pick a check-in date and a later check-out date.' });
    }
    if (check_in < new Date().toISOString().slice(0, 10)) {
      return res.status(200).json({ ok: false, reason: 'Check-in cannot be in the past.' });
    }
    const avail = await router.handle('check_availability', { check_in, check_out, guests }, ctx);
    if (!avail?.ok) return res.status(200).json({ ok: false, reason: 'Could not check availability — please try again.' });
    return res.status(200).json({ ok: true, nights: avail.nights, rooms: avail.rooms || [] });
  }

  if (step === 'book') {
    const { check_in, check_out, room_id } = flow;
    const guests = Math.max(1, Math.min(8, parseInt(flow.guests, 10) || 1));
    const name = String(flow.full_name || '').trim().slice(0, 120);
    const phone = String(flow.phone || '').trim().slice(0, 30);
    const email = String(flow.email || '').trim().slice(0, 200);
    const nationality = String(flow.nationality || '').trim().slice(0, 60);
    const requests = String(flow.special_requests || '').trim().slice(0, 500);
    if (!DATE_RE.test(check_in || '') || !DATE_RE.test(check_out || '') || !room_id) {
      return res.status(200).json({ ok: false, reason: 'The booking details are incomplete — please start again.' });
    }
    // Forgiving phone check (7+ digits, any format) — matches the page, so a
    // number the guest already confirmed on-screen is never rejected here.
    if (name.length < 2 || phone.replace(/[^0-9]/g, '').length < 7 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(200).json({
        ok: false,
        reason: 'Please give your full name, a phone number (7+ digits), and a valid email — the payment link and check-in code go to that email.',
      });
    }

    const hold = await router.handle('hold_room', { room_id, check_in, check_out, guests_count: guests }, ctx);
    if (!hold?.ok) {
      return res.status(200).json({
        ok: false,
        reason: hold?.reason === 'room_gone'
          ? 'That room has just been taken — please check availability again.'
          : 'Could not hold the room — please try again.',
        room_gone: true,
      });
    }

    // The review card the guest just confirmed IS the double confirmation: they
    // typed every field themselves and then approved the full block.
    const saved = await router.handle('save_guest_details', {
      booking_id: hold.booking_id,
      full_name: name,
      phone,
      email,
      nationality,
      guests_count: guests,
      special_requests: requests,
      double_confirmed: true,
    }, ctx);
    if (!saved?.ok) {
      return res.status(200).json({ ok: false, reason: 'Could not save your details — please check them and try again.' });
    }

    const pay = await router.handle('send_payment_link', { booking_id: hold.booking_id }, ctx);
    return res.status(200).json({
      ok: true,
      reference: hold.reference,
      total: hold.total,
      currency: hold.currency,
      hold_minutes: hold.hold_minutes,
      pay_url: pay?.pay_url || null,
      check_in_code: pay?.check_in_code || null,
      // The check-in code IS the verification number, and the confirmation
      // document (MuleSoo stamp, terms, QR) now serves pending bookings too —
      // this is the pay-later guest's "download my PDF" button.
      confirmation_url: pay?.check_in_code
        ? '/api/sena/confirmation?v=' + encodeURIComponent(pay.check_in_code)
        : null,
      email_sent: !!pay?.ok,
    });
  }

  return res.status(400).json({ ok: false, reason: 'unknown step' });
}

// ── Repair a client-held transcript into something the LLM API will accept ───
export function repairHistory(history) {
  const clean = [];
  const answered = (i, id) => {
    for (let j = i + 1; j < history.length && history[j]?.role === 'tool'; j++) {
      if (history[j].tool_call_id === id) return true;
    }
    return false;
  };
  const callIds = new Set();
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (!m || m.role === 'system') continue;
    if (m.role === 'tool') {
      // An orphan tool result (its call was lost) is an API error — drop it.
      if (m.tool_call_id && callIds.has(m.tool_call_id)) clean.push(m);
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      // A call without its result is an API error too: keep the words, if any,
      // and shed the dangling calls.
      if (m.tool_calls.every((tc) => answered(i, tc.id))) {
        m.tool_calls.forEach((tc) => callIds.add(tc.id));
        clean.push(m);
      } else if (typeof m.content === 'string' && m.content) {
        clean.push({ role: 'assistant', content: m.content });
      }
      continue;
    }
    if (m.role === 'user' || m.role === 'assistant') clean.push(m);
  }
  return clean;
}

// ── Answer common questions from the Master Guide, with NO AI ────────────────
// The free brain has a daily wall (a guest asked breakfast times and got a
// rate-limit apology, which is absurd — the answer is written down). This does
// deterministic keyword retrieval over the hotel's own guide: it splits the
// guide into paragraphs, scores each against the guest's words, and returns the
// best match when it is clearly relevant. Works with zero AI quota, and adapts
// to whatever the owner writes because it matches words, not fixed labels.
const STOP = new Set(
  ('the a an of to is are do does did you your we our i me my can could would will ' +
   'what when where how much many for on in at and or with have has any please tell ' +
   'about it that this they them there here get got need want know may might should ' +
   'hello hi hey good day morning afternoon evening thanks thank').split(' ')
);

// Words that signal "I want to book", not "I have a question" — these must go to
// the booking tree / the model, never to a static paragraph.
const BOOKING_WORDS = /\b(book|booking|reserve|reservation|availab|room for|stay|night|check ?in|check ?out|pay|cancel)\b/i;

// wi-fi → wifi, check-in → checkin: join hyphenated/apostrophe'd words so a
// guest typing "wifi" matches a guide that wrote "Wi-Fi".
const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/(\w)[-'](\w)/g, '$1$2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function faqFromKnowledge(userText, knowledge) {
  const text = normalize(userText);
  if (!knowledge || !text || BOOKING_WORDS.test(text)) return null;

  const qWords = [...new Set(text.split(' ').filter((w) => w.length > 2 && !STOP.has(w)))];
  if (!qWords.length) return null;

  // Split into paragraphs, then into lines when a paragraph is a block of
  // "LABEL: answer" rows (the guide's FAQ section), so each answer stands alone.
  const chunks = String(knowledge)
    .split(/\n\s*\n/)
    .flatMap((p) => (p.length > 300 ? p.split(/\n/) : [p]))
    .map((c) => c.trim())
    .filter((c) => c.length > 8);

  let best = null;
  let bestScore = 0;
  for (const c of chunks) {
    const words = new Set(normalize(c).split(' '));
    // A label is a genuine "HEADING: answer" prefix — a colon, with only a few
    // words before it. A query word in the label ("PARKING:", "BREAKFAST:")
    // scores 3; the same word merely mentioned in a sentence scores 1. Lines
    // with no real label (room descriptions, behaviour rules) get no free 3,
    // which is what stops "parking?" landing on "…secure parking" or "time"
    // landing on "one question at a time".
    const colon = c.indexOf(':');
    const head = colon > 0 && colon <= 40 ? normalize(c.slice(0, colon)) : '';
    const label = head && head.split(' ').length <= 5 ? head.split(' ') : [];
    // A word matches a label word if equal, or if both are 5+ chars and share
    // their first five — a cheap stemmer so "located" finds "LOCATION".
    const inLabel = (w) => label.some((lw) => lw === w || (lw.length >= 5 && w.length >= 5 && lw.slice(0, 5) === w.slice(0, 5)));
    let score = 0;
    for (const w of qWords) {
      if (inLabel(w)) score += 3;
      else if (words.has(w)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = c; }
  }

  // Require a label hit (3) — that is what stops "parking?" matching a room's
  // "secure parking" amenity instead of the parking answer. Content-only
  // overlap is left to the AI/tree, which is the honest fallback.
  if (!best || bestScore < 3) return null;
  return best.replace(/\s+/g, ' ').trim().slice(0, 600);
}

// ── Throttle: same honest per-instance limiter as check-in ───────────────────
const BUCKET = new Map();
function throttled(req) {
  const ip =
    String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const seen = (BUCKET.get(ip) || []).filter((t) => now - t < 60_000);
  seen.push(now);
  BUCKET.set(ip, seen);
  if (BUCKET.size > 5000) BUCKET.clear();
  return seen.length > 30;
}

export default async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(PAGE.replace('__CHAT_BG__', chatBackground()));
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });
  if (throttled(req)) {
    return res.status(429).json({ ok: false, reason: 'Please slow down a little and try again.' });
  }

  const body = req.body || {};
  const session = String(body.session || '').slice(0, 60);
  const history = Array.isArray(body.messages) ? body.messages : [];

  // The guided booking tree needs a session but no transcript, and no LLM.
  if (session && body.flow) {
    try {
      const { router } = getServices();
      return await handleFlow(body.flow, session, router, process.env.SENA_DEFAULT_HOTEL_ID, res);
    } catch (err) {
      console.error('[sena] booking flow failed:', err);
      return res.status(500).json({ ok: false, reason: 'Something went wrong — please try again.' });
    }
  }

  if (!session || history.length === 0 || history.length > MAX_MESSAGES) {
    return res.status(400).json({ ok: false, reason: 'bad conversation' });
  }
  for (const m of history) {
    if (typeof m?.content === 'string' && m.content.length > MAX_CHARS) {
      return res.status(400).json({ ok: false, reason: 'message too long' });
    }
  }

  try {
    const { db, router } = getServices();
    const hotelId = process.env.SENA_DEFAULT_HOTEL_ID;
    const { rows: h } = await db.query(`select * from sena_hotels where id = $1`, [hotelId]);
    if (!h.length) return res.status(500).json({ ok: false, reason: 'no hotel configured' });

    // The system prompt is OURS, always — the client only ever supplies
    // user/assistant/tool turns, and anything else it claims is discarded.
    // The transcript is also REPAIRED, not trusted: the browser stores it and
    // replays it, and one interrupted request (a timeout, a closed tab) can
    // leave an assistant tool_call without its tool result — which the LLM
    // API then rejects EVERY turn after, bricking the whole conversation.
    const ctx = { providerCallId: session, hotelId };
    const msgs = [
      { role: 'system', content: systemPrompt(h[0]) },
      ...repairHistory(history),
    ];

    const fresh = [];
    const actions = {};
    const deadline = Date.now() + TURN_BUDGET_MS;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const msg = await llm(msgs, { deadline });
      if (msg.unconfigured) {
        return res.status(503).json({
          ok: false,
          reason:
            'The chat brain is not configured on this deployment (LLM_API_KEY). ' +
            'Please call reception or use the check-in page.',
        });
      }

      msgs.push(msg);
      fresh.push(msg);
      if (!msg.tool_calls?.length) break;

      for (const tc of msg.tool_calls) {
        let result;
        try {
          result = await router.handle(
            tc.function.name,
            JSON.parse(tc.function.arguments || '{}'),
            ctx
          );
        } catch (err) {
          console.error(`[sena] chat tool ${tc.function.name} failed:`, err);
          result = {
            ok: false,
            reason: 'tool_error',
            say: 'Apologise, and offer the phone number or the front desk.',
          };
        }

        // What the chat UI can SHOW that a voice cannot say.
        if (result?.pay_url) actions.pay_url = result.pay_url;
        if (result?.check_in_code) actions.check_in_code = result.check_in_code;
        if (result?.card_url) actions.card_url = result.card_url;
        if (result?.confirmation_url) actions.confirmation_url = result.confirmation_url;

        const toolMsg = {
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result ?? {}),
        };
        msgs.push(toolMsg);
        fresh.push(toolMsg);
      }
    }

    // A turn MUST end in words. Two ways it silently doesn't: the round budget
    // runs out right after a tool result (the model never saw it), or the model
    // returns an empty message. Either way the guest watches "typing…" resolve
    // into nothing and calls the whole thing broken — ask once more, without
    // tools so it can only answer in text, and failing that, say something
    // honest rather than nothing.
    const spoke = fresh.some(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()
    );
    if (!spoke) {
      let final;
      try {
        final = await llm(msgs, { tools: false, deadline });
      } catch {
        final = null;
      }
      if (!final || typeof final.content !== 'string' || !final.content.trim()) {
        final = {
          role: 'assistant',
          content:
            'Sorry — that took me a moment too long. Where were we? ' +
            'Tell me the last thing you asked for and I will pick it right up.',
        };
      }
      delete final.tool_calls;
      msgs.push(final);
      fresh.push(final);
    }

    return res.status(200).json({ ok: true, messages: fresh, actions });
  } catch (err) {
    console.error('[sena] chat failed:', err);
    // A rate-limited brain is not a broken hotel. Answer as Sena, steer the
    // guest into the guided booking (which uses no model at all), and keep the
    // conversation alive instead of showing an error card.
    if (/429|rate.?limit/i.test(String(err?.message || ''))) {
      // Before apologising, try to just ANSWER: if the guest asked a question
      // the Master Guide covers, serve it straight from the guide — no AI, no
      // wait. This is what turns a rate-limited brain from "broken" into
      // "slower but still helpful".
      try {
        const last = [...(Array.isArray(req.body?.messages) ? req.body.messages : [])]
          .reverse()
          .find((m) => m?.role === 'user' && typeof m.content === 'string');
        const { db } = getServices();
        const { rows } = await db.query(
          `select knowledge from sena_hotels where id = $1`,
          [process.env.SENA_DEFAULT_HOTEL_ID]
        );
        const answer = faqFromKnowledge(last?.content, rows[0]?.knowledge);
        if (answer) {
          return res.status(200).json({
            ok: true,
            messages: [{ role: 'assistant', content: answer }],
            actions: {},
          });
        }
      } catch (e2) {
        console.error('[sena] faq fallback failed:', e2);
      }
      const busy = {
        role: 'assistant',
        content:
          'I am assisting a number of guests right now, so I may be a little slow. ' +
          'You do not need to wait for me: tap "Book a room" below to complete your booking ' +
          'step by step, or give me a minute and ask again.',
      };
      return res.status(200).json({ ok: true, messages: [busy], actions: { offer_booking: true } });
    }
    return res.status(500).json({
      ok: false,
      reason: 'Something went wrong on our side — please try again, or call reception.',
    });
  }
}

// ── The page ─────────────────────────────────────────────────────────────────
// Same design language as the rest of Sena. The page's own JavaScript uses no
// ${} template literals, so this outer literal needs no escaping.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat with Sena</title>
<style>
  :root { --ink:#0B1220; --ink2:#16203A; --accent:#C8A24B; --accent-2:#B0862F;
          --gold-soft:#E7CE96; --paper:#FBF9F5; --line:#E7E0D4; --mut:#7A7266;
          --sena:#FFFFFF; }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { margin:0; min-height:100dvh; display:flex; flex-direction:column;
         color:#F3EFE7; background:#0B1020;
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  /* The hotel's own guest-ID card (guest name masked), full-screen and zoomed —
     the corporate backdrop the owner asked for. */
  body::before { content:''; position:fixed; inset:0; z-index:-2; pointer-events:none;
    background:#0B1020 center/cover no-repeat fixed url("__CHAT_BG__"); }
  /* Dimmed dark so it never competes with the conversation: a little dark, not
     bright, no distraction. */
  body::after { content:''; position:fixed; inset:0; z-index:-1; pointer-events:none;
    background:linear-gradient(180deg, rgba(9,13,26,.87) 0%, rgba(9,13,26,.91) 55%, rgba(9,13,26,.95) 100%); }

  header { padding:.85rem 1.1rem; display:flex; align-items:center; gap:.8rem;
           background:linear-gradient(180deg,var(--ink),var(--ink2));
           border-bottom:2px solid var(--accent);
           box-shadow:0 2px 16px rgba(11,18,32,.20); }
  .crest { width:40px; height:40px; border-radius:50%; flex:none; display:grid; place-items:center;
           background:radial-gradient(circle at 32% 26%, var(--gold-soft), var(--accent) 55%, var(--accent-2));
           box-shadow:0 2px 8px rgba(0,0,0,.28), inset 0 0 0 1px rgba(255,255,255,.4); }
  .htxt h1 { margin:0; font:600 1.14rem/1.15 Georgia,"Times New Roman",serif; color:#fff; letter-spacing:.01em; }
  .htxt p { margin:.12rem 0 0; font-size:.71rem; letter-spacing:.04em; text-transform:uppercase; color:rgba(255,255,255,.6); }

  #thread { flex:1; overflow-y:auto; padding:1.1rem 1rem; max-width:44rem; width:100%; margin:0 auto; }
  .msg { max-width:82%; padding:.7rem .95rem; border-radius:16px; margin:.4rem 0;
         white-space:pre-wrap; word-wrap:break-word; font-size:.95rem;
         box-shadow:0 6px 18px -8px rgba(0,0,0,.6); }
  /* On the dark card backdrop: Sena speaks in warm white, the guest in gold —
     both read clearly, neither vanishes into the background. */
  .msg.sena { background:var(--sena); color:var(--ink); border-left:3px solid var(--accent);
              border-bottom-left-radius:6px; }
  .msg.me   { color:var(--ink); margin-left:auto; border-bottom-right-radius:6px;
              background:linear-gradient(180deg,var(--gold-soft),var(--accent)); }
  .typing { color:rgba(255,255,255,.62); font-size:.85rem; padding:.4rem .4rem; font-style:italic; }

  .action { display:block; max-width:82%; margin:.4rem 0; padding:.85rem 1rem; border-radius:14px;
            text-decoration:none; text-align:center; font-weight:600; font-size:.95rem;
            box-shadow:0 2px 8px rgba(11,18,32,.10); }
  .action.pay  { background:linear-gradient(180deg,var(--gold-soft),var(--accent)); color:var(--ink); }
  .action.link { background:#fff; color:var(--ink); border:1px solid #DDD3C1; }
  .codebox { max-width:82%; margin:.4rem 0; padding:.85rem 1rem; border-radius:14px;
             background:#FFFDF8; border:1px dashed var(--accent); text-align:center;
             box-shadow:0 1px 3px rgba(11,18,32,.06); }
  .codebox .k { font-size:.68rem; letter-spacing:.12em; text-transform:uppercase; color:var(--mut); }
  .codebox .v { font:700 1.3rem/1.3 ui-monospace,Consolas,monospace; letter-spacing:.22em; color:var(--ink); }

  .quick { display:flex; gap:.5rem; padding:.5rem 1rem 0; max-width:44rem; width:100%; margin:0 auto; }
  .chip { border:1px solid var(--accent); background:rgba(255,255,255,.85); color:var(--ink); border-radius:999px;
          padding:.5rem 1rem; font:600 .85rem/1 system-ui,sans-serif; cursor:pointer;
          box-shadow:0 1px 3px rgba(11,18,32,.08); transition:transform .06s ease, background .15s ease; }
  .chip:hover { background:#fff; }
  .chip:active { transform:translateY(1px); }
  .chip.glow { background:linear-gradient(180deg,var(--gold-soft),var(--accent)); border-color:var(--accent-2); }
  .chiprow { display:flex; flex-wrap:wrap; gap:.45rem; margin:.4rem 0 .55rem; }
  .inline-date { padding:.5rem .75rem; border:1px solid var(--line); border-radius:999px;
                 font:inherit; font-size:.88rem; background:#fff; }
  .fcard { max-width:92%; margin:.4rem 0; padding:.95rem 1.05rem; border-radius:16px; background:#fff;
           border:1px solid var(--line); box-shadow:0 2px 10px rgba(11,18,32,.07); }
  .fcard h3 { margin:0 0 .6rem; font:600 1rem/1.2 Georgia,serif; }
  .roomopt { border:1px solid var(--line); border-radius:14px; padding:.75rem .85rem; margin:.45rem 0;
             background:#fff; box-shadow:0 1px 4px rgba(11,18,32,.06); }
  .roomopt b { font-size:.96rem; }
  .roomopt .meta { color:var(--mut); font-size:.82rem; margin:.15rem 0 .5rem; }
  .fbtn { margin-top:.8rem; width:100%; padding:.8rem 1rem; border:0; border-radius:999px;
          background:linear-gradient(180deg,var(--ink),var(--ink2)); color:#fff;
          font:600 .92rem/1 system-ui,sans-serif; cursor:pointer; }
  .fbtn.gold { background:linear-gradient(180deg,var(--gold-soft),var(--accent)); color:var(--ink); }
  .fbtn:disabled { opacity:.5; }

  form { display:flex; gap:.55rem;
         padding:.75rem 1rem calc(.75rem + env(safe-area-inset-bottom));
         background:rgba(11,16,32,.72); backdrop-filter:blur(12px);
         border-top:1px solid rgba(200,162,75,.28); }
  form > div { display:flex; gap:.55rem; max-width:44rem; width:100%; margin:0 auto; }
  #box { flex:1; padding:.8rem 1.05rem; border:1px solid rgba(255,255,255,.18); border-radius:999px;
          font:inherit; font-size:.95rem; background:#fff; color:var(--ink); }
  #box:focus { outline:2px solid var(--accent); border-color:var(--accent); }
  #send { padding:.8rem 1.35rem; border:0; border-radius:999px; cursor:pointer;
          background:linear-gradient(180deg,var(--ink),var(--ink2)); color:#fff;
          font:600 .95rem/1 system-ui,sans-serif; }
  #send:disabled { opacity:.45; }
  .footmark { text-align:center; font-size:.62rem; letter-spacing:.08em; text-transform:uppercase;
              color:var(--mut); padding:.35rem 0 .5rem; opacity:.7; }
</style>
</head>
<body>
<header>
  <div class="crest" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="#0B1220"
         stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 17.5h14"/>
      <path d="M6.5 17.5a5.5 5.5 0 0 1 11 0"/>
      <path d="M12 6.4V5"/>
      <circle cx="12" cy="3.8" r="1.05" fill="#0B1220" stroke="none"/>
    </svg>
  </div>
  <div class="htxt">
    <h1>Jacaranda Court Hotel</h1>
    <p>Reception · Sena, your AI concierge</p>
  </div>
</header>

<div id="thread"></div>

<div class="quick">
  <button class="chip" id="bookbtn" type="button">📅 Book a room — step by step</button>
</div>

<form id="f">
  <div>
    <input id="box" autocomplete="off" placeholder="Type your message…" maxlength="1500">
    <button id="send" type="submit">Send</button>
  </div>
</form>

<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var thread = $('thread');

  // Bump this whenever the page/flow changes. An old tab keeps its saved
  // conversation in sessionStorage and REPLAYS it — which is why a returning
  // guest kept seeing the "old" Sena. On a version change we drop the stored
  // chat so the fresh page starts clean instead of re-showing yesterday.
  var PAGE_VERSION = '2026-07-18c';

  var SESSION, HISTORY;
  try {
    if (localStorage.getItem('sena_chat_ver') !== PAGE_VERSION) {
      sessionStorage.removeItem('sena_chat_history');
      sessionStorage.removeItem('sena_chat_session');
      localStorage.setItem('sena_chat_ver', PAGE_VERSION);
    }
    SESSION = sessionStorage.getItem('sena_chat_session');
    HISTORY = JSON.parse(sessionStorage.getItem('sena_chat_history') || 'null');
  } catch (e) {}
  if (!SESSION) {
    SESSION = 'chat-' + Math.random().toString(36).slice(2, 12);
    try { sessionStorage.setItem('sena_chat_session', SESSION); } catch (e) {}
  }
  if (!Array.isArray(HISTORY)) HISTORY = [];

  function saveHistory() {
    try { sessionStorage.setItem('sena_chat_history', JSON.stringify(HISTORY)); } catch (e) {}
  }
  function scroll() { thread.scrollTop = thread.scrollHeight; }

  function bubble(role, text) {
    if (!text) return;
    var d = document.createElement('div');
    d.className = 'msg ' + (role === 'user' ? 'me' : 'sena');
    d.textContent = text;
    thread.appendChild(d);
    scroll();
  }

  function renderActions(a) {
    if (!a) return;
    if (a.check_in_code) {
      var c = document.createElement('div');
      c.className = 'codebox';
      c.innerHTML = '<div class="k">Your check-in code</div>';
      var v = document.createElement('div');
      v.className = 'v';
      v.textContent = a.check_in_code;
      c.appendChild(v);
      thread.appendChild(c);
      try { localStorage.setItem('sena_checkin_code', a.check_in_code); } catch (e) {}
    }
    function btn(href, label, cls) {
      var el = document.createElement('a');
      el.className = 'action ' + cls;
      el.href = href;
      el.target = '_blank';
      el.rel = 'noopener';
      el.textContent = label;
      thread.appendChild(el);
    }
    if (a.pay_url) btn(a.pay_url, 'Pay securely with Paystack', 'pay');
    if (a.card_url) btn(a.card_url, 'Open my guest ID (save as photo or PDF)', 'link');
    if (a.confirmation_url) btn(a.confirmation_url, 'Booking confirmation (print / PDF)', 'link');
    if (a.offer_booking) {
      var bb = document.getElementById('bookbtn');
      if (bb) bb.className = 'chip glow';
    }
    scroll();
  }

  // Repaint a returning session: the visible turns only.
  HISTORY.forEach(function (m) {
    if (m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string' && m.content)) {
      bubble(m.role, m.content);
    }
  });

  var busy = false;
  function send(text) {
    if (busy || !text) return;
    busy = true;
    $('send').disabled = true;
    bubble('user', text);
    HISTORY.push({ role: 'user', content: text });
    saveHistory();

    var t = document.createElement('div');
    t.className = 'typing';
    t.textContent = 'Sena is typing…';
    thread.appendChild(t);
    scroll();

    fetch(location.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: SESSION, messages: HISTORY }),
    }).then(function (r) { return r.json(); }).then(function (b) {
      t.remove();
      if (!b.ok) { bubble('assistant', b.reason || 'Something went wrong — please try again.'); return; }
      b.messages.forEach(function (m) {
        HISTORY.push(m);
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content) bubble('assistant', m.content);
      });
      saveHistory();
      renderActions(b.actions);
      reoffer();
    }).catch(function () {
      t.remove();
      bubble('assistant', 'I could not reach the hotel system just now — but I can still book you a room right away.');
      reoffer();
    }).finally(function () {
      busy = false;
      $('send').disabled = false;
      $('box').focus();
    });
  }

  $('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = $('box').value.trim();
    $('box').value = '';
    // Mid-booking, the typed answer belongs to Sena's current question — the
    // flow — not to the language model.
    if (ASK) { answerTyped(text); return; }
    // Typed booking intent goes straight to the reliable step-by-step tree, not
    // the unpredictable free-text AI (which was rejecting good information and
    // stalling). "book", "reserve", "room for", "a night" all start it.
    if (!ASK && !FLOW.check_in && /\b(book|reserve|reservation|room for|a night|nights?|stay over)\b/i.test(text)) {
      me(text); startBooking(); return;
    }
    send(text);
  });

  // ── The guided booking tree — no AI, cannot rate-limit, cannot stall ──────
  var FLOW = {};   // what the guest has chosen so far

  function flowPost(payload, cb, btn) {
    if (btn) btn.disabled = true;
    fetch(location.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: SESSION, flow: payload }),
    }).then(function (r) { return r.json(); }).then(function (b) {
      if (btn) btn.disabled = false;
      cb(b);
    }).catch(function () {
      if (btn) btn.disabled = false;
      cb({ ok: false, reason: 'Could not reach the hotel system — please try again.' });
    });
  }

  function card(title) {
    var c = document.createElement('div');
    c.className = 'fcard';
    if (title) {
      var h = document.createElement('h3');
      h.textContent = title;
      c.appendChild(h);
    }
    thread.appendChild(c);
    scroll();
    return c;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function labelled(parent, text, node) {
    parent.appendChild(el('label', '', text));
    parent.appendChild(node);
    return node;
  }
  function isoPlus(days) {
    var d = new Date(Date.now() + days * 864e5);
    return d.toISOString().slice(0, 10);
  }

  // The flow speaks AS SENA. Every question is a chat bubble, every answer
  // becomes a guest bubble, so the booking reads as one professional
  // conversation — not a form bolted onto a chat (the owner's words: mixing
  // the two "looks stupid". He was right).
  var ASK = null;   // which flow question the typed input currently answers

  function sena(text) { bubble('assistant', text); }
  function me(text) { bubble('user', text); }
  function prettyDate(iso) {
    try { return new Date(iso + 'T12:00:00').toDateString(); } catch (e) { return iso; }
  }

  function chipRow(opts) {
    var row = el('div', 'chiprow');
    opts.forEach(function (o) {
      var b = el('button', 'chip', o.label);
      b.type = 'button';
      b.onclick = function () { row.remove(); o.go(); };
      row.appendChild(b);
    });
    thread.appendChild(row);
    scroll();
    return row;
  }

  function inlineDate(question, min, cb) {
    sena(question);
    var row = el('div', 'chiprow');
    var d = el('input', 'inline-date');
    d.type = 'date'; d.min = min;
    var ok = el('button', 'chip', 'OK');
    ok.type = 'button';
    ok.onclick = function () {
      if (!d.value) return;
      row.remove();
      me(prettyDate(d.value));
      cb(d.value);
    };
    row.appendChild(d); row.appendChild(ok);
    thread.appendChild(row);
    scroll();
  }

  function startBooking() {
    FLOW = {}; ASK = null;
    sena('Wonderful — let us get you booked. I will take you through it step by step.');
    inlineDate('First, on which date would you like to check in?', isoPlus(0), function (v) {
      FLOW.check_in = v;
      inlineDate('And on which date will you check out?', v, function (w) {
        if (w <= v) { sena('Check-out must be after check-in — let us try those dates again.'); startBooking(); return; }
        FLOW.check_out = w;
        askGuests();
      });
    });
  }

  function askGuests() {
    sena('How many guests will be staying?');
    var opts = [];
    for (var i = 1; i <= 6; i++) (function (n) {
      opts.push({ label: String(n), go: function () {
        me(n + (n === 1 ? ' guest' : ' guests'));
        FLOW.guests = n;
        fetchRooms();
      } });
    })(i);
    chipRow(opts);
  }

  function fetchRooms() {
    sena('One moment — let me check what is available for you…');
    flowPost({ step: 'rooms', check_in: FLOW.check_in, check_out: FLOW.check_out, guests: FLOW.guests }, function (b) {
      if (!b.ok) { sena(b.reason); chipRow([{ label: 'Try again', go: startBooking }]); return; }
      if (!b.rooms.length) {
        sena('I am sorry — nothing is free for those dates. Shall we try different dates?');
        chipRow([{ label: 'Try other dates', go: startBooking }]);
        return;
      }
      var lines = b.rooms.map(function (r) {
        return r.name + ' (' + r.plan + ', sleeps ' + r.sleeps + ') — ' + r.currency + ' ' + r.rate +
          ' per night, ' + r.currency + ' ' + r.total + ' for the stay';
      });
      sena('For ' + b.nights + (b.nights === 1 ? ' night' : ' nights') + ', I can offer you:\\n\\n• ' +
        lines.join('\\n• ') + '\\n\\nWhich room would you like to select?');
      chipRow(b.rooms.map(function (r) {
        return { label: r.name, go: function () {
          me(r.name);
          FLOW.room_id = r.room_id; FLOW.room_name = r.name;
          FLOW.total_text = r.currency + ' ' + r.total;
          sena('An excellent choice.');
          askTyped('full_name');
        } };
      }));
    });
  }

  var QUESTIONS = {
    full_name: {
      q: 'May I have your full name as it appears on your ID?',
      bad: 'Could you please provide your full name exactly as it appears on your ID or passport?',
      valid: function (v) { return v.length >= 2; },
    },
    phone: {
      q: 'Thank you. Please enter your phone number (for example +27 82 123 4567).',
      bad: 'I could not read a full number there. Please type your phone number with its digits — spaces, +, brackets and dashes are all fine.',
      // Forgiving on purpose: any format a real number comes in (+27 82…, 0821…,
      // 00251…, (011) 234-5678) passes as long as it has enough digits. The old
      // strict pattern rejected valid numbers and blocked bookings.
      valid: function (v) { return String(v).replace(/[^0-9]/g, '').length >= 7; },
    },
    email: {
      q: 'Your email address? Your payment link, confirmation, and check-in code will be sent there, so please type it carefully.',
      bad: 'That email does not look correct. Could you type it again carefully?',
      valid: function (v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v); },
    },
    nationality: {
      q: 'What is your nationality?',
      valid: function () { return true; },
      optional: true,
    },
    special_requests: {
      q: 'Do you have any special requests for your stay — for example early arrival or a quiet room?',
      valid: function () { return true; },
      optional: true,
    },
  };
  var ORDER = ['full_name', 'phone', 'email', 'nationality', 'special_requests'];

  function askTyped(key) {
    ASK = key;
    sena(QUESTIONS[key].q);
    $('box').placeholder = 'Type your answer…';
    if (QUESTIONS[key].optional) {
      chipRow([{ label: 'Skip', go: function () { me('(skip)'); storeAnswer(key, ''); } }]);
    }
    $('box').focus();
  }

  function answerTyped(text) {
    if (!text) return;
    var key = ASK;
    me(text);
    if (!QUESTIONS[key].valid(text)) { sena(QUESTIONS[key].bad); return; }
    // Remove a lingering Skip chip for this question, if any.
    var rows = thread.querySelectorAll('.chiprow');
    if (rows.length) rows[rows.length - 1].remove();
    storeAnswer(key, text);
  }

  function storeAnswer(key, value) {
    FLOW[key] = value;
    ASK = null;
    $('box').placeholder = 'Type your message…';
    var next = ORDER[ORDER.indexOf(key) + 1];
    if (next) { askTyped(next); return; }
    review();
  }

  function review() {
    sena('Let me confirm your details:\\n\\n' +
      'Name: ' + FLOW.full_name + '\\n' +
      'Phone: ' + FLOW.phone + '\\n' +
      'Email: ' + FLOW.email + '\\n' +
      'Nationality: ' + (FLOW.nationality || '—') + '\\n' +
      'Requests: ' + (FLOW.special_requests || '—') + '\\n' +
      'Stay: ' + prettyDate(FLOW.check_in) + ' to ' + prettyDate(FLOW.check_out) +
      ' · ' + FLOW.guests + ' guest(s)\\n' +
      'Room: ' + FLOW.room_name + ' — total ' + FLOW.total_text + '\\n\\n' +
      'Is every detail correct?');
    chipRow([
      { label: '✓ Yes, everything is correct', go: doBook },
      { label: 'Change my details', go: function () { me('I would like to change something'); askTyped('full_name'); } },
      { label: 'Start over', go: function () { me('Start over'); startBooking(); } },
    ]);
  }

  function doBook() {
    me('Yes, everything is correct');
    sena('Thank you. I am creating your booking now…');
    flowPost({
      step: 'book', check_in: FLOW.check_in, check_out: FLOW.check_out, guests: FLOW.guests,
      room_id: FLOW.room_id, full_name: FLOW.full_name, phone: FLOW.phone, email: FLOW.email,
      nationality: FLOW.nationality || '', special_requests: FLOW.special_requests || '',
    }, function (b) {
      if (!b.ok) {
        sena(b.reason);
        chipRow([{ label: b.room_gone ? 'Check availability again' : 'Try again', go: startBooking }]);
        return;
      }
      payChoice(b);
    });
  }

  function payChoice(b) {
    sena('You are booked, ' + (FLOW.full_name.split(' ')[0]) + '. Your reference is ' + b.reference +
      ' and your total is ' + b.currency + ' ' + b.total + '.' +
      (b.email_sent ? ' I have emailed the full confirmation to you.' : '') +
      '\\n\\nWould you like to pay now, or pay when you arrive?');
    chipRow([
      { label: '💳 Pay now', go: function () {
        me('I will pay now');
        sena('Opening a secure online payment page for you now. Your room will be held for ' +
          b.hold_minutes + ' minutes while you make payment.');
        if (b.pay_url) {
          window.open(b.pay_url, '_blank', 'noopener');
          renderActions({ pay_url: b.pay_url, check_in_code: b.check_in_code });
        }
        finishNote(b);
      } },
      { label: '🏨 Pay on arrival', go: function () {
        me('I will pay on arrival');
        sena('You can also choose to pay on arrival at the front desk. Please download your ' +
          'booking confirmation below. It includes your booking details, terms, and your ' +
          'verification QR code. If you do not arrive within 48 hours of your check-in time, ' +
          'the booking may expire automatically.');
        if (b.confirmation_url) {
          var dl = document.createElement('a');
          dl.className = 'action pay';
          dl.href = b.confirmation_url;
          dl.target = '_blank'; dl.rel = 'noopener';
          dl.textContent = '⬇ Download my booking confirmation (PDF)';
          thread.appendChild(dl);
        }
        renderActions({ check_in_code: b.check_in_code });
        finishNote(b);
      } },
    ]);
  }

  function finishNote(b) {
    sena('On arrival, please enter your check-in code on our reception page or scan the QR code ' +
      'on your confirmation at the desk, and take a quick photo. This issues your guest ID and ' +
      'completes your check-in securely. Is there anything else I can assist you with today?');
  }

  $('bookbtn').onclick = function () { me('I would like to book a room'); startBooking(); };

  // ── Sena opens the conversation HERSELF, instantly, with NO AI ────────────
  // The greeting and the guided booking are scripted and deterministic. They
  // never wait on the rate-limited brain, never stall, never leave the guest
  // typing into a void. The AI is a bonus for free-text questions only — the
  // conversation itself cannot break.
  function timeOfDay() {
    var h = new Date().getHours();
    return h < 12 ? 'morning' : (h < 17 ? 'afternoon' : 'evening');
  }

  function offerHelp() {
    chipRow([
      { label: '📅 Book a room', go: function () { me('I would like to book a room'); startBooking(); } },
      { label: '🛎  Ask a question', go: function () {
        me('I have a question');
        sena('Of course. What would you like to know? You can ask about breakfast, parking, ' +
             'Wi-Fi, check-in times, our location — anything about your stay.');
        $('box').focus();
      } },
    ]);
  }

  function greet() {
    var g1 = 'Good ' + timeOfDay() + ', and a very warm welcome to Jacaranda Court Hotel.';
    var g2 = "My name is Sena, the hotel's AI receptionist. I can book you a room in a few quick " +
             'steps, or answer any question about your stay.';
    var g3 = 'How may I help you today?';
    sena(g1); sena(g2); sena(g3);
    // Seed the transcript so that IF the guest later types a free question, the
    // brain knows it has already greeted and simply continues.
    HISTORY.push({ role: 'assistant', content: g1 + ' ' + g2 + ' ' + g3 });
    saveHistory();
    offerHelp();
  }

  // After Sena answers a typed question, keep the conversation moving instead of
  // going quiet — re-offer the two ways forward.
  function reoffer() {
    if (ASK) return;                 // mid-booking: the flow is already leading
    chipRow([
      { label: '📅 Book a room', go: function () { me('I would like to book a room'); startBooking(); } },
      { label: '🛎  Ask another', go: function () { me('I have another question'); sena('Certainly — what else can I help you with?'); $('box').focus(); } },
    ]);
  }

  if (HISTORY.length === 0) greet();
  else $('box').focus();
})();
</script>
</body>
</html>`;
