# Sena — AI Front Desk Receptionist

An autonomous AI voice receptionist for hotels. A guest phones the hotel's usual
number; Sena answers, says plainly that she is an AI, works in English or
Amharic, checks live availability, quotes real rates, takes the guest's details,
sends a payment link during the call, and issues a booking confirmation plus a
single-use QR guest ID. Anything she is not sure of, she hands to a human.

Built by **MuleSoo Digital Services**, Pretoria.

> **`CLAUDE.md` is the specification.** It is the source of truth for the guest
> journey, the call logic, the data model and the escalation rules. This README
> only tells you how to run what is here.

---

## Status

| Build step | State |
|---|---|
| 1. Supabase schema, RLS, demo seed | **Done — installed and live in Supabase** |
| 2. Sena's system prompt + Vapi config | **Done** |
| 3. Guest ID card (QR, single-use) | **Done — sample rendered, QR decodes** |
| 4. Tool router (call → hold → pay → confirm) | **Done — 30 checks, every gate attacked** |
| 5. Paystack webhook | **Done — signature, underpayment, idempotency** |
| 6. Booking confirmation PDF | Not started — gets the MuleSoo **QR credit stamp** |
| 7. Deploy to Vercel + connect a Twilio number | Not started — this is what makes it ring |
| 8. n8n scheduled jobs (expire holds, daily arrivals) | Not started |
| 9. Owner setup guide | Not started |

### Where we are, in one paragraph

The database is live in Supabase, and the whole booking path now exists as tested
code: Sena can take a call, check real availability, hold a room against a race,
refuse to save a guest she has not double-confirmed, send a Paystack link, and
refuse to confirm anything until the money actually lands. **What is missing is
not logic — it is a phone number.** Nothing is deployed and nothing is connected
to Twilio yet, so no one can ring it. Next: deploy the two endpoints in `api/` to
Vercel, point `vapi-config.json` at them, buy a South African number, and the
demo is callable. The confirmation PDF (step 6) is the last guest-facing gap; the
guest currently receives their booking and QR ID as a WhatsApp message, not a
document.

### Decisions already taken (don't relitigate)

- **South Africa first** → Paystack in **ZAR**, not Chapa/ETB. Chapa stays in the
  spec as the Ethiopian swap-in. Amharic support is unchanged.
- **The first property is fictional** (Jacaranda Court Hotel) so the system is
  callable before a client signs. A real hotel is a different seed file — data,
  not code.
- **Sena's Supabase is shared with the MuleSoo website**, so every object is
  namespaced `sena_*` and the install is tested against a co-tenant app.
- The **Guest ID card carries the MuleSoo credit lockup, not the QR stamp** — the
  card exists to be scanned, and a second QR beside the guest's is the one a
  tired clerk scans at 6am. The QR stamp goes on the confirmation PDF instead.

---

## The things that must never break

A hotel will forgive a clumsy sentence. It will not forgive these — so every one
is a test that runs against a real Postgres, not a mock.

**In the database** (`npm run test:db`):

1. **Two callers, one last room.** `sena_hold_room()` locks the room row before
   it re-counts, so a race between two simultaneous calls cannot oversell.
   An unpaid hold expires and the room becomes sellable again.
2. **One guest ID, one check-in.** `sena_knock_out_guest_id()` burns the QR in a
   single atomic statement. A second scan — of the same code, from a second
   device — is refused.

**In the router** (`npm run test:router`) — because a system prompt is a request,
not a guarantee. An LLM with a persuasive caller on the line will eventually call
the tool anyway, so the rules are re-checked in code where they cannot be talked
out of it:

3. **No guest is saved without double-confirmation.** `save_guest_details`
   refuses unless `double_confirmed` is true, and nothing reaches `sena_guests`.
4. **No confirmation on an unpaid booking.** `send_confirmation_package` refuses
   until the money has landed — otherwise the guest holds a working QR code for a
   room they never paid for.
5. **A R1 charge does not buy a R1,900 room.** The Paystack webhook checks the
   amount, not just the signature.
6. **A retried webhook does not double-confirm**, and a retried package does not
   mint a second valid QR.
7. **Hotel A cannot read hotel B's guests**, even with a forged booking id.

---

## Run it

```bash
npm install

npm test            # all three suites: schema, install, router
npm run samples     # renders the guest ID card to docs/samples/
```

`npm run samples` needs Chrome or Edge installed (it renders the card in headless
Chrome). Set `CHROME_PATH` if it is somewhere unusual.

---

## The booking path

