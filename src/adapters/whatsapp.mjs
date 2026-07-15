// ============================================================================
// Sena — WhatsApp, for the OWNER only (CLAUDE.md §8).
//
// The guest still gets email, and only email — Meta will not deliver a
// free-form message to someone who merely phoned the hotel (see notifier.mjs).
// The OWNER is different: they run the business, they can open the messaging
// window themselves, and §8 promises them a WhatsApp ping for every booking,
// payment, cancellation and escalation. This adapter is that ping.
//
// Meta WhatsApp Cloud API, straight HTTPS, no SDK. Configure with:
//
//   WHATSAPP_TOKEN             a (permanent) system-user access token
//   WHATSAPP_PHONE_NUMBER_ID   the business number's id from the Meta console
//   WHATSAPP_TEMPLATE_NAME     optional — see below
//
// THE 24-HOUR RULE, honestly: a plain text message is only delivered if the
// recipient messaged the business number within the last 24 hours. For an
// owner who chats to their own hotel number that is always true. For one who
// never does, create a pre-approved utility template with ONE body variable
// (e.g. "sena_alert": "{{1}}") and set WHATSAPP_TEMPLATE_NAME — templates
// deliver regardless of the window. Template parameters may not contain
// newlines, so the text is flattened in that mode.
//
// UNCONFIGURED IS A NORMAL STATE, not an error: send() returns
// { ok:false, skipped:true } and every alert still goes out by email. WhatsApp
// is the fast lane, never the only lane.
// ============================================================================

// ── CallMeBot — the zero-friction alternative ────────────────────────────────
// callmebot.com: the OWNER messages the CallMeBot number once from their own
// WhatsApp, gets an API key back, and from then on a plain GET delivers to
// their phone. No Meta business account, no template review, no 24-hour
// window. The trade: an API key delivers ONLY to the phone it was issued for —
// so `to` is ignored, and a multi-hotel deployment needs one key per owner
// (or the Meta adapter below). For one hotel it is the whole job in one URL.
//
// Configure: CALLMEBOT_PHONE=+27…  CALLMEBOT_APIKEY=…
export function createCallMeBot({ phone, apikey } = {}) {
  const configured = Boolean(phone && apikey);

  return {
    configured,
    provider: 'callmebot',

    /** Deliver `text` to the registered owner phone. `to` is accepted for
     *  interface parity with the Meta adapter, and ignored — see above. */
    async send({ to, text } = {}) {
      if (!configured) {
        return { ok: false, skipped: true, error: 'callmebot is not configured (CALLMEBOT_*)' };
      }
      try {
        const u = new URL('https://api.callmebot.com/whatsapp.php');
        u.searchParams.set('phone', phone);
        u.searchParams.set('apikey', apikey);
        u.searchParams.set('text', String(text ?? ''));
        const r = await fetch(u, { signal: AbortSignal.timeout(15_000) });
        const body = await r.text().catch(() => '');
        if (!r.ok) return { ok: false, error: `callmebot said ${r.status}: ${body.slice(0, 120)}` };
        return { ok: true, id: `callmebot-${Date.now()}` };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };
}

export function createWhatsApp({ token, phoneNumberId, templateName, apiVersion = 'v20.0' } = {}) {
  const configured = Boolean(token && phoneNumberId);

  return {
    configured,

    /** Send `text` to one number (any human formatting: +27 82…, spaces ok). */
    async send({ to, text }) {
      if (!configured) {
        return { ok: false, skipped: true, error: 'whatsapp is not configured (WHATSAPP_*)' };
      }
      const wa = String(to || '').replace(/[^\d]/g, '');
      if (!wa) return { ok: false, error: 'no whatsapp number for this recipient' };

      const body = templateName
        ? {
            messaging_product: 'whatsapp',
            to: wa,
            type: 'template',
            template: {
              name: templateName,
              language: { code: 'en' },
              components: [
                {
                  type: 'body',
                  // Meta rejects template parameters containing newlines/tabs.
                  parameters: [{ type: 'text', text: String(text).replace(/\s+/g, ' ').trim() }],
                },
              ],
            },
          }
        : { messaging_product: 'whatsapp', to: wa, type: 'text', text: { body: String(text) } };

      try {
        const r = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          return { ok: false, error: j?.error?.message || `whatsapp said ${r.status}` };
        }
        return { ok: true, id: j?.messages?.[0]?.id };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };
}
