# Sena — AI Front Desk Receptionist

An autonomous AI voice receptionist for hotels. A guest clicks **Call Reception**;
Sena answers, says plainly that she is an AI, checks live availability, quotes real
rates, takes the guest's details, sends a payment link during the call, and issues a
booking confirmation plus a single-use QR guest ID. Anything she is not sure of, she
hands to a human.

**The whole voice stack is self-hosted and free** — LiveKit carries the audio,
faster-whisper listens, Piper speaks, and Claude thinks. No Vapi, no ElevenLabs, no
Twilio. The only meter running is the Anthropic API.

Built by **MuleSoo Digital Services**, Pretoria.

> **`CLAUDE.md` is the specification.** It is the source of truth for the guest
> journey, the call logic, the data model and the escalation rules. This README
> only tells you how to run what is here.

---

## Status

| Build step | State |
|---|---|
| 1. Supabase schema, RLS, demo seed | **Done — installed and live in Supabase** |
| 2. Sena's system prompt + agent config | **Done** |
| 3. Guest ID card (QR, single-use) | **Done — sample rendered, QR decodes** |
| 4. Tool router (call → hold → pay → confirm) | **Done — every gate attacked** |
| 5. Paystack webhook | **Done — signature, underpayment, idempotency** |
| 6. Guest ID delivery + front-desk scanner | **Done — the QR round trip is proven** |
| 7. Email delivery (payment link + guest ID) | **Done — no WhatsApp, no SMS, no subscription** |
| 8. Cancellations | **Done — frees the room, never refunds** |
| 9. Scheduled jobs (expire holds, arrivals, post-stay) | **Done — idempotent against the ledger** |
| 10. Free self-hosted voice stack | **Written, not yet heard** — see below |
| 11. Deploy to Vercel | Not started |
| 12. Owner dashboard | Not started — §2 promises owner visibility at six stages |
| 13. Booking confirmation PDF | Not started — gets the MuleSoo **QR credit stamp** |

**Five suites, 102 assertions, all against a real Postgres.** `npm test`. Setup:
[docs/setup-and-deploy.md](docs/setup-and-deploy.md) ·
[docs/voice-stack.md](docs/voice-stack.md).

### Where we are, in one paragraph

The database is live in Supabase and the whole guest journey exists as tested code:
Sena takes the call, holds a room against a race, refuses to save a guest she has
not double-confirmed, sends a Paystack link, refuses to confirm until the money
lands, then issues a QR guest ID that a clerk can scan — once, and only once. The
voice she takes the call *with* has just been rebuilt: Vapi, ElevenLabs and Twilio
are gone, replaced by Pipecat, Piper and LiveKit running in docker on your own box.
**That stack is written and not yet heard.** The Node half is driven and passing;
nobody has spoken to the Python half, because it needs Docker and a microphone.
The next thing that happens is somebody clicks *Call Reception* and listens.

### Decisions already taken (don't relitigate)

- **South Africa first** → Paystack in **ZAR**, not Chapa/ETB. Chapa stays in the
  spec as the Ethiopian swap-in.
- **The first property is fictional** (Jacaranda Court Hotel) so the system is
  callable before a client signs. A real hotel is a different seed file — data,
  not code.
- **The voice stack is self-hosted, and the browser is the phone.** Vapi,
  ElevenLabs and Twilio are gone; Pipecat, Piper, faster-whisper and LiveKit run in
  docker on one box. This costs a phone number, which we do not need to prove the
  product, and buys a stack with no per-minute bill in it. The seam for a real
  number (LiveKit SIP) is left open and documented, not built.
- **Amharic is deferred, and that is a real loss, not a rewording.** No
  self-hostable TTS can speak it — not Piper, not Coqui. Whisper still hears it, so
  Sena understands an Amharic speaker and answers in English. The spec asked for
  bilingual and the free stack cannot deliver it; when an Amharic voice exists it
  is one `.onnx` file away.
- **Sena's Supabase is shared with the MuleSoo website**, so every object is
  namespaced `sena_*` and the install is tested against a co-tenant app.
- The **Guest ID card carries the MuleSoo credit lockup, not the QR stamp** — the
  card exists to be scanned, and a second QR beside the guest's is the one a
  tired clerk scans at 6am. The QR stamp goes on the confirmation PDF instead.
- **Email is the delivery channel. Not WhatsApp, not SMS.** This is not a
  preference — WhatsApp *cannot* do the job. Meta refuses to deliver a free-form
  message to anyone who has not messaged you first, and a phone call does not
  open that window; business-initiated messages need approved templates and a
  verified business. Email is free, instant, reaches anyone, and every guest
  already gives Sena an address. It also means the whole stack has **no
  subscription** in it: Supabase, Vercel, Paystack test keys, Gmail SMTP, LiveKit,
  Whisper and Piper are all free. **The only meter still running is Anthropic.**

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

**Between the model and the router** (`npm run test:tools`) — Sena's tools are
declared in one file and implemented in another, in different languages. Nothing but
this test makes them agree:

10. **The two lists are one list, in both directions.** A tool the router renames
    and the config forgets is a tool Sena keeps calling into the void — and if it
    happens on `send_confirmation_package`, the hotel has taken the money and
    delivered nothing. The same test refuses to let the greeting lose the words "AI"
    or "recorded", because both are legal requirements (§0, POPIA) and both live in
    a string that is very easy to edit.

---

## The guest ID, and the front desk

The card is served as a **web page, not a PDF**. Headless Chrome cannot run in a
Vercel function, and on a phone-first market a link beats an attachment nobody
can find again. The guest gets `…/api/sena/card?v=…` by email, opens it at the
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

## The voice — free, self-hosted, nothing phoning home

