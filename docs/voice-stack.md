# The voice stack — free, self-hosted, and on your laptop in an hour

Sena used to speak through three companies. She does not any more.

| Was | Is now | What it cost | What it costs |
|---|---|---|---|
| **Vapi** — voice agent platform | **Pipecat**, a Python process you run | ~$0.05/min | nothing |
| **ElevenLabs** — text to speech | **Piper**, a binary on your box | per character | nothing |
| **Twilio** — telephony | **LiveKit**, webRTC in the browser | ~$1/mo + per minute | nothing |
| *(Deepgram, inside Vapi)* | **faster-whisper**, on your CPU | per minute | nothing |
| **Claude** — the brain | **Claude** — still the brain | per token | per token |

**The only meter still running is Anthropic**, and it was always running. Everything
else on this page is open source and runs on one small server.

**What you give up:** a phone number. Guests reach Sena by opening a web page and
clicking *Call Reception*, not by dialling. That is the trade, and it is a good one
while you are proving the thing works — a South African phone number needs a
regulatory bundle (ID, proof of address, two business days to several weeks), and
you should not be waiting on a telco to find out whether your receptionist can take
a booking. [Adding a real number later](#later-a-real-phone-number) is a bolt-on,
not a rebuild.

---

## The shape of it

```
  guest's browser                        your box (or one $5 VPS)
 ┌───────────────┐                 ┌──────────────────────────────────┐
 │ reception.html│──POST /connect──►  switchboard   (server.py)       │
 │  "Call        │◄─── token ──────│      │ spawns one bot per call   │
 │   Reception"  │                 │      ▼                           │
 │               │                 │   bot.py                         │
 │      ┌────────┴──── webRTC ─────┼──► LiveKit ◄── webRTC ── bot     │
 │      │ microphone               │      audio, both ways            │
 └──────┴────────┘                 │                                  │
                                   │   faster-whisper → Claude → Piper│
                                   └──────────────┬───────────────────┘
                                                  │ the eleven tools, over HTTP
                                                  ▼
                                    POST /api/sena/tool   (Node, this repo)
                                                  │
                                                  ▼
                                             Supabase
```

Two things are worth noticing.

**The bot has no database credentials.** It runs a language model that a caller is
actively trying to talk into things, so it is the least trusted component here. It
gets an HTTP endpoint and a shared secret. Every rule that matters — the
double-confirmation gate, the room-hold lock, the refusal to confirm an unpaid
booking — is enforced in `src/router.mjs`, on the other side of that wire, where a
persuasive guest cannot reach it.

**One process per call.** A crash takes down one conversation, not the hotel's
switchboard, and no state leaks from one guest to the next.

---

## Install it

You need **Docker** and **Node 20+**. That is the whole list — Whisper, Piper,
Pipecat and LiveKit all live inside the container, so there is nothing else to
install on your machine and nothing to uninstall later.

### macOS

```bash
brew install --cask docker    # then open Docker Desktop once, so it starts the engine
brew install node
```

Apple Silicon works fine. Whisper runs on the CPU here; it is a little slower than
on a Linux box with AVX-512, and you will not notice on a demo.

### Windows

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and
[Node](https://nodejs.org). Docker Desktop needs **WSL 2** — its installer will
offer to set that up, and you should let it.

Run the commands below from **PowerShell** or **Git Bash**, not from `cmd`.

### Linux

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER      # then log out and back in, or `docker` needs sudo forever
sudo apt install nodejs npm
```

This is the box to be on if you care about latency. Whisper is CPU-bound and Linux
gives it the most to work with.

---

## Configure it

```bash
cp .env.example .env.local
```

Four things must be filled in before anything will start. The file explains the
rest.

```bash
# 1. The only paid thing in the stack.
ANTHROPIC_API_KEY=sk-ant-...

# 2. What proves a tool call came from our agent and not from the internet.
#    Generate:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SENA_WEBHOOK_SECRET=...

# 3. Your Supabase connection string (Project Settings → Database → URI, port 6543).
DATABASE_URL=postgresql://...

# 4. Which hotel answers. For the demo:  select id from sena_hotels where is_demo;
SENA_DEFAULT_HOTEL_ID=...
```

If you have not installed the database yet, do that first — paste
`supabase/sena-all-in-one.sql` into the Supabase SQL editor. See
[setup-and-deploy.md](setup-and-deploy.md).

---

## Run it

Two terminals. The split is deliberate: the Node API is the part that goes to
Vercel in production, so you run it the same way locally and test the thing you
actually ship.

**Terminal 1 — the brain** (the router, the gates, the database):

```bash
npm install
npm run dev            # → http://localhost:3000
```

**Terminal 2 — the voice** (LiveKit, Whisper, Claude, Piper):

```bash
npm run voice          # → docker compose up --build
```

The first build takes **five to fifteen minutes** and downloads about 2 GB: Whisper's
weights, Torch, and a Piper voice. It is baked into the image on purpose — downloading
Whisper on the first call means your first guest waits ninety seconds for a greeting
and blames the hotel. Subsequent starts are seconds.

**Then open [http://localhost:8080](http://localhost:8080) and click *Call
Reception*.** Allow the microphone. Sena will greet you, tell you she is an AI, and
take a booking.

### Is it working?

```bash
curl localhost:3000                 # the brain: lists its routes
curl localhost:8080/health          # the switchboard: {"ok":true,"bots":0}
docker compose logs -f agent        # watch a call happen
```

In the agent log, a healthy call looks like this — the tool calls are Sena
actually doing her job:

```
sena.server: call sena-x7Kp2mQ → hotel 3f9c… (bot pid 41)
sena.bot   : guest joined sena-x7Kp2mQ — greeting
sena.client: tool log_call_intent → ok
sena.client: tool check_availability → ok
sena.client: tool hold_room → ok
sena.client: tool save_guest_details → not_double_confirmed     ← the gate holding
sena.client: tool save_guest_details → ok
sena.client: tool send_payment_link → ok
```

---

## When it does not work

**The call connects and nobody can hear anything.** This is almost always LiveKit
advertising an address the browser cannot reach. On localhost, `--node-ip 127.0.0.1`
in `docker-compose.yml` handles it. On a real server, that must be the server's
**public** IP, or set `use_external_ip: true` in `livekit.yaml`. It is the single
most common failure in self-hosted webRTC and it looks exactly like a working call.

**Sena greets me and then never responds.** Whisper is not hearing you. Check the
browser actually granted the microphone (the page says so), then check the agent
log for STT output. On a slow CPU, `WHISPER_MODEL=small` can take several seconds —
drop to `base` to confirm it is a speed problem, then put it back, because `base`
mishears letters and a guest spelling out an email address will get a booking that
never arrives.

**`piper binary not found` / `piper voice not found`.** The container builds these
in; you only see this running the agent outside Docker. Set `PIPER_BINARY` and
`PIPER_VOICE` to real paths.

**Every tool call returns "something went wrong".** The agent and the API disagree
about the secret. `SENA_WEBHOOK_SECRET` must be byte-identical in `.env.local` and
in the agent's environment. A 401 in the agent log confirms it.

**Sena says "{{cancellation_policy}}" out loud.** The hotel row is missing a field
the prompt needs. The agent is supposed to refuse to start rather than do this —
if you see it, `api/sena/hotel.mjs` is not returning every placeholder in
`system-prompt.md`.

---

## Tuning it

Everything here is a trade against **the pause the guest hears**. A guest starts to
feel it at about 900 ms.

| Knob | Where | Trade |
|---|---|---|
| `WHISPER_MODEL` | `.env.local` | `base` is fast and mishears letters. `small` is the floor for a guest spelling an email address. `medium` is better and about twice as slow — worth it on a GPU box. |
| Piper voice | `PIPER_VOICE` | Ships as `en_GB-cori-medium`. **There is no South African voice** — Piper has only `en_GB` and `en_US`, and British RP is the closest fit to non-rhotic SA English. This is the sharpest single regression from ElevenLabs. `medium` beats `low` for ~30 ms. Browse [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices). |
| Claude model | `agent-config.json` | Sonnet is chosen for latency, not for economy. A bigger model thinks longer, and on a call a wrong-sounding pause costs more trust than a better sentence buys. |
| `temperature` | `agent-config.json` | 0.3, and it should stay low. This agent quotes prices and policies; creativity here is a defect. |

**A GPU changes everything.** Whisper is the bottleneck, and it is the one component
that gets dramatically faster with one. If you want telephone-grade responsiveness,
that is the upgrade — not a better TTS.

---

## What this stack cannot do

**It cannot speak Amharic.** Piper has no Amharic voice and neither does Coqui.
Whisper can still *hear* Amharic, so Sena will understand an Amharic speaker and
answer them in English. CLAUDE.md §0 lists Amharic as a requirement; the free stack
does not meet it, and that is recorded there rather than quietly ignored. If an
Amharic Piper voice ever appears, it drops in as one more `.onnx` file and one
environment variable.

**It cannot answer a telephone.** See below.

**It is slower than the paid stack was.** Deepgram transcribed in ~150 ms; local
Whisper on a CPU takes 300–700 ms. Piper claws some of it back by not being on the
other side of a network (~50 ms against ElevenLabs' ~250 ms). Net, you are a few
hundred milliseconds slower per turn. It is noticeable and it is survivable, and a
GPU erases it.

---

## Later: a real phone number

Nothing in the agent knows it is talking to a browser. LiveKit has a **SIP bridge**,
so a real inbound number means pointing a SIP trunk at LiveKit and having it drop
the caller into a room exactly like the one the bot already joins.

`voice-agent/agent/bot.py` does not change. What changes:

1. Buy a number from **Telnyx** (cheapest for South Africa) or **Twilio**, and point
   its SIP trunk at your LiveKit SIP endpoint.
2. The room's metadata carries the **dialled number** instead of a hotel id.
   `resolveHotelId()` in `src/router.mjs` already resolves a hotel from a dialled
   number — that path was never removed, and `sena_hotels.phone` is what it matches
   against.
3. `escalate_to_human` becomes a real call transfer instead of "a person will call
   you back".

That is the whole migration. It is deliberately small, and it is deliberately not
built yet — you should find out whether Sena can take a booking before you find out
whether a telco will sell you a number.
