// ============================================================================
// Who Sena talks to: the database, the payment gateway, the mail server.
//
// This exists so there is ONE place that decides. The Vercel handlers used to
// each build their own pool and their own SMTP transport from the environment,
// which was fine until we wanted to run the whole system on a laptop with no
// Supabase project, no Paystack account and no mail server — and discovered
// there was no seam to swap them at.
//
// Now there is. Production builds these from the environment, as it always did.
// `npm run dev` with no DATABASE_URL calls useServices() with a demo set (see
// src/demo.mjs) and gets an identical router on top of an in-process Postgres.
//
// THE ROUTER DOES NOT KNOW WHICH IT IS TALKING TO, and that is the point: the
// gates you exercise on your laptop are the gates a guest hits in production,
// because they are the same code running the same SQL.
// ============================================================================

import { createPgDb } from './db.mjs';
import { createRouter } from './router.mjs';
import { createPaystack } from './adapters/paystack.mjs';
import { createNotifier } from './adapters/notifier.mjs';
import { createWhatsApp, createCallMeBot } from './adapters/whatsapp.mjs';

let cached = null;

/**
 * Inject a service set. Development only — nothing in api/ calls this, so a
 * Vercel deployment can never end up on a demo database by accident.
 */
export function useServices(services) {
  cached = services;
}

export function getServices() {
  if (cached) return cached;

  const db = createPgDb(process.env.DATABASE_URL);
  const paystack = createPaystack({
    secretKey: process.env.PAYSTACK_SECRET_KEY,
    callbackUrl: process.env.PAYSTACK_CALLBACK_URL,
  });
  const notifier = createNotifier({
    // Resend when its key is set (the serverless-native transport); SMTP else.
    resendApiKey: process.env.RESEND_API_KEY,
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM,
    // Owner alerts also land on WhatsApp when configured; email regardless.
    // CallMeBot when its key is set (one hotel, zero Meta paperwork);
    // otherwise the Meta Cloud API adapter.
    whatsapp: process.env.CALLMEBOT_APIKEY
      ? createCallMeBot({
          phone: process.env.CALLMEBOT_PHONE,
          apikey: process.env.CALLMEBOT_APIKEY,
        })
      : createWhatsApp({
          token: process.env.WHATSAPP_TOKEN,
          phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
          templateName: process.env.WHATSAPP_TEMPLATE_NAME,
        }),
  });

  cached = {
    db,
    paystack,
    notifier,
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
