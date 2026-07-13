// ============================================================================
// Sena — how the booking actually reaches the guest.
//
// EMAIL, NOT WHATSAPP. This was not a preference; WhatsApp cannot do the job:
//
//   Meta will not deliver a free-form message to someone who has not messaged
//   YOU first. Our guest phoned the hotel, and a phone call does not open that
//   window. Business-initiated messages require a pre-approved template, which
//   takes days and a verified business. A booking system whose payment link is
//   silently rejected by Meta is a booking system that loses the room while the
//   guest is still on the line.
//
// SMS has no such rule, but a South African number needs a Twilio regulatory
// bundle (proof of address, days of review) and costs per message.
//
// Email has neither problem: it is free, it is instant, it reaches anyone, and
// every guest already gives Sena an address — send_payment_link refuses to run
// without one. So email is the channel.
//
// This is a plain SMTP transport, so it works with Gmail today (an app password,
// no signup) and with a proper bookings@hotel.co.za sender later, without a code
// change. Swapping WhatsApp back in means writing another module with these four
// methods; the router does not change.
//
// A send that fails returns { ok: false } instead of throwing. The router logs it
// to sena_notifications_log and tells Sena to try another way. When an owner says
// "I never got the booking", that table is the answer.
// ============================================================================

import nodemailer from 'nodemailer';

const money = (pkg) => `${pkg.hotel.currency} ${pkg.total.toFixed(2)}`;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A plain, readable HTML shell. Hotel guests read these on a phone, in a hurry. */
const wrap = (accent, title, bodyHtml) => `
<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#0B1220;
            max-width:34rem;margin:0 auto;padding:1.5rem">
  <h1 style="font-size:1.25rem;margin:0 0 1rem;border-bottom:2px solid ${esc(accent)};
             padding-bottom:.5rem">${esc(title)}</h1>
  ${bodyHtml}
  <p style="margin-top:2rem;font-size:.75rem;color:#9CA3AF">
    Sent by Sena, the AI front desk · built by MuleSoo Digital Services
  </p>
</div>`;

const button = (accent, href, label) => `
  <p style="margin:1.5rem 0">
    <a href="${esc(href)}" style="background:${esc(accent)};color:#fff;text-decoration:none;
       padding:.8rem 1.4rem;border-radius:8px;font-weight:600;display:inline-block">${esc(label)}</a>
  </p>
  <p style="font-size:.8rem;color:#6B7280;word-break:break-all">
    Or paste this into your browser:<br>${esc(href)}
  </p>`;

