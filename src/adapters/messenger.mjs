// ============================================================================
// Sena — WhatsApp (Meta Cloud API) with an SMS fallback (Twilio).
//
// Delivery is not optional decoration: the payment link and the QR guest ID are
// how the booking actually reaches the guest. So a send that fails returns
// { ok: false } rather than throwing — the router logs it to
// sena_notifications_log and tells Sena to offer another channel. When an owner
// says "I never got the booking", that table is the answer.
//
// NOTE ON THE CONFIRMATION PDF: build step 4 is not finished. Until it is,
// sendConfirmation delivers the booking details and the QR payload as text, and
// says so honestly — it does NOT pretend a PDF went out. The moment the PDF
// pipeline lands, attach it here and nothing else changes.
// ============================================================================

const GRAPH = 'https://graph.facebook.com/v21.0';

export function createMessenger({
  whatsappToken,
  whatsappPhoneId,
  twilioSid,
  twilioToken,
  twilioFrom,
}) {
  async function whatsapp(to, text) {
    if (!whatsappToken || !whatsappPhoneId) {
      return { ok: false, error: 'whatsapp not configured' };
    }
    try {
      const res = await fetch(`${GRAPH}/${whatsappPhoneId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${whatsappToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/[^\d]/g, ''),
          type: 'text',
          text: { preview_url: true, body: text },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error?.message || `http ${res.status}` };
      return { ok: true, id: body.messages?.[0]?.id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function sms(to, text) {
    if (!twilioSid || !twilioToken || !twilioFrom) {
      return { ok: false, error: 'sms not configured' };
    }
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: twilioFrom, Body: text }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.message || `http ${res.status}` };
      return { ok: true, id: body.sid };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  const money = (pkg) => `${pkg.hotel.currency} ${pkg.total.toFixed(2)}`;

  return {
    async send({ channel, to, text }) {
      // WhatsApp first, SMS if it bounces. A payment link that silently fails to
      // arrive is a booking the hotel loses while the guest waits on the line.
      if (channel === 'sms') return sms(to, text);
      const wa = await whatsapp(to, text);
      return wa.ok ? wa : sms(to, text);
    },

    async sendConfirmation({ to, pkg }) {
      const text =
        `${pkg.hotel.name} — you're confirmed.\n\n` +
        `Reference: ${pkg.booking.reference}\n` +
        `Guest: ${pkg.guest.full_name}\n` +
        `Check-in: ${pkg.booking.check_in} from ${pkg.hotel.check_in_time}\n` +
        `Check-out: ${pkg.booking.check_out} by ${pkg.hotel.check_out_time}\n` +
        `Paid: ${money(pkg)}\n\n` +
        `Guest ID: ${pkg.guest_id.guest_id_number}\n` +
        `Show this at the front desk. It works once.`;
      return this.send({ channel: 'whatsapp', to, text });
    },

    async notifyOwner({ to, pkg }) {
      const text =
        `SENA — new booking.\n\n` +
        `${pkg.guest.full_name} · ${pkg.guest.phone}\n` +
        `${pkg.guest.nationality || 'nationality not given'}\n` +
        `${pkg.booking.check_in} → ${pkg.booking.check_out}\n` +
        `Paid: ${money(pkg)}\n` +
        `Ref: ${pkg.booking.reference}` +
        (pkg.booking.needs_approval ? `\n\n⚠ Early/late request — needs your approval.` : '');
      return this.send({ channel: 'whatsapp', to, text });
    },

    async alertOwner({ to, text }) {
      return this.send({ channel: 'whatsapp', to, text });
    },
  };
}
