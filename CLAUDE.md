# CLAUDE.md — "Sena" AI Front Desk Receptionist
### Corporate-Grade AI Voice Receptionist System for Hotels
Version 1.2 — Project instructions for Claude Code

---

## 0.0 Decisions Taken (supersede the tables below where they conflict)

| Decision | Value | Consequence |
|---|---|---|
| **First market** | **South Africa** (not Ethiopia) | Payments run on **Paystack in ZAR**, not Chapa/ETB. Chapa stays documented as the Ethiopian swap-in. Data law is **POPIA**. |
| **First property** | **Demo hotel** — "Jacaranda Court Hotel", Pretoria. **Fictional.** | The full system is built and callable now, without waiting on a client. It is the demo Ethan hands to any hotel prospect. A real hotel is a row swap, not a rebuild — see `supabase/seed-demo-hotel.sql`. |
| **Voice stack** | **Self-hosted and free.** LiveKit (webRTC) + Pipecat + faster-whisper + Piper. **No Vapi, no ElevenLabs, no Twilio.** | §5's table is superseded. The guest reaches Sena through a **Call Reception button in a browser**, not a phone number — see `docs/voice-stack.md`. The only meter running is the Anthropic API. A real phone number is a documented bolt-on (LiveKit SIP), not a rebuild. |
| **Languages** | **English only, for now.** | **This is a regression against the original spec and it is deliberate.** No self-hostable TTS can speak Amharic — not Piper, not Coqui. Whisper still *hears* Amharic, so Sena understands an Amharic speaker and answers in English. Restoring it means either an Amharic Piper voice (does not exist yet; drops in as one `.onnx` file) or paying for a voice, which reintroduces a vendor. Every §-reference to Amharic below is aspirational until then. |
| **Agency credit** | Booking PDF + Guest ID card carry the **MuleSoo credit lockup** | House rule across every MuleSoo client deliverable. |
| **Arrival** | **Self check-in: code + photo, payment optional** | The **check-in code is minted with the payment link** and appears in both the payment and confirmation emails (clearly distinguished from the booking reference — guests type the wrong one otherwise; a real test proved it). On arrival the guest enters the code on the reception page, takes/uploads a photo (auto-cropped on-device), and is checked in. **Payment is not a door**: an unpaid guest checks in normally and their pass wears an amber **PAYMENT PENDING** strip until money lands — the desk collects (owner's rule). Guard: an unpaid booking whose hold lapsed must win its room back (availability recount) or the guest is sent to the desk. The code expires **48 hours after the check-in time if never used** (no-show), on cancellation, or when the stay ends; the in-stay photo pass runs to check-out, then expires and the **photo is deleted automatically** (POPIA). See `api/sena/checkin.mjs`, `sena_self_check_in()`. |
| **Owner alerts** | **WhatsApp + email** | The owner is pinged on WhatsApp (CallMeBot for one hotel — zero Meta paperwork; Meta Cloud API for many) for every payment landed, new booking, cancellation, escalation and check-in. Email is always sent too — WhatsApp is the fast lane, never the only lane. See `src/adapters/whatsapp.mjs`. |
| **Email transport** | **Resend HTTP API** (`RESEND_API_KEY`), SMTP fallback | One HTTPS call per mail — the transport that fits Vercel functions. The professional payment email (Paystack link + full booking detail) and the confirmation email (check-in code, guest ID) both ride it. |

**Multi-tenancy note:** the schema carries a `hotels` table and a `hotel_id` on every row even though §6 does not list one. MuleSoo sells this system to many hotels; without a tenant key, hotel #2 means a second database. This costs one column now and saves a rewrite later.

---

## 0. Project Identity

| Field | Value |
|---|---|
| **AI Receptionist Name** | **Sena** (randomly generated, gender-neutral, easy to say on the phone across languages) |
| **Role** | Fully autonomous AI voice front-desk agent — replaces a human phone receptionist |
| **Disclosure Policy** | Sena **always** discloses it is an AI within the first 10 seconds of every call, in plain language, so the guest is never confused into thinking they are speaking to a human |
| **Languages** | English + Amharic (bilingual, auto-detects from caller's first sentence) |
| **Channels** | Inbound/outbound phone call, WhatsApp (booking PDF + owner alerts), Email (backup) |

This file is the operating specification **Claude Code** should use to scaffold, wire, and maintain the system end-to-end. Everything below — the journey, the call logic, the data contracts, the file structure — is what Claude Code should build against. Treat every section as a hard requirement unless the hotel owner explicitly changes it.

---

## 1. What a Human Hotel Receptionist Actually Does (Research Baseline)

**Guest-facing (phone/desk):**
- Answer every incoming call promptly and professionally
- Take reservations and check real-time room availability
- Quote rates, room types, and current promotions/plans
- Confirm arrival (check-in) and departure (check-out) dates and times
- Explain hotel amenities, breakfast times, Wi-Fi, parking, local attractions
- Take special requests (early check-in, late check-out, accessibility, dietary, quiet room, etc.)
- Collect and verify guest personal details (name, phone, email, nationality, ID/passport)
- Process payment / deposit
- Issue confirmation, receipts, and booking reference numbers
- Answer general inquiries and resolve simple complaints
- Liaise with housekeeping (room-ready status) and maintenance (issue reports)
- Maintain the reservation calendar and prevent double-booking
- Keep guest notes/preferences in the CRM/PMS for future stays

**Back-office (owner-facing):**
- Notify management of new bookings, cancellations, and no-shows
- Maintain a daily arrivals/departures list
- Escalate anything outside its authority (fraud suspicion, group bookings, VIP handling, disputes) to a human

Sena is designed to fully automate the guest-facing list and the routine parts of the back-office list, while escalating anything genuinely ambiguous.

---

## 2. End-to-End Customer Journey (Corporate View)

This is the master journey map Claude Code should build the entire system around. Each stage lists the **guest experience**, the **system/data event** behind it, and the **owner-side visibility**. Every stage must be traceable to a specific automation component in §6–§9.

### Stage 1 — Awareness & First Contact
- **Guest experience:** Guest opens the hotel's reception page and clicks **Call Reception** (no app, no download, no dialling). *Originally: the guest dialled the hotel's published number. That returns when a SIP trunk is added — see §0.0.*
- **System event:** The switchboard mints a LiveKit room and spawns Sena's bot into it; audio is flowing in under 2 seconds.
- **Owner visibility:** Call logged in Supabase `sena_calls` in real time (room id, timestamp).

### Stage 2 — Greeting & AI Disclosure
- **Guest experience:** Sena greets the guest by hotel name, clearly states it is an AI assistant, asks the guest's name. No confusion about who/what they're speaking to.
- **System event:** Session created; guest name captured as first data field.
- **Owner visibility:** None yet — informational stage only.

### Stage 3 — Discovery & Qualification
- **Guest experience:** Sena asks intent (new booking / existing booking / inquiry / complaint), then asks check-in and check-out dates.
- **System event:** Intent classified; if "complaint/urgent," journey immediately branches to **Escalation Path** (§3) and skips the rest of this map.
- **Owner visibility:** None yet.

### Stage 4 — Availability & Options Presentation
- **Guest experience:** Sena checks the live calendar, confirms availability, presents room types, rates, current plans/packages, and relevant amenities — proactively, not just Q&A.
- **System event:** Real-time query against Supabase `rooms`/`calendar` tables; provisional hold placed on the room for the duration of the call.
- **Owner visibility:** Provisional hold visible in the admin dashboard, flagged "in progress."

### Stage 5 — Timing Confirmation
- **Guest experience:** Sena explicitly asks arrival time and preferred departure time, states hotel's standard check-in/out policy, and notes any early/late request for approval.
- **System event:** Timing fields written to the pending booking record.
- **Owner visibility:** Early/late requests flagged for owner approval if outside policy.

### Stage 6 — Identity & Contact Capture (Double-Confirmation Gate)
- **Guest experience:** Sena collects full name, phone, email, nationality, and guest count — and reads each one back for explicit confirmation, twice, before moving on.
- **System event:** No record is persisted to the `guests` table until every field passes the double-confirmation gate. This is the single most important data-integrity checkpoint in the whole journey.
- **Owner visibility:** None yet — data not committed until gate passes.

### Stage 7 — Payment
- **Guest experience:** Sena states the total price, explains payment must be completed online to confirm the booking, and **emails** a secure **Paystack** payment link during the call. *Not SMS, not WhatsApp — Meta will not deliver a free-form message to a guest who only phoned you, and a call does not open that window. See `src/adapters/notifier.mjs`.*
- **System event:** Payment webhook listens for confirmation; room hold auto-releases if payment isn't completed within the hold window (15–30 min).
- **Owner visibility:** Real-time payment status (pending/paid/failed) in dashboard.

### Stage 8 — Booking Confirmation & Thank You
- **Guest experience:** Once payment clears, Sena thanks the guest by name, confirms the booking is finalized, and tells them their confirmation, Guest ID, and QR code are arriving by WhatsApp/email.
- **System event:** Booking status flips to `confirmed`; triggers PDF + QR generation pipeline.
- **Owner visibility:** New booking appears instantly on the owner's WhatsApp and dashboard.

### Stage 9 — Documentation Delivery
- **Guest experience:** Guest receives, within seconds, a Booking Confirmation PDF and a digital Hotel Guest ID with QR code (full spec in §7).
- **System event:** Documents generated from templates, stored in Supabase Storage, links pushed via WhatsApp Cloud API and email.
- **Owner visibility:** Owner receives the same package automatically (§8).

### Stage 10 — Pre-Arrival
- **Guest experience:** Optional reminder message 24 hours before check-in with directions, parking info, and any last-minute updates.
- **System event:** Scheduled n8n workflow triggers based on check-in date.
- **Owner visibility:** Daily arrivals summary sent to owner each morning.

### Stage 11 — Arrival & Verification ("Knock-Out")
- **Guest experience:** Guest presents the QR code at the front desk; front-desk device scans it, guest is checked in instantly — no re-typing of details.
- **System event:** QR scan validates against the Supabase record, marks the Guest ID `used`/`expired` so it can never be reused, and flips booking status to `checked-in`.
- **Owner visibility:** Real-time check-in confirmation on the dashboard and owner WhatsApp.

### Stage 12 — In-Stay
- **Guest experience:** Guest can call Sena again for in-stay requests (late check-out, extra amenities); Sena handles routine requests and escalates anything requiring staff action.
- **System event:** Requests logged against the existing guest/booking record for continuity.
- **Owner visibility:** Requests routed to housekeeping/maintenance queues as applicable.

### Stage 13 — Departure & Post-Stay
- **Guest experience:** Standard checkout at the stated time; optional post-stay thank-you/review-request message.
- **System event:** Booking status flips to `completed`; guest profile retained (per retention policy) for faster future bookings.
- **Owner visibility:** Stay marked complete; feeds into occupancy and revenue reporting.

**Journey principle for Claude Code:** every stage above must correspond to one discoverable event in the data model (a row, a status change, or a webhook) — the journey is not just a conversation script, it is the source of truth for the schema and workflow design in §6.

---

## 3. Escalation & Guardrails

Sena must hand off to a human staff member / the owner directly (via call transfer or urgent WhatsApp alert) when:
- The caller is upset, threatening, or describes a safety issue
- A group booking (10+ rooms) or corporate contract rate is requested
- Payment fails repeatedly or fraud is suspected (mismatched name/card/ID patterns)
- The guest asks for something outside hotel policy (refund exceptions, disputes)
- The AI is not confident it understood a critical field (dates, price, ID) after two clarification attempts

Sena never guesses on dates, prices, or personal identifiers — it always re-asks rather than assume.

---

## 4. Call Flow — Exact Conversational Logic

Maps directly onto Stages 2–9 of the customer journey above. Each step is a discrete function/tool call in the automation, not just prompt text.

1. **Greeting & AI disclosure** — state hotel name, state clearly "I am an AI assistant," ask the guest's name.
2. **Intent detection** — new booking / existing booking / inquiry / complaint. Complaint → escalate immediately.
3. **Dates & availability check** — query live calendar for the requested range; offer alternatives if unavailable.
4. **Check-in/out time confirmation** — ask explicitly; state hotel policy; flag early/late requests.
5. **Present room types & plans** — rates, packages, and proactively-mentioned amenities.
6. **Collect guest details (double-confirmation rule)** — name, phone, email, nationality, guest count, special requests; every field is repeated back and confirmed twice before being saved.
7. **Payment** — state total, send secure payment link during the call, hold room for 15–30 minutes pending payment.
8. **Booking confirmation & thank you** — confirm by name, explain documents are on the way.
9. **Wrap-up** — ask if anything else is needed, end politely, trigger all downstream automations.

---

## 5. Technology Stack (Free-Tier First, Vendor-Agnostic)

Designed to be swappable — Sena's logic layer (the prompt + n8n workflow) is decoupled from any single vendor.

> **⚠ SUPERSEDED IN PART — see §0.0.** The voice rows below (telephony, voice
> pipeline, TTS) describe the stack Sena was *first built on* and no longer uses.
> They are kept because they name the paid options, and one of them is what you
> would buy if you ever wanted a real phone number. **What is actually running is
> the free self-hosted stack**, in the second table.

| Layer | Recommended (free/cheap to start) | Alternatives |
|---|---|---|
| **Orchestration / workflow** | **n8n** (self-hosted, free, open-source) | Make.com, Zapier |
| ~~**Telephony**~~ | ~~Twilio~~ → **replaced by LiveKit webRTC** | Telnyx / Twilio, *if* a real number is wanted later |
| ~~**Voice AI pipeline**~~ | ~~Vapi~~ → **replaced by Pipecat, self-hosted** | Vocode, Dograh AI |
| ~~**TTS**~~ | ~~ElevenLabs~~ → **replaced by Piper, self-hosted** | Coqui XTTS (needs a GPU), ElevenLabs (paid) |
| **LLM brain** | **Claude API** (claude-sonnet-5) via Anthropic | — |
| **Database / calendar / booking records** | **Supabase** (free tier — already used in Jo's "ABOO HOUSE" org) | Airtable, Google Sheets |
| **Payments (Ethiopia-ready)** | **Chapa** | Telebirr, Stripe (int'l cards) |
| **PDF generation** | n8n HTML-to-PDF node / Puppeteer (free, self-hosted) | DocRaptor |
| **QR code / barcode generation** | `qrcode` npm library (free, self-hosted) | Barcode API (free tier) |
| **WhatsApp notifications** | **Meta Cloud API (WhatsApp Business)** free tier, or Twilio WhatsApp | Africa's Talking, 360dialog |
| **SMS (payment link, fallback)** | Twilio SMS / Africa's Talking | — |
| **Hosting** | Vercel (frontend/webhooks) + Supabase (backend) | Railway, Render |

### The voice stack that is actually running

Free, self-hosted, and on one small box. Full guide: `docs/voice-stack.md`.

| Layer | What it is | Why |
|---|---|---|
| **Transport** | **LiveKit** (webRTC), self-hosted in docker | Carries audio between the guest's browser and the bot. Free. Has a SIP bridge, so a real phone number is a bolt-on rather than a rewrite. |
| **Voice agent** | **Pipecat** (Python), one process per call | Replaced Vapi. Actively maintained, first-class LiveKit transport, ships services for Anthropic and Whisper. A crashed call takes down one conversation, not the switchboard. |
| **STT** | **faster-whisper**, `small`, on CPU | Replaced Deepgram. Slower (~300–700ms vs ~150ms) and free. `base` is not enough: it mishears letters, and a guest spelling an email address gets a booking that never arrives. |
| **TTS** | **Piper**, driven as a subprocess | Replaced ElevenLabs. *Faster* than it was, because there is no network hop. Coqui was rejected: the company shut down and XTTS needs a GPU for realtime. **No Amharic voice exists** — see §0.0. |
| **Guest's phone** | **A browser.** `voice-agent/web/reception.html` | There is no number to dial. This is the trade that makes the stack free. |

**The rule that made this swap cheap:** the voice layer never touches the database.
It gets `POST /api/sena/tool` and a shared secret; every gate lives in
`src/router.mjs`, behind that wire. Replacing Vapi, ElevenLabs and Twilio changed
**no gate and broke no test**. Keep it that way — the next swap should be this
boring too.

---

## 6. Data Model Backbone (What Claude Code Should Scaffold First)

Minimum Supabase tables, derived directly from the journey map in §2:

- `calls` — call log, timestamps, intent classification, outcome
- `guests` — name, phone, email, nationality (only written after double-confirmation gate passes)
- `rooms` — room types, rates, plans, live availability
- `bookings` — links guest + room + dates + status (`pending` → `confirmed` → `checked-in` → `completed`/`cancelled`)
- `guest_ids` — QR/barcode payload, verification number, `used`/`active` status
- `payments` — Chapa reference, amount, status
- `notifications_log` — WhatsApp/email/SMS sent, delivery status

---

## 7. Booking Confirmation Package (Sent Automatically After Payment)

**1. Booking Confirmation PDF** — hotel branding/contact, guest full name/phone/email/nationality, room type/rate/plan, check-in & check-out date+time, total paid + payment reference, unique **Booking Verification Number**.

**2. Hotel Guest ID (digital, QR-coded)** — Guest ID number, full name, nationality, phone, email, check-in/out date+time, and a **QR code/barcode** encoding all of the above plus the verification number, scannable at the front desk.

**3. ID Lifecycle Rule:** the check-in code is minted with the payment link and is valid until spent **once** — scanned at the desk ("knock-out") or entered at self check-in — or until **48 hours after check-in time pass unused (no-show)**, the booking is cancelled, or the stay ends, whichever comes first. On use, Supabase marks it `used`; it can never be reused or shared for a second check-in. An unpaid stay's pass reads **PAYMENT PENDING** until money lands. After check-in the card lives on as the **in-stay photo pass** until check-out, then flips to `expired` and its photo is purged. A new booking always generates a fresh ID.

---

## 8. Owner Notifications

Automatic **WhatsApp message** for every completed booking: guest name/contact/nationality, room type + dates, amount paid + status, Booking Verification Number, link to the full PDF. Also: real-time alerts for cancellations, failed payments, escalated calls, and a daily arrivals/departures summary each morning.

---

## 9. Data & Security Requirements

- All guest personal data stored in Supabase with row-level security; only the hotel's own staff/owner account can read it.
- Payment handled entirely by the gateway (Chapa) — Sena/the system never stores card numbers.
- Guest IDs expire after single use as described in §7.
- Retain booking records per local data-retention norms; purge on owner request.
- Log every call transcript for quality review and dispute resolution, with consent stated during the AI disclosure at call start.

---

## 10. Suggested Project File Structure (for Claude Code to scaffold)

> **Superseded by what was actually built.** n8n was never used — the workflows it
> would have held became `src/router.mjs`, which is testable, diffable, and cannot
> be edited by accident in a browser. WhatsApp was dropped (Meta will not deliver to
> a guest who only phoned you); email replaced it. The real tree is in `README.md`.

```
sena-ai-receptionist/
├── CLAUDE.md                     # this file — the spec
├── voice-agent/
│   ├── system-prompt.md          # Sena's full call-flow prompt (from §4)
│   ├── agent-config.json         # the greeting, the model, the eleven tools
│   ├── agent/                    # the Pipecat bot: whisper → claude → piper
│   └── web/reception.html        # the guest's "phone": a button in a browser
├── src/                          # the brain. Every gate that protects a booking
│   ├── router.mjs                # the eleven tools (this is what n8n would have been)
│   ├── payments.mjs  daily.mjs  card.mjs  db.mjs
│   └── adapters/                 # paystack (ZAR) · email (SMTP)
├── api/sena/                     # the Vercel endpoints — verify, delegate, decide nothing
├── supabase/
│   ├── schema.sql                # tables from §6
│   ├── policies.sql              # RLS rules
│   └── sena-all-in-one.sql       # generated: the one file you paste into Supabase
├── templates/guest-id-card.html  # CR80 card w/ QR
├── docker-compose.yml            # LiveKit + the agent
└── docs/
    ├── voice-stack.md            # install/run/tune the free voice stack
    └── setup-and-deploy.md       # database, money, deploy
```

---

## 11. Open Decisions for the Hotel Owner (Confirm Before Build)

1. Standard check-in / check-out times and any early/late fees
2. Room types, rates, and current plans/packages to load into the system
3. Cancellation and refund policy (Sena needs exact wording to quote)
4. Escalation phone number / WhatsApp number for urgent handoffs
5. Preferred payment gateway (Chapa confirmed, or also enable Telebirr/cards?)
6. Data retention period for guest records

---

*Build order — done, in this order: (1) `supabase/schema.sql`, (2) `src/router.mjs`
(the booking flow; n8n was never used), (3) `voice-agent/system-prompt.md`,
(4) the Paystack webhook, (5) the QR guest ID + email delivery, (6) cancellations and
the daily jobs, (7) the free self-hosted voice stack, (8) the owner dashboard and the
booking confirmation document, (9) the arrival flow: self check-in by code + photo,
the in-stay photo pass with PNG/PDF download, owner WhatsApp alerts, Resend email.*

*What is left: deploy (Vercel + Supabase + a box for the voice stack — blocked on
accounts) · on-call tap options over the LiveKit data channel (choices and a Pay-now
button on the guest's screen mid-call) · a real phone number (LiveKit SIP, paid).*
