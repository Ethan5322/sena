// ============================================================================
// Sena, on a laptop, with nothing signed up for.
//
// `npm run dev` with no DATABASE_URL lands here. You get:
//
//   * a REAL Postgres (PGlite, in-process), with the real schema, the real RLS
//     and the real demo hotel — the same sena-all-in-one.sql that gets pasted
//     into Supabase. Not a mock. Every SQL function the router calls is the
//     function that runs in production, including the hold lock and the QR
//     knock-out.
//   * a payment gateway that hands back a link you can click, which pays.
//   * a mail server that writes the email to disk and prints the link.
//
// WHY THIS IS WORTH THE FILE. The alternative is that nobody can run Sena
// end-to-end without a Supabase project, a Paystack account and an app password
// for Gmail — so nobody does, so the first time the whole booking path executes
// is in front of a guest. A system you cannot run is a system you cannot trust.
//
// It is deliberately loud about being fake. Every stub announces itself on the
// console, because the one genuinely dangerous failure here is believing you
// tested a real payment.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createRouter } from './router.mjs';
import { createCallMeBot } from './adapters/whatsapp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAILBOX = path.join(ROOT, '.sena-demo-mail');

export async function createDemoServices({ publicUrl = 'http://localhost:3000' } = {}) {
  // ── The database ─────────────────────────────────────────────────────────
  const db = new PGlite({ extensions: { pgcrypto } });

  // Supabase gives us these; PGlite does not. The install references them (RLS
  // policies name the roles, and auth.uid() is how a clerk is identified), so
  // they have to exist before sena-all-in-one.sql will apply.
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key);
    create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    do $$ begin create role anon;          exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
  `);

  // The real install. If this file is broken, `npm run dev` will not start —
  // which is exactly when you want to find out.
  await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/sena-all-in-one.sql'), 'utf8'));

  const { rows } = await db.query(`select id, name, phone from sena_hotels where is_demo limit 1`);
  const hotel = rows[0];

  // ── The payment gateway ──────────────────────────────────────────────────
  // Paystack, if Paystack were a URL on your own machine that always works. The
  // link is real and clickable: opening it runs the SAME applyChargeSuccess()
  // that the real webhook runs, through the same signature-verified path's
  // business logic. So "the guest paid" is a thing you can actually do here.
  const paystack = {
    async initialize({ reference, amount_cents, currency, email }) {
      console.log(
        `\n  [demo paystack] ${currency} ${(amount_cents / 100).toFixed(2)} for ${email}\n` +
          `  [demo paystack] PAY IT:  ${publicUrl}/demo/pay?ref=${encodeURIComponent(reference)}\n`
      );
      return {
        authorization_url: `${publicUrl}/demo/pay?ref=${encodeURIComponent(reference)}`,
        reference,
      };
    },
  };

  // ── The mail server ──────────────────────────────────────────────────────
  // Every email Sena sends lands in .sena-demo-mail/ as an .html file you can
  // open in a browser — including the guest's QR ID card link. That is the whole
  // delivery path, minus SMTP.
  fs.mkdirSync(MAILBOX, { recursive: true });
  let seq = 0;

  const write = (kind, to, subject, html, text) => {
    const name = `${String(++seq).padStart(2, '0')}-${kind}.html`;
    fs.writeFileSync(
      path.join(MAILBOX, name),
      `<!-- to: ${to}\n     subject: ${subject} -->\n${html || `<pre>${text || ''}</pre>`}`
    );
    console.log(`  [demo mail] → ${to}  "${subject}"`);
    console.log(`  [demo mail]   .sena-demo-mail/${name}`);
    return { ok: true, id: `demo-${seq}` };
  };

  const notifier = {
    channel: 'email',
    async sendPaymentLink({ to, url, pkg }) {
      return write('payment-link', to, `Pay to confirm — ${pkg.booking.reference}`,
        `<p>Pay here: <a href="${url}">${url}</a></p>`);
    },
    async sendConfirmation({ to, pkg }) {
      return write('confirmation', to, `Confirmed — ${pkg.booking.reference}`,
        `<p>Booking ${pkg.booking.reference} confirmed.</p>` +
        `<p>CHECK-IN CODE: <strong style="font-family:monospace;font-size:1.3em">${pkg.guest_id.verification_number}</strong><br>` +
        `Enter it on the reception page when you arrive (with a quick photo), or show the QR at the desk.</p>` +
        (pkg.card_url ? `<p>Your guest ID: <a href="${pkg.card_url}">${pkg.card_url}</a></p>` : '') +
        (pkg.confirmation_url
          ? `<p>Your booking confirmation (print/PDF): <a href="${pkg.confirmation_url}">${pkg.confirmation_url}</a></p>`
          : ''));
    },
    async notifyOwner({ to, pkg }) {
      const wa = await demoWhatsApp(
        pkg.hotel?.escalation_whatsapp,
        `🏨 NEW BOOKING — ${pkg.booking.reference}\n${pkg.guest?.full_name || 'guest'} · paid ${pkg.total}`
      );
      const sent = write('owner-booking', to, `New booking — ${pkg.booking.reference}`,
        `<pre>${JSON.stringify({ guest: pkg.guest?.full_name, total: pkg.total }, null, 2)}</pre>`);
      return { ...sent, whatsapp: wa };
    },
    async sendPreArrival({ to, booking }) {
      return write('pre-arrival', to, `See you tomorrow — ${booking.reference}`, '');
    },
    async sendDailySummary({ to, arrivals, departures }) {
      return write('daily-summary', to,
        `${arrivals.length} arriving, ${departures.length} leaving`, '');
    },
    async alertOwner({ to, whatsappTo, subject, text }) {
      const wa = await demoWhatsApp(whatsappTo, `${subject}\n\n${text || ''}`);
      const sent = write('owner-alert', to, subject, null, text);
      return { ...sent, whatsapp: wa };
    },
  };

  // The owner's WhatsApp ping. THE ONE PIECE OF THE DEMO THAT CAN BE REAL:
  // CallMeBot needs no business account, so if CALLMEBOT_* is in .env.local the
  // alert genuinely lands on the owner's phone mid-demo — the moment that sells
  // the system. Without it, a loud console line like every other stub here.
  const callmebot = createCallMeBot({
    phone: process.env.CALLMEBOT_PHONE,
    apikey: process.env.CALLMEBOT_APIKEY,
  });
  let waSeq = 0;
  async function demoWhatsApp(to, text) {
    if (callmebot.configured) {
      const sent = await callmebot.send({ text: `[Sena] ${text}` });
      console.log(`  [whatsapp] → owner phone via callmebot: ${sent.ok ? 'sent' : sent.error}`);
      return sent;
    }
    if (!to) return { ok: false, skipped: true, error: 'no whatsapp number' };
    console.log(`  [demo whatsapp] → ${to}  "${text.split('\n')[0]}"  (no message moved — demo)`);
    return { ok: true, id: `demo-wa-${++waSeq}` };
  }

  const router = createRouter({
    db,
    paystack,
    notifier,
    defaultHotelId: hotel?.id || null,
    publicUrl,
  });

  return { db, paystack, notifier, router, hotel, mailbox: MAILBOX };
}