Sena's ten tools (`voice-agent/vapi-config.json`) all post to **one** endpoint.
The router is the other side of that wire.

```
guest dials  →  Twilio  →  Vapi (Sena speaks)
                            │
                            │  every tool call, signed with SENA_WEBHOOK_SECRET
                            ▼
                   POST /api/sena/tool          ← src/router.mjs
                            │
                            ▼
                        Supabase                ← the SQL functions
                            ▲
                            │  charge.success, HMAC-verified
                   POST /api/sena/paystack-webhook   ← src/payments.mjs
```

The router never lets Vapi near the database. It resolves *which hotel* from the
number the guest dialled — that is where multi-tenancy is actually decided.

| File | What it holds |
|---|---|
| `src/router.mjs` | The ten tools, and every gate that protects a booking |
| `src/payments.mjs` | What happens when money lands. Separated from HTTP so it can be attacked by tests |
| `src/adapters/paystack.mjs` | ZAR payments. Swapping in Chapa for Ethiopia is one file, and the router does not change |
| `src/adapters/messenger.mjs` | WhatsApp, with an SMS fallback. A payment link that never arrives is a lost booking |
| `api/sena/*.mjs` | The two Vercel endpoints. They verify secrets and delegate — nothing that matters is decided there |

Copy `.env.example` to `.env.local` and fill it in before running anything that
touches the network.

---

## Supabase

Sena **shares a Supabase project with the MuleSoo website**, so every table,
function, type, index and trigger it creates is prefixed `sena_` and can never
collide with MuleSoo's own objects. `npm run test:install` proves it: it stands
up a fake MuleSoo table, runs the real install against it, and checks MuleSoo
survives both the install and the uninstall.

**To install, paste one file:** `supabase/sena-all-in-one.sql` into the Supabase
SQL editor and run it. That is the whole install. To remove Sena again without
touching MuleSoo, run `supabase/sena-uninstall.sql`.

The all-in-one is **generated** — do not edit it. Edit the three sources below
and re-run `npm run build:install`:

| File | What it does |
|---|---|
| `supabase/schema.sql` | Tables, the availability engine, the hold lock, the QR knock-out |
| `supabase/policies.sql` | Row Level Security. The public key gets **nothing**; staff see only their own hotel |
| `supabase/seed-demo-hotel.sql` | The fictional demo hotel, so the system is callable before a client signs |

Onboarding a real hotel is a **different seed file** — new rooms, rates and
policies. It is data, not code. That is the product.

---

## Layout

```
CLAUDE.md                     the specification — read this first
supabase/
  sena-all-in-one.sql         ← the one file you paste into Supabase (generated)
  schema.sql                  tables + availability + hold + knock-out
  policies.sql                RLS (POPIA: guest names, phones, nationalities)
  seed-demo-hotel.sql         Jacaranda Court Hotel (fictional)
  sena-uninstall.sql          removes only sena_*, leaves the co-tenant standing
src/
  router.mjs                  the ten tools, and the gates that protect a booking
  payments.mjs                what happens when money lands
  db.mjs                      one query interface, so tests and prod run the same SQL
  adapters/                   paystack (ZAR) · whatsapp + sms
api/sena/
  tool.mjs                    every Vapi tool call arrives here
  paystack-webhook.mjs        the only thing that may confirm a booking
voice-agent/
  system-prompt.md            Sena's brain: disclosure, double-confirmation, escalation
  vapi-config.json            voice pipeline; tools map 1:1 onto the router
templates/
  guest-id-card.html          CR80 card, themed from the hotel's own colours
scripts/
  test-schema.mjs             the database cannot oversell or reuse a QR
  test-router.mjs             the router cannot be talked into either
  test-install.mjs            the install cannot damage the co-tenant app
  render-sample.cjs           renders the card exactly as production will
docs/samples/                 what a guest actually receives
assets/                       fonts + the MuleSoo credit lockup
```

---

## Non-negotiables

These are in the spec, and they are not style preferences:

- **Sena discloses that she is an AI in her first breath.** Not when asked.
- **Consent to recording is stated in the greeting** (POPIA).
- **Nothing is saved until the guest has confirmed it twice** — the
  double-confirmation gate. A wrong digit in a phone number means the guest never
  receives their booking.
- **Sena never invents a rate, a room, a date or a policy.** If it did not come
  from a tool result, she does not know it, and she says so.
- **Never a card number over the phone.** Payment happens through the link.
- **Escalating is never a failure. Guessing is.**

---

*Designed & built by MuleSoo Digital Services — mulesoo.com*