| Was | Is now |
|---|---|
| Vapi — the voice agent platform | **Pipecat**, a Python process you run |
| ElevenLabs — text to speech | **Piper**, a binary on your box |
| Twilio — telephony | **LiveKit**, webRTC in the browser |
| Deepgram — speech to text | **faster-whisper**, on your CPU |
| Claude — the brain | **Claude**, still the brain |

Three things follow from this, and two of them are costs.

**A phone number is gone.** Guests reach Sena by opening a page and clicking a
button. That is the trade, and it is the right one for now: a South African number
needs a regulatory bundle that takes days to weeks, and you should not wait on a
telco to learn whether your receptionist can take a booking. LiveKit has a SIP
bridge, so [adding a real number](docs/voice-stack.md#later-a-real-phone-number) is
a bolt-on — `bot.py` does not change, and `resolveHotelId()` still resolves a hotel
from a dialled number.

**Amharic is gone, for now.** Piper has no Amharic voice and neither does Coqui.
Whisper still *hears* it, so Sena will understand an Amharic speaker and reply in
English. CLAUDE.md §0 called Amharic a requirement; the free stack cannot meet it,
and that is written down rather than quietly dropped.

**It is slower.** Deepgram transcribed in ~150 ms; local Whisper takes 300–700 ms on
a CPU. Piper wins some back by not being across a network. Net, a few hundred
milliseconds worse per turn — noticeable, survivable, and erased by a GPU.

---

## Run it

```bash
npm install
npm test            # five suites: schema, install, router, card, tools
```

To actually talk to her, two terminals:

```bash
npm run dev         # the brain:  router, gates, database   → :3000
npm run voice       # the voice:  LiveKit + Whisper + Piper → :8080
```

Then open **http://localhost:8080** and click *Call Reception*. Full guide,
including macOS/Windows/Linux install and what to do when the call connects but
nobody can hear anything: **[docs/voice-stack.md](docs/voice-stack.md)**.

```bash
npm run samples     # renders the guest ID card to docs/samples/
```

`npm run samples` needs Chrome or Edge installed (it renders the card in headless
Chrome). Set `CHROME_PATH` if it is somewhere unusual.

---

## The booking path

Sena's eleven tools (`voice-agent/agent-config.json`) all post to **one** endpoint.
The router is the other side of that wire.

```
guest clicks "Call Reception"
        │
        ▼
  LiveKit (webRTC)  ◄──►  Pipecat bot        ← voice-agent/agent/
        audio, both ways    whisper → claude → piper
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

**The router never lets the voice layer near the database.** That was the rule when
the voice layer was Vapi and it is the rule now that we own it: the bot runs a
language model a caller is actively trying to talk into things, so it gets an HTTP
endpoint and a shared secret, not a connection string.

It is also why swapping the entire voice stack changed **no gate in `src/router.mjs`
and broke no test**. The router takes a tool name and a bag of arguments. It does
not know what a microphone is.

| File | What it holds |
|---|---|
| `src/router.mjs` | The eleven tools, and every gate that protects a booking |
| `src/payments.mjs` | What happens when money lands. Separated from HTTP so it can be attacked by tests |
| `src/daily.mjs` | The work nobody is on the phone for — reminders, the owner's morning list |
| `src/adapters/paystack.mjs` | ZAR payments. Swapping in Chapa for Ethiopia is one file, and the router does not change |
| `src/adapters/notifier.mjs` | Email. Not WhatsApp — Meta will not deliver to a guest who only phoned you |
| `api/sena/*.mjs` | The Vercel endpoints. They verify secrets and delegate — nothing that matters is decided there |

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
  router.mjs                  the eleven tools, and the gates that protect a booking
  payments.mjs                what happens when money lands
  daily.mjs                   the work nobody is on the phone for
  card.mjs                    the guest ID card — QR generated without a browser
  db.mjs                      one query interface, so tests and prod run the same SQL
  adapters/                   paystack (ZAR) · email (SMTP)
api/sena/
  tool.mjs                    every tool call arrives here. The contract is ours now
  hotel.mjs                   the prompt variables — the agent's only route to the DB
  paystack-webhook.mjs        the only thing that may confirm a booking
  card.mjs                    the guest's ID card, at an unguessable URL
  desk.mjs                    the front desk: scan the QR, check the guest in
  cron.mjs                    once a day: reminders, arrivals, stays that ended
voice-agent/
  system-prompt.md            Sena's brain: disclosure, double-confirmation, escalation
  agent-config.json           the greeting, the model, the eleven tools. Vendor-neutral
  agent/
    server.py                 the switchboard: one bot process per call
    bot.py                    one call — whisper → claude → piper, over LiveKit
    piper_tts.py              Sena's voice. This is what replaced ElevenLabs
    sena_client.py            the agent's ONLY route to the router. No DB credentials
    config.py                 env vs config, and the line between them
    Dockerfile                whisper's weights baked in, so guest #1 is not the guinea pig
  web/
    reception.html            the "Call Reception" button. One file, no build step
docker-compose.yml            LiveKit + the agent. `npm run voice`
livekit.yaml                  the webRTC server. This is what replaced Twilio
templates/
  guest-id-card.html          CR80 card, themed from the hotel's own colours
scripts/
  dev-server.mjs              runs api/ locally, so you can test without deploying
  test-schema.mjs             the database cannot oversell or reuse a QR
  test-router.mjs             the router cannot be talked into either
  test-card.mjs               the card scans, and it only scans once
  test-install.mjs            the install cannot damage the co-tenant app
  test-tools.mjs              the model's tools and the router's tools are one list
  render-sample.cjs           renders the card to PDF/PNG (needs Chrome, offline only)
docs/
  voice-stack.md              install, run, tune, and bolt a phone number on later
  setup-and-deploy.md         database, money, deploy
  samples/                    what a guest actually receives
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
