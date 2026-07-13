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
| 1. Supabase schema, RLS, demo seed | **Done — verified against a real Postgres** |
| 2. Sena's system prompt + Vapi config | **Done** |
| 3. Guest ID card (QR, single-use) | **Done — sample rendered, QR decodes** |
| 4. Booking confirmation PDF | Not started |
| 5. n8n workflows (call → hold → pay → deliver) | Not started |
| 6. Paystack webhook | Not started |
| 7. Owner setup guide | Not started |

---

## The two things that must never break

A hotel will forgive a clumsy sentence. It will not forgive these, so both are
covered by `npm run test:db`, which runs the real SQL against a real Postgres:

1. **Two callers, one last room.** `sena_hold_room()` locks the room row before
   it re-counts, so a race between two simultaneous calls cannot oversell.
   An unpaid hold expires and the room becomes sellable again.
2. **One guest ID, one check-in.** `sena_knock_out_guest_id()` burns the QR in a
   single atomic statement. A second scan — of the same code, from a second
   device — is refused.

---

## Run it

```bash
npm install

npm run test:db     # applies the SQL to an in-memory Postgres and attacks it
npm run samples     # renders the guest ID card to docs/samples/
```

`npm run samples` needs Chrome or Edge installed (it renders the card in headless
Chrome). Set `CHROME_PATH` if it is somewhere unusual.

---

## Supabase

Sena has **its own Supabase project** — it does not share MuleSoo's. Every table
and function is prefixed `sena_` so the two can never be confused, even if they
ever end up in one database.

Run these three, in order, in the Supabase SQL editor:

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
  schema.sql                  tables + availability + hold + knock-out
  policies.sql                RLS (POPIA: guest names, phones, nationalities)
  seed-demo-hotel.sql         Jacaranda Court Hotel (fictional)
voice-agent/
  system-prompt.md            Sena's brain: disclosure, double-confirmation, escalation
  vapi-config.json            voice pipeline; tools map 1:1 onto the SQL functions
templates/
  guest-id-card.html          CR80 card, themed from the hotel's own colours
n8n-workflows/                (next)
scripts/
  test-schema.mjs             the two things that must never break
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
