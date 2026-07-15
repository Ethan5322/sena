# Getting Sena talking

No WhatsApp. No SMS. No subscriptions. **And now no Vapi, no ElevenLabs and no
Twilio either** — the voice stack is self-hosted and free. See
[voice-stack.md](voice-stack.md) for that half; this page is the database, the
money, and the deploy.

**What is genuinely free:** Supabase, Vercel, Paystack (test keys work the moment
you sign up), email over Gmail SMTP, and the entire voice pipeline — LiveKit,
Whisper and Piper all run on your own box.

**The one thing that is not free:** Anthropic, for Sena's brain. That is
pay-as-you-go and it is the only meter running.

**The one thing you do not get:** a phone number. Guests reach Sena through a *Call
Reception* button on a web page, not by dialling. Adding a real number later is a
bolt-on — [voice-stack.md](voice-stack.md#later-a-real-phone-number) — and there is
a good reason not to do it first: a South African number needs a regulatory bundle
(ID, proof of address, days to weeks), and you should not be waiting on a telco to
find out whether your receptionist can take a booking.

---

## Before anything else: never paste a key into a chat

API keys belong in **Vercel's environment variables** and your local `.env.local`.
Never in the repo, never in a message, never in a screenshot. If a key is ever
exposed — even to someone you trust — revoke it and issue a new one. A leaked key
is not "probably fine".

---

## 1. Email — how the booking reaches the guest (10 minutes, free)

The payment link and the guest's QR ID card both go by email. This is not a
downgrade from WhatsApp; WhatsApp **cannot do this job at all**. Meta refuses to
deliver a free-form message to anyone who has not messaged you first, and a phone
call does not open that window. Business-initiated messages need approved
templates, a verified business, and days of waiting.

Email has none of those problems.

**Gmail (free, no signup — use this to start):**

1. Turn on 2-Step Verification on the Google account.
2. Google Account → **Security → App passwords** → generate one.
3. That app password is `SMTP_PASS`. Your Gmail address is `SMTP_USER`.

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=<the 16-character app password, NOT your login password>
SMTP_FROM="Jacaranda Court Hotel <you@gmail.com>"
```

Good for ~500 emails a day. Plenty for a demo and a first hotel.

**Later, when it should look professional:** [Resend](https://resend.com) —
3,000 emails a month free, and once you verify `mulesoo.com` you can send from
`bookings@mulesoo.com`. Same SMTP settings, different host. No code change.

---

## 2. Paystack (15 minutes, test keys instantly)

1. Sign up at [paystack.com/signup](https://paystack.com/signup). South Africa is
   supported.
2. Your account starts in **Test Mode**. That is exactly what you want.
3. **Settings → API Keys & Webhooks** → copy the **Test Secret Key**.

```
PAYSTACK_SECRET_KEY=sk_test_...
```

4. On the same page set the webhook URL (once you have a Vercel URL, step 5):

```
https://YOUR-APP.vercel.app/api/sena/paystack-webhook
```

That one key does two jobs: it creates the payment link, and it signs the webhook
that confirms the booking.

> Taking **real** money later needs a bank confirmation letter plus a CIPC
> certificate (company) or your ID (sole proprietor) — 1–3 business days. You do
> not need any of that to demo.

---

## 3. Supabase (5 minutes — the database is already live)

**Settings → Database → Connection string → URI.** Use the **pooler**, port
**6543** — not the direct connection. Every Vercel invocation opens its own
connection and the direct port runs out.

```
DATABASE_URL=postgresql://postgres.xxxx:PASSWORD@...pooler.supabase.com:6543/postgres
```

**Settings → API** — for the front-desk scanner page:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...
```

The anon key is **public and safe to ship in a web page**: it has no RLS policy,
so it can read nothing at all. That is why the policies were written first.

Then, in the SQL editor:

```sql
-- Which hotel Sena answers for
select id from sena_hotels where is_demo;

-- Point the owner's alerts at an inbox you actually read.
-- Every booking, escalation and failed payment goes here.
update sena_hotels set email = 'you@gmail.com' where is_demo;
```

```
SENA_DEFAULT_HOTEL_ID=<that uuid>
```

---

## 4. The voice (one command)

There is nothing to sign up for. The voice stack is three open-source components
in a container on your own machine, and the full guide — install, run, tune,
troubleshoot, and how to bolt a real phone number on later — is
**[voice-stack.md](voice-stack.md)**.

The short version, once `.env.local` has your `ANTHROPIC_API_KEY` and
`SENA_WEBHOOK_SECRET`:

```bash
npm run dev      # terminal 1 — the router, the gates, the database
npm run voice    # terminal 2 — LiveKit + Whisper + Claude + Piper, in docker
```

Then open **http://localhost:8080** and click *Call Reception*.

The only key that leaves your machine is Anthropic's.

---

## 5. Vercel (10 minutes)

1. [vercel.com](https://vercel.com) → **Add New → Project** → import
   `Ethan5322/sena`.
2. Deploy, and note the URL.
3. **Settings → Environment Variables** → add every variable from `.env.example`.
4. Redeploy so they take effect.

```
SENA_PUBLIC_URL=https://YOUR-APP.vercel.app
```

Without this, the confirmation email carries a guest ID *number* instead of a link
to a scannable card. The booking works; the check-in doesn't.

---

### Why vercel.json looks the way it does

(JSON allows no comments and Vercel rejects `$comment` properties, so the
reasoning lives here instead.)

- **`includeFiles`** — the card and front-desk pages read the HTML template,
  the brand fonts and four npm dist files (jsqr, jsbarcode, html2canvas, jspdf)
  off disk at request time. Vercel's bundler only traces static imports; it
  cannot see a path built at runtime, so without this line those files are left
  out of the deployment and the card 500s in production while rendering
  perfectly on a laptop.
- **`crons` at 06:00 UTC** — 08:00 in Johannesburg: the owner's arrivals list
  lands before the front desk opens. One daily cron is all the free tier allows
  and all this needs — expiring abandoned holds is deliberately NOT scheduled,
  because `check_availability` does it on every call; the system stays correct
  even if the cron never runs.

## 6. The webhook secret (10 seconds)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```
SENA_WEBHOOK_SECRET=<that>
```

The voice agent sends this on every tool call as the `x-sena-secret` header, and
`api/sena/tool.mjs` checks it in constant time. It is what proves a tool call came
from **our agent** and not from the internet. Without it, that endpoint is a public
API for reserving a hotel's entire inventory and reading its guest list — names,
phones, nationalities. That is a POPIA breach with a URL.

It must be byte-identical in `.env.local` (which the agent container reads) and in
Vercel's environment variables. If they disagree, every tool call 401s and Sena
apologises to the guest for a problem that is in your `.env` file.

---

## 7. The front desk

```sql
-- After creating the user in Supabase → Authentication → Users → Add user
insert into sena_hotel_staff (user_id, hotel_id, role)
select u.id, h.id, 'owner'
  from auth.users u, sena_hotels h
 where u.email = 'you@gmail.com'
   and h.is_demo;
```

Open `https://YOUR-APP.vercel.app/api/sena/desk` on a phone and sign in.

---

## Proving it works

Ring the number. Book a room. Pay with a Paystack **test card**. Check your email:
you should get a confirmation with a link to your guest ID card. Open it, and scan
the QR from the front-desk page on another phone.

**The second scan must be refused.** If it is, every stage of the journey in
`CLAUDE.md` §2 has run for real.

---

*MuleSoo Digital Services — mulesoo.com*
