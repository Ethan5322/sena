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
// Two transports behind one seam: the Resend HTTP API when RESEND_API_KEY is
// set (the serverless-native path — one HTTPS call, delivery visible on their
// dashboard), or plain SMTP, which works with Gmail today (an app password, no
// signup) and a proper bookings@hotel.co.za sender later. Either way the
// router sees the same four methods and does not change.
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

// `whatsapp` is optional (src/adapters/whatsapp.mjs). When present, every
// OWNER-facing send goes out on both channels: email is the record, WhatsApp is
// the tap on the shoulder. Guests never get WhatsApp — see the header above.
//
// TWO WAYS OUT OF THE BUILDING, one seam. `resendApiKey` set → the Resend HTTP
// API (api.resend.com), which is the right transport on serverless: one HTTPS
// call, no SMTP handshake to time out mid-function, delivery tracked on their
// dashboard. Otherwise plain SMTP as always. Same four methods either way.
export function createNotifier({ host, port, user, pass, from, resendApiKey = null, whatsapp = null }) {
  // A `.env` file strips wrapping quotes; the Vercel dashboard stores them
  // literally. `"Hotel <a@b.c>"` with the quotes kept is an invalid From that
  // fails EVERY send — so shed one layer of wrapping quotes here, where both
  // worlds meet, instead of asking every operator to know the difference.
  from = String(from || '').trim().replace(/^(['"])(.*)\1$/, '$2') || undefined;

  const viaResend = Boolean(resendApiKey);
  const configured = viaResend || Boolean(host && user && pass);

  const transport =
    configured && !viaResend
      ? nodemailer.createTransport({
          host,
          port: Number(port) || 587,
          secure: Number(port) === 465,
          auth: { user, pass },
        })
      : null;

  async function mail({ to, subject, html, text }) {
    if (!configured) return { ok: false, error: 'email is not configured (RESEND_API_KEY or SMTP_*)' };
    if (!to) return { ok: false, error: 'no email address for this recipient' };

    if (viaResend) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            // Until a domain is verified with Resend, only their onboarding
            // sender delivers — see .env.example.
            from: from || 'Sena <onboarding@resend.dev>',
            to: [to],
            subject,
            html,
            text,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, error: j?.message || `resend said ${r.status}` };
        return { ok: true, id: j?.id };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

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

  /** The WhatsApp leg. Never throws; { skipped:true } when not configured. */
  async function ping(to, text) {
    if (!whatsapp || !to) return { ok: false, skipped: true, error: 'no whatsapp' };
    return whatsapp.send({ to, text });
  }

  return {
    channel: 'email',

    /** The payment link, during the call. The room is held while they pay.
     *  Detailed on purpose: a payment request that does not say exactly what
     *  is being bought, from whom, for which nights, reads as phishing. */
    async sendPaymentLink({ to, pkg, url }) {
      const a = pkg.hotel.brand_accent;
      const firstName = (pkg.guest.full_name || 'Guest').split(/\s+/)[0];
      const roomName = pkg.room
        ? pkg.room.plan
          ? `${pkg.room.name} · ${pkg.room.plan}`
          : pkg.room.name
        : 'your room';
      const nights = Math.max(
        1,
        Math.round((new Date(pkg.booking.check_out) - new Date(pkg.booking.check_in)) / 864e5)
      );
      const inLine = `${pkg.booking.check_in} from ${String(pkg.hotel.check_in_time).slice(0, 5)}`;
      const outLine = `${pkg.booking.check_out} by ${String(pkg.hotel.check_out_time).slice(0, 5)}`;

      const row = (k, v, strong = false) =>
        `<tr><td style="padding:.4rem 0;color:#6B7280">${esc(k)}</td>
             <td style="padding:.4rem 0;text-align:right">${strong ? '<strong>' : ''}${esc(v)}${strong ? '</strong>' : ''}</td></tr>`;

      return mail({
        to,
        subject: `${pkg.hotel.name} — complete your booking ${pkg.booking.reference} · ${money(pkg)}`,
        text:
          `Dear ${pkg.guest.full_name},\n\n` +
          `Thank you for choosing ${pkg.hotel.name}. As discussed with Sena, our ` +
          `reception assistant, your room is being held while you complete payment.\n\n` +
          `YOUR BOOKING\n` +
          `  Reference   ${pkg.booking.reference}\n` +
          `  Room        ${roomName}\n` +
          `  Check-in    ${inLine}\n` +
          `  Check-out   ${outLine}\n` +
          `  Stay        ${nights} night${nights === 1 ? '' : 's'} · ${pkg.booking.guests_count} guest${Number(pkg.booking.guests_count) === 1 ? '' : 's'}\n` +
          `  Total due   ${money(pkg)}\n\n` +
          `PAY SECURELY (Paystack):\n${url}\n\n` +
          `Your room is held for ${pkg.hotel.hold_minutes} minutes. If payment is not ` +
          `completed in that time, the room is released for other guests.\n\n` +
          (pkg.guest_id
            ? `YOUR CHECK-IN CODE: ${pkg.guest_id.verification_number}\n` +
              `This is the code you will type on our reception page when you arrive — ` +
              `NOT the booking reference above. Keep this email.\n\n`
            : '') +
          `WHAT HAPPENS NEXT\n` +
          `Once payment is received your booking is confirmed and your digital ` +
          `guest ID follows by email. If you arrive before payment completes, you ` +
          `can still check in with the code above — your ID will show "payment ` +
          `pending" and you can settle at the front desk. Payment is processed ` +
          `entirely by Paystack; we never see or store your card details.\n\n` +
          `We look forward to welcoming you.\n${pkg.hotel.name}` +
          (pkg.hotel.address ? `\n${pkg.hotel.address}` : ''),
        html: wrap(
          a,
          `Complete your booking`,
          `<p>Dear ${esc(pkg.guest.full_name)},</p>
           <p>Thank you for choosing <strong>${esc(pkg.hotel.name)}</strong>. As discussed
              with Sena, our reception assistant, your room is being held while you
              complete payment.</p>
           <table style="width:100%;border-collapse:collapse;font-size:.9rem">
             ${row('Reference', pkg.booking.reference, true)}
             ${row('Room', roomName)}
             ${row('Check-in', inLine)}
             ${row('Check-out', outLine)}
             ${row('Stay', `${nights} night${nights === 1 ? '' : 's'} · ${pkg.booking.guests_count} guest${Number(pkg.booking.guests_count) === 1 ? '' : 's'}`)}
             ${row('Total due', money(pkg), true)}
           </table>
           ${button(a, url, `Pay ${money(pkg)} securely`)}
           <p style="background:#FEF3C7;padding:.8rem 1rem;border-radius:8px;color:#92400E;font-size:.9rem">
             <strong>Your room is held for ${esc(pkg.hotel.hold_minutes)} minutes.</strong>
             If payment is not completed in that time, the room is released for other guests.</p>
           ${
             pkg.guest_id
               ? `<p style="margin:1.4rem 0 .3rem;font-size:.8rem;letter-spacing:.08em;
                            text-transform:uppercase;color:#6B7280">Your check-in code</p>
                  <p style="margin:0;padding:.9rem 1rem;background:#F3F4F6;border-radius:10px;
                            text-align:center;font:700 1.4rem/1.2 ui-monospace,Consolas,monospace;
                            letter-spacing:.25em">${esc(pkg.guest_id.verification_number)}</p>
                  <p style="font-size:.82rem;color:#6B7280;margin-top:.5rem">
                    This is the code you will type on our reception page when you arrive —
                    <strong>not</strong> the booking reference above. Keep this email.</p>`
               : ''
           }
           <p style="margin:1.4rem 0 .3rem;font-size:.8rem;letter-spacing:.08em;
                     text-transform:uppercase;color:#6B7280">What happens next</p>
           <p style="font-size:.9rem">Once payment is received your booking is confirmed and your
              digital guest ID follows by email. Arriving before payment completes? You can still
              check in with the code above — your ID will show <strong>payment pending</strong>
              and you can settle at the front desk.</p>
           <p style="font-size:.8rem;color:#6B7280">Payment is processed securely by Paystack.
              ${esc(pkg.hotel.name)} never sees or stores your card details.</p>`
        ),
      });
    },

    /** The guest ID. The link IS the card — and the CODE is the door: typed at
     *  the self check-in page on arrival, or scanned as the QR at the desk. */
    async sendConfirmation({ to, pkg }) {
      const a = pkg.hotel.brand_accent;
      const code = pkg.guest_id.verification_number;
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
          `YOUR CHECK-IN CODE: ${code}\n\n` +
          `When you arrive, open the hotel's reception page, choose "check in with ` +
          `your code", enter the code above and take a quick photo — your photo ` +
          `guest ID is issued on the spot. The code works once and remains valid ` +
          `until you check in or your stay ends; your photo ID then carries you ` +
          `to check-out.\n\n` +
          (pkg.card_url
            ? `Prefer the front desk? Open your guest ID and show the QR:\n${pkg.card_url}`
            : `Guest ID: ${pkg.guest_id.guest_id_number}`) +
          (pkg.confirmation_url
            ? `\n\nYour booking confirmation (print or save as PDF):\n${pkg.confirmation_url}`
            : ''),
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

           <p style="margin:1.6rem 0 .4rem;font-size:.8rem;letter-spacing:.08em;
                     text-transform:uppercase;color:#6B7280">Your check-in code</p>
           <p style="margin:0;padding:.9rem 1rem;background:#F3F4F6;border-radius:10px;
                     text-align:center;font:700 1.5rem/1.2 ui-monospace,Consolas,monospace;
                     letter-spacing:.25em">${esc(code)}</p>
           <p style="font-size:.85rem;color:#6B7280;margin-top:.6rem">
             When you arrive, open the hotel's reception page, choose
             <strong>check in with your code</strong>, enter this code and take a
             quick photo — your photo guest ID is issued on the spot. The code
             works once and remains valid until you check in or your stay ends;
             your photo ID then carries you to check-out.</p>
           ${
             pkg.card_url
               ? `<p style="margin-top:1.5rem">Prefer the front desk? Open your guest ID and show the QR.</p>
                  ${button(a, pkg.card_url, 'Open my guest ID')}
                  <p style="font-size:.8rem;color:#6B7280">It can only be scanned once.</p>`
               : `<p>Guest ID: <strong>${esc(pkg.guest_id.guest_id_number)}</strong></p>`
           }
           ${
             pkg.confirmation_url
               ? `<p style="font-size:.85rem"><a href="${esc(pkg.confirmation_url)}" style="color:#0B1220">
                    Your booking confirmation</a> — print it or save it as a PDF.</p>`
               : ''
           }`
        ),
      });
    },

    /** Every completed booking (CLAUDE.md §8). Email + owner WhatsApp. */
    async notifyOwner({ to, pkg }) {
      const wa = await ping(
        pkg.hotel.escalation_whatsapp,
        `🏨 NEW BOOKING — ${pkg.hotel.name}\n` +
          `${pkg.guest.full_name} · ${pkg.guest.phone}\n` +
          `${pkg.booking.check_in} → ${pkg.booking.check_out}\n` +
          `Paid ${money(pkg)} · ${pkg.booking.reference}` +
          (pkg.booking.needs_approval ? `\n⚠ Early/late request — needs your approval` : '')
      );
      const sent = await mail({
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
      return { ...sent, whatsapp: wa };
    },

    /** The day before arrival (§2 stage 10). */
    async sendPreArrival({ to, booking, hotel }) {
      const a = hotel.brand_accent;
      const card = booking.verification_number
        ? `${process.env.SENA_PUBLIC_URL || ''}/api/sena/card?v=${booking.verification_number}`
        : null;

      return mail({
        to,
        subject: `${hotel.name} — see you tomorrow (${booking.reference})`,
        text:
          `${hotel.name}\n\nWe look forward to seeing you tomorrow.\n\n` +
          `${booking.room_name}\nCheck-in from ${String(hotel.check_in_time).slice(0, 5)}\n` +
          `${hotel.address || ''}\n\n` +
          (card ? `Your guest ID: ${card}\n\n` : '') +
          `Reference: ${booking.reference}`,
        html: wrap(
          a,
          `See you tomorrow`,
          `<p>We look forward to welcoming you to <strong>${esc(hotel.name)}</strong>.</p>
           <p>${esc(booking.room_name)}<br>
              Check-in from <strong>${esc(String(hotel.check_in_time).slice(0, 5))}</strong><br>
              ${esc(hotel.address || '')}</p>
           ${card ? button(a, card, 'Open my guest ID') : ''}
           <p style="font-size:.8rem;color:#6B7280">Reference ${esc(booking.reference)}</p>`
        ),
      });
    },

    /** The owner's morning list (§8). One email, not one per booking. */
    async sendDailySummary({ to, hotel, arrivals, departures, revenue }) {
      const a = hotel.brand_accent;
      const line = (b) =>
        `${b.full_name || 'guest'} · ${b.room_name} · ${b.reference}` +
        (b.arrival_time ? ` · arriving ${String(b.arrival_time).slice(0, 5)}` : '') +
        (b.needs_approval ? `  ** NEEDS YOUR APPROVAL **` : '');

      const rows = (list, empty) =>
        list.length
          ? list
              .map(
                (b) =>
                  `<tr><td style="padding:.5rem 0;border-bottom:1px solid #E5E7EB">
                     <strong>${esc(b.full_name || 'guest')}</strong> · ${esc(b.room_name)}<br>
                     <span style="color:#6B7280;font-size:.85rem">${esc(b.reference)}${
                       b.arrival_time ? ` · arriving ${esc(String(b.arrival_time).slice(0, 5))}` : ''
                     }</span>
                     ${
                       b.needs_approval
                         ? `<br><span style="color:#B45309;font-size:.85rem"><strong>Needs your approval</strong>${
                             b.special_requests ? ` — ${esc(b.special_requests)}` : ''
                           }</span>`
                         : ''
                     }
                   </td></tr>`
              )
              .join('')
          : `<tr><td style="padding:.5rem 0;color:#9CA3AF">${esc(empty)}</td></tr>`;

      return mail({
        to,
        subject: `${hotel.name} — ${arrivals.length} arriving, ${departures.length} leaving today`,
        text:
          `${hotel.name} — today\n\n` +
          `ARRIVING (${arrivals.length})\n` +
          (arrivals.map(line).join('\n') || 'nobody') +
          `\n\nLEAVING (${departures.length})\n` +
          (departures.map(line).join('\n') || 'nobody') +
          `\n\nPaid yesterday: ${hotel.currency} ${revenue.total.toFixed(2)} across ${revenue.count} booking(s).`,
        html: wrap(
          a,
          `Today at ${esc(hotel.name)}`,
          `<p style="background:#F3F4F6;padding:.8rem;border-radius:8px;margin-bottom:1.5rem">
             Paid yesterday: <strong>${esc(hotel.currency)} ${esc(revenue.total.toFixed(2))}</strong>
             across ${esc(revenue.count)} booking(s).
           </p>
           <h2 style="font-size:.95rem;text-transform:uppercase;letter-spacing:.05em;color:#6B7280">
             Arriving (${arrivals.length})</h2>
           <table style="width:100%;border-collapse:collapse">${rows(arrivals, 'Nobody arriving today.')}</table>
           <h2 style="font-size:.95rem;text-transform:uppercase;letter-spacing:.05em;color:#6B7280;margin-top:1.5rem">
             Leaving (${departures.length})</h2>
           <table style="width:100%;border-collapse:collapse">${rows(departures, 'Nobody leaving today.')}</table>`
        ),
      });
    },

    /** A call that needs a person, right now (§3). Also cancellations,
     *  payments landing, and check-ins. Pass `whatsappTo` (usually
     *  hotel.escalation_whatsapp) and the same words go to the owner's phone. */
    async alertOwner({ to, whatsappTo, subject, text }) {
      const wa = await ping(whatsappTo, `${subject || 'Sena — a call needs a person'}\n\n${text}`);
      const sent = await mail({
        to,
        subject: subject || 'Sena — a call needs a person',
        text,
        html: `<div style="font:15px/1.6 sans-serif;color:#0B1220">
                 <h1 style="font-size:1.1rem;color:#B91C1C">${esc(subject || 'A call needs a person')}</h1>
                 <pre style="font:inherit;white-space:pre-wrap">${esc(text)}</pre>
               </div>`,
      });
      return { ...sent, whatsapp: wa };
    },
  };
}
