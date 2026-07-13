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
| 4. Tool router (call → hold → pay → confirm) | **Done — every gate attacked** |
| 5. Paystack webhook | **Done — signature, underpayment, idempotency** |
| 6. Guest ID delivery + front-desk scanner | **Done — the QR round trip is proven** |
| 7. Deploy to Vercel + connect a Twilio number | Not started — this is what makes it ring |
| 8. Owner dashboard | Not started — §2 promises owner visibility at six stages |
| 9. Scheduled jobs (expire holds, arrivals, post-stay) | Not started |
| 10. Booking confirmation PDF | Not started — gets the MuleSoo **QR credit stamp** |
| 11. Owner setup guide | Not started |

**69 checks, four suites, all against a real Postgres.** `npm test`.

### Where we are, in one paragraph

The database is live in Supabase and the whole guest journey now exists as tested
code: Sena takes the call, holds a room against a race, refuses to save a guest
she has not double-confirmed, sends a Paystack link, refuses to confirm until the
money lands, then issues a QR guest ID that a clerk can scan — once, and only
once. **What is missing is not logic. It is a phone number.** Nothing is deployed,
so nobody can ring it. Next: deploy `api/` to Vercel, point `vapi-config.json` at
it, buy a South African number. After that, the owner dashboard — CLAUDE.md §2
promises the owner sees bookings, payments and check-ins in real time, and none
of that exists yet.

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

**On the card** (`npm run test:card`) — the card's only job is to be scanned at
6am by a tired clerk, so we do not check that it "looks right". We take the PNG
bytes actually embedded in the page, decode them with the same QR reader the
scanner uses, and drive the result through check-in:

8. **The QR decodes to the right guest**, and scanning it checks them in.
9. **A second scan of the same card is refused.** Card → QR → scanner → database,
   proven end to end.

---

## The guest ID, and the front desk

The card is served as a **web page, not a PDF**. Headless Chrome cannot run in a
Vercel function, and on a phone-first market a link beats an attachment nobody
can find again. The guest gets `…/api/sena/card?v=…` on WhatsApp, opens it at the
desk, and shows the screen.

**The URL is the credential** — the verification number is 12 characters from a
31-symbol alphabet, about 59 bits, not guessable. Holding the link is exactly
equivalent to holding a printed card, which is safe because the ID dies on first
scan: forward it to a friend and one of you checks in, the other is refused.

The clerk opens `…/api/sena/desk` on a phone, signs in, and points the camera at
the QR. That page ships the Supabase **anon** key in plain sight, which is safe on
purpose: the anon key has no RLS policy, so it can read nothing at all. The clerk
signs in with Supabase Auth and the only thing they can do is call
`sena_staff_check_in()` — which verifies they work at *that* property before it
burns anything. That is why the policies were written first.

There is a manual code box next to the scanner. Cameras fail, screens crack, and
phones die at 1% — a front desk that can only scan is a front desk that stops.

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
  card.mjs                    the guest ID card — QR generated without a browser
  db.mjs                      one query interface, so tests and prod run the same SQL
  adapters/                   paystack (ZAR) · whatsapp + sms
api/sena/
  tool.mjs                    every Vapi tool call arrives here
  paystack-webhook.mjs        the only thing that may confirm a booking
  card.mjs                    the guest's ID card, at an unguessable URL
  desk.mjs                    the front desk: scan the QR, check the guest in
voice-agent/
  system-prompt.md            Sena's brain: disclosure, double-confirmation, escalation
  vapi-config.json            voice pipeline; tools map 1:1 onto the router
templates/
  guest-id-card.html          CR80 card, themed from the hotel's own colours
scripts/
  test-schema.mjs             the database cannot oversell or reuse a QR
  test-router.mjs             the router cannot be talked into either
  test-card.mjs               the card scans, and it only scans once
  test-install.mjs            the install cannot damage the co-tenant app
  render-sample.cjs           renders the card to PDF/PNG (needs Chrome, offline only)
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