export function createNotifier({ host, port, user, pass, from }) {
  const configured = Boolean(host && user && pass);

  const transport = configured
    ? nodemailer.createTransport({
        host,
        port: Number(port) || 587,
        secure: Number(port) === 465,
        auth: { user, pass },
      })
    : null;

  async function mail({ to, subject, html, text }) {
    if (!configured) return { ok: false, error: 'email is not configured (SMTP_*)' };
    if (!to) return { ok: false, error: 'no email address for this recipient' };
    try {
      const info = await transport.sendMail({
        from: from || user,
        to,
        subject,
        html,
        text,
      });
      return { ok: true, id: info.messageId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return {
    channel: 'email',

    /** The payment link, during the call. The room is held while they pay. */
    async sendPaymentLink({ to, pkg, url }) {
      const a = pkg.hotel.brand_accent;
      return mail({
        to,
        subject: `${pkg.hotel.name} — pay to confirm booking ${pkg.booking.reference}`,
        text:
          `${pkg.hotel.name}\n\nBooking ${pkg.booking.reference}\n` +
          `${money(pkg)} to confirm your room.\n\nPay securely: ${url}\n\n` +
          `This holds your room for ${pkg.hotel.hold_minutes} minutes.`,
        html: wrap(
          a,
          `Confirm your booking`,
          `<p>Your room at <strong>${esc(pkg.hotel.name)}</strong> is being held.</p>
           <p><strong>${esc(money(pkg))}</strong> · booking ${esc(pkg.booking.reference)}</p>
           ${button(a, url, 'Pay securely')}
           <p style="color:#B45309"><strong>We can hold the room for
              ${esc(pkg.hotel.hold_minutes)} minutes.</strong></p>`
        ),
      });
    },

    /** The guest ID. The link IS the card — it carries the QR the desk scans. */
    async sendConfirmation({ to, pkg }) {
      const a = pkg.hotel.brand_accent;
      const dates =
        `${pkg.booking.check_in} from ${String(pkg.hotel.check_in_time).slice(0, 5)} — ` +
        `${pkg.booking.check_out} by ${String(pkg.hotel.check_out_time).slice(0, 5)}`;

      return mail({
        to,
        subject: `${pkg.hotel.name} — you're confirmed (${pkg.booking.reference})`,
        text:
          `${pkg.hotel.name} — you're confirmed.\n\n` +
          `Reference: ${pkg.booking.reference}\nGuest: ${pkg.guest.full_name}\n${dates}\n` +
          `Paid: ${money(pkg)}\n\n` +
          (pkg.card_url
            ? `Your guest ID — open this at the front desk:\n${pkg.card_url}\n\nIt works once.`
            : `Guest ID: ${pkg.guest_id.guest_id_number}`),
        html: wrap(
          a,
          `You're confirmed`,
          `<p>Thank you, ${esc(pkg.guest.full_name)}. Your booking at
              <strong>${esc(pkg.hotel.name)}</strong> is confirmed.</p>
           <table style="width:100%;border-collapse:collapse;font-size:.9rem">
             <tr><td style="padding:.4rem 0;color:#6B7280">Reference</td>
                 <td style="padding:.4rem 0;text-align:right"><strong>${esc(pkg.booking.reference)}</strong></td></tr>
             <tr><td style="padding:.4rem 0;color:#6B7280">Stay</td>
                 <td style="padding:.4rem 0;text-align:right">${esc(dates)}</td></tr>
             <tr><td style="padding:.4rem 0;color:#6B7280">Paid</td>
                 <td style="padding:.4rem 0;text-align:right">${esc(money(pkg))}</td></tr>
           </table>
           ${
             pkg.card_url
               ? `<p style="margin-top:1.5rem">Open your guest ID at the front desk and show the QR code.</p>
                  ${button(a, pkg.card_url, 'Open my guest ID')}
                  <p style="font-size:.8rem;color:#6B7280">It can only be scanned once.</p>`
               : `<p>Guest ID: <strong>${esc(pkg.guest_id.guest_id_number)}</strong></p>`
           }`
        ),
      });
    },

    /** Every completed booking (CLAUDE.md §8). */
    async notifyOwner({ to, pkg }) {
      return mail({
        to,
        subject: `New booking — ${pkg.guest.full_name}, ${pkg.booking.check_in} (${pkg.booking.reference})`,
        text:
          `NEW BOOKING\n\n${pkg.guest.full_name} · ${pkg.guest.phone}\n` +
          `${pkg.guest.nationality || 'nationality not given'}\n` +
          `${pkg.booking.check_in} → ${pkg.booking.check_out}\n` +
          `Paid: ${money(pkg)}\nRef: ${pkg.booking.reference}` +
          (pkg.booking.needs_approval ? `\n\n** Early/late request — needs your approval. **` : ''),
        html: wrap(
          pkg.hotel.brand_accent,
          `New booking`,
          `<p><strong>${esc(pkg.guest.full_name)}</strong> · ${esc(pkg.guest.phone)}<br>
              ${esc(pkg.guest.nationality || 'nationality not given')}</p>
           <p>${esc(pkg.booking.check_in)} → ${esc(pkg.booking.check_out)}<br>
              Paid <strong>${esc(money(pkg))}</strong> · ${esc(pkg.booking.reference)}</p>
           ${
             pkg.booking.needs_approval
               ? `<p style="background:#FEF3C7;padding:.8rem;border-radius:8px;color:#92400E">
                    <strong>Early check-in / late check-out requested.</strong> Needs your approval.</p>`
               : ''
           }`
        ),
      });
    },

    /** A call that needs a person, right now (§3). */
    async alertOwner({ to, subject, text }) {
      return mail({
        to,
        subject: subject || 'Sena — a call needs a person',
        text,
        html: `<div style="font:15px/1.6 sans-serif;color:#0B1220">
                 <h1 style="font-size:1.1rem;color:#B91C1C">A call needs a person</h1>
                 <pre style="font:inherit;white-space:pre-wrap">${esc(text)}</pre>
               </div>`,
      });
    },
  };
}
