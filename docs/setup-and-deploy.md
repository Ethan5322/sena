# Getting Sena onto a phone number

Everything Sena needs, in the order that wastes the least of your time.

**The principle:** two things have a queue in front of them (a South African phone
number, and WhatsApp templates). Start those on **day one** and do the rest while
they sit in review. Everything else here is same-day.

**The good news:** Paystack gives you working **test keys the moment you sign
up** — no business verification, no CIPC certificate, no waiting. The whole demo
runs end to end on test keys. You only need a verified business to take *real*
money, and that is a decision for when a hotel actually signs.

---

## Day one — start the slow things first

### 1. Twilio: a South African number (2 business days, sometimes weeks)

South African numbers are regulated. Twilio will not sell you one until you pass
a **Regulatory Bundle**: proof of address plus ID (individual) or company
documents (business). A PO box or virtual address is rejected.

1. Sign up at [twilio.com](https://www.twilio.com).
2. Console → **Phone Numbers → Regulatory Compliance → Bundles → Create new**.
3. Choose South Africa, choose *Individual* or *Business*, upload:
   - ID (passport or SA ID)
   - **Proof of address** — a utility bill or bank statement with a real street
     address on it. Not a PO box.
4. Submit. Review takes ~2 business days.
5. When it clears, buy a **local South African voice-capable number**.

> **Do not wait for this to demo.** Vapi can sell you a number immediately (§4
> below). Buy one there, demo on it today, and swap in the South African number
> the moment the bundle clears. It is a one-field change.

### 2. Meta WhatsApp — optional now, but start it anyway

This is the thing I got wrong earlier and want to be plain about: **WhatsApp will
not let you send a free-form message to someone who has not messaged you first.**
Your guest phoned you; a phone call does not open that window. Business-initiated
messages need a **pre-approved template**, and approval takes days.

So WhatsApp is no longer a blocker — the payment link and the guest ID card go by
**SMS**, which has no such rule. WhatsApp is the upgrade.

If you want it: [developers.facebook.com](https://developers.facebook.com) → new
app → **WhatsApp** product → get a test number and a token, then submit message
templates for `payment_link` and `guest_confirmation`.

---

## Same day — the rest of it

### 3. Paystack (15 minutes, test keys instantly)

1. Sign up at [paystack.com/signup](https://paystack.com/signup). South Africa is
   supported.
2. Your account starts in **Test Mode**. That is what you want.
3. **Settings → API Keys & Webhooks**. Copy the **Test Secret Key** (`sk_test_…`).

   ```
   PAYSTACK_SECRET_KEY=sk_test_...
   ```

4. On that same page, set the **webhook URL** (do this after step 6, when you
   have a Vercel URL):

   ```
   https://YOUR-APP.vercel.app/api/sena/paystack-webhook
   ```

   That secret key is also what signs the webhook. The same key does both jobs.

> Going live later needs a bank confirmation letter and either a CIPC certificate
> (registered company) or your ID (sole proprietor). 1–3 business days. You do not
> need this to demo.

### 4. Vapi + a voice (30 minutes)

1. Sign up at [vapi.ai](https://vapi.ai). The free tier is enough to demo.
2. **Buy a phone number inside Vapi** so you can test today, or import the Twilio
   number once its bundle clears.
3. Create an assistant. Paste in `voice-agent/vapi-config.json`, and paste
   `voice-agent/system-prompt.md` as the system message.
4. Set the assistant's **Server URL** to:

   ```
   https://YOUR-APP.vercel.app/api/sena/tool
   ```

   and its **Server Secret** to the value you generate in step 7.

5. Voice: sign up at [elevenlabs.io](https://elevenlabs.io), pick a warm,
   mid-pitch, gender-neutral voice that carries a South African English accent.
   Copy its **Voice ID**.

   ```
   SENA_VOICE_ID=...
   ```

### 5. Supabase keys (2 minutes — the database is already live)

**Settings → Database → Connection string → URI.** Use the **pooler** (port
**6543**), not the direct connection: every Vercel invocation opens its own
connection and the direct port runs out.

```
DATABASE_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-....pooler.supabase.com:6543/postgres
```

**Settings → API** for the front-desk scanner page:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...
```

The anon key is **public and safe to ship in a web page** — it has no RLS policy,
so it can read nothing at all. That is deliberate, and it is why `policies.sql`
was written before any of this.

Then get the demo hotel's id — run this in the SQL editor:

```sql
select id from sena_hotels where is_demo;
```

```
SENA_DEFAULT_HOTEL_ID=<that uuid>
```

### 6. Vercel (10 minutes)

1. [vercel.com](https://vercel.com) → **Add New → Project** → import
   `Ethan5322/sena`.
2. Deploy. Note the URL it gives you.
3. **Settings → Environment Variables** → add every variable from `.env.example`.
4. Redeploy so they take effect.

```
SENA_PUBLIC_URL=https://YOUR-APP.vercel.app
```

Without `SENA_PUBLIC_URL`, the guest's confirmation carries a guest ID *number*
instead of a link to a scannable card. The booking works; the check-in doesn't.

### 7. The webhook secret (10 seconds)

Any long random string. It is what proves a tool call really came from Vapi —
without it, this endpoint is a public API for reserving a hotel's whole inventory
and reading its guest list.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```
SENA_WEBHOOK_SECRET=<that>
```

Paste the same value into Vapi's assistant **Server Secret** field.

---

## Front desk

Create a staff login so a clerk can check guests in:

1. Supabase → **Authentication → Users → Add user** (email + password).
2. Then link that user to the hotel:

   ```sql
   insert into sena_hotel_staff (user_id, hotel_id, role)
   select u.id, h.id, 'owner'
     from auth.users u, sena_hotels h
    where u.email = 'you@mulesoo.com'
      and h.is_demo;
   ```

3. Open `https://YOUR-APP.vercel.app/api/sena/desk` on a phone, sign in, and scan
   a guest's QR.

---

## Proving it works

Ring the number. Book a room. Pay with a Paystack **test card**. You should get an
SMS with a link to your guest ID card — open it, and scan the QR from the front
desk page. The second scan must be refused.

If it is, every stage of the journey in `CLAUDE.md` §2 has run for real.

---

*MuleSoo Digital Services — mulesoo.com*
