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
  return `You are Sena, the reception assistant for ${h.name}, chatting with a guest by text.
Today is ${new Date().toISOString().slice(0, 10)}.

ALWAYS DISCLOSE ONCE, in your first message: you are an AI assistant.

STYLE — corporate front desk, in chat:
- Short messages. ONE question at a time, step by step. Never a form-load of questions.
- Warm, precise, never pushy. Use the guest's name once you have it.
- You may show links and codes in chat (unlike on a call).

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

Start by greeting, disclosing you are an AI, and asking how you can help.`;
}

// ── One turn against the LLM ──────────────────────────────────────────────────
async function llm(messages) {
  const base = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!base || !key || !model) return { unconfigured: true };

  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.3, messages, tools: chatTools() }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `llm said ${r.status}`);
  return j.choices?.[0]?.message || { role: 'assistant', content: '' };
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
    return res.status(200).send(PAGE);
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });
  if (throttled(req)) {
    return res.status(429).json({ ok: false, reason: 'Please slow down a little and try again.' });
  }

  const body = req.body || {};
  const session = String(body.session || '').slice(0, 60);
  const history = Array.isArray(body.messages) ? body.messages : [];

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
    const ctx = { providerCallId: session, hotelId };
    const msgs = [
      { role: 'system', content: systemPrompt(h[0]) },
      ...history.filter((m) => m && m.role !== 'system'),
    ];

    const fresh = [];
    const actions = {};

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const msg = await llm(msgs);
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

    return res.status(200).json({ ok: true, messages: fresh, actions });
  } catch (err) {
    console.error('[sena] chat failed:', err);
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
  :root { --ink:#0B1220; --accent:#C8A24B; --paper:#F7F5F2; --line:#E5E7EB; --mut:#6B7280; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100dvh; display:flex; flex-direction:column;
         background:var(--paper); color:var(--ink);
         font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { padding:.9rem 1.1rem; background:#fff; border-bottom:1px solid var(--line);
           display:flex; align-items:center; gap:.7rem; }
  .dot { width:34px; height:34px; border-radius:50%; background:var(--accent); flex:none; }
  header h1 { font-size:1.02rem; margin:0; }
  header p { font-size:.75rem; color:var(--mut); margin:0; }

  #thread { flex:1; overflow-y:auto; padding:1rem; max-width:44rem; width:100%; margin:0 auto; }
  .msg { max-width:85%; padding:.65rem .9rem; border-radius:16px; margin:.3rem 0;
         white-space:pre-wrap; word-wrap:break-word; font-size:.95rem; }
  .msg.sena { background:#fff; border:1px solid var(--line); border-bottom-left-radius:6px; }
  .msg.me   { background:var(--ink); color:#fff; margin-left:auto; border-bottom-right-radius:6px; }
  .typing { color:var(--mut); font-size:.85rem; padding:.4rem .2rem; }

  .action { display:block; max-width:85%; margin:.35rem 0; padding:.8rem 1rem; border-radius:14px;
            text-decoration:none; text-align:center; font-weight:600; font-size:.95rem; }
  .action.pay  { background:var(--accent); color:var(--ink); }
  .action.link { background:#fff; color:var(--ink); border:1px solid #D6D9E0; }
  .codebox { max-width:85%; margin:.35rem 0; padding:.8rem 1rem; border-radius:14px;
             background:#F3F4F6; border:1px dashed #C8A24B; text-align:center; }
  .codebox .k { font-size:.7rem; letter-spacing:.1em; text-transform:uppercase; color:var(--mut); }
  .codebox .v { font:700 1.25rem/1.3 ui-monospace,Consolas,monospace; letter-spacing:.2em; }

  form { display:flex; gap:.55rem; padding:.8rem 1rem calc(.8rem + env(safe-area-inset-bottom));
         background:#fff; border-top:1px solid var(--line); }
  form > div { display:flex; gap:.55rem; max-width:44rem; width:100%; margin:0 auto; }
  input { flex:1; padding:.8rem 1rem; border:1px solid var(--line); border-radius:999px;
          font:inherit; font-size:.95rem; }
  input:focus { outline:2px solid var(--accent); border-color:var(--accent); }
  button { padding:.8rem 1.3rem; border:0; border-radius:999px; background:var(--ink);
           color:#fff; font:600 .95rem/1 inherit; font-family:inherit; cursor:pointer; }
  button:disabled { opacity:.45; }
</style>
</head>
<body>
<header>
  <div class="dot"></div>
  <div>
    <h1>Sena — Reception</h1>
    <p>AI assistant · replies in seconds · never share card numbers in chat</p>
  </div>
</header>

<div id="thread"></div>

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

  var SESSION, HISTORY;
  try {
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
    }).catch(function () {
      t.remove();
      bubble('assistant', 'I could not reach the hotel system — please try again.');
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
    send(text);
  });

  // A fresh visitor should not face an empty void: Sena opens the conversation.
  if (HISTORY.length === 0) send('Hello');
})();
</script>
</body>
</html>`;
