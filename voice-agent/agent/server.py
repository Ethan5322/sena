"""
The switchboard. A guest clicks "Call Reception"; this decides what happens next.

    browser  ──POST /connect {hotel_id}──►  here
                                             │  mint a room
                                             │  mint a token for the guest
                                             │  mint a token for the bot
                                             │  spawn bot.py into that room
    browser  ◄── {url, token, room} ─────────┘
    browser  ──webRTC──► LiveKit ◄──webRTC── bot.py

ONE PROCESS PER CALL. The alternative — a long-lived bot pool — means a crash in
one guest's conversation takes down everyone's, and it means state from the last
call can leak into the next one. A hotel switchboard that drops every caller
because one of them said something odd is not a switchboard. Processes are cheap;
trust is not.

WHY THE BROWSER DOES NOT CHOOSE THE HOTEL. It sends a hotel_id, but we do not
believe it — we ask the API whether that hotel exists before we mint anything, and
the id we put in the room is the one the API confirmed. Multi-tenancy is decided
on this box, not in the guest's laptop. Get this wrong and hotel A's reception
line answers with hotel B's rates.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
import json
from livekit import api
from pydantic import BaseModel

from config import Settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-5s %(name)s: %(message)s",
)
log = logging.getLogger("sena.server")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

# Live bot processes, so we can reap them and so a redeploy does not orphan a
# guest mid-sentence.
BOTS: dict[str, asyncio.subprocess.Process] = {}

# The standby bot: booted, models loaded, waiting for a room on stdin. A cold
# bot.py takes 30–60 seconds to boot on a small box, and the guest pays that in
# silence — a real guest hung up before Sena arrived. One process is kept warm
# ahead of the call; /connect hands it the room and warms the next. Costs a few
# hundred MB of resident RAM while idle; SENA_WARM_BOT=0 turns it off on a box
# that cannot spare it.
WARM_ENABLED = os.environ.get("SENA_WARM_BOT", "1") != "0"
STANDBY: dict = {"proc": None, "ready": False}


class ConnectRequest(BaseModel):
    hotel_id: str | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail at boot if the environment is wrong, not on the first guest. A missing
    # ANTHROPIC_API_KEY should be a container that will not start, not a call
    # where Sena greets someone warmly and then goes silent forever.
    app.state.settings = Settings.from_env()
    log.info("sena switchboard up — api=%s livekit=%s", app.state.settings.sena_api_url, app.state.settings.livekit_url)
    await _spawn_standby()
    yield
    standby = STANDBY["proc"]
    if standby is not None and standby.returncode is None:
        standby.kill()
    for room, proc in list(BOTS.items()):
        if proc.returncode is None:
            log.info("killing bot for %s", room)
            proc.kill()


app = FastAPI(title="Sena — switchboard", lifespan=lifespan)

# The reception page is served from the hotel's own site in production, so it is
# a different origin to this box. Lock this down to that origin before it faces
# a real guest — "*" is a prototype convenience, not a decision.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("SENA_ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "bots": len(BOTS), "standby": bool(STANDBY["ready"])}


async def _spawn_standby() -> None:
    """Boot the next call's bot now, so no guest ever waits for Python."""
    if not WARM_ENABLED:
        return
    existing = STANDBY["proc"]
    if existing is not None and existing.returncode is None:
        return  # one is already warming or warm
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(Path(__file__).resolve().parent / "bot.py"),
        "--warm",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,  # carries exactly one line: READY
        cwd=str(Path(__file__).resolve().parent),
    )
    STANDBY["proc"], STANDBY["ready"] = proc, False
    asyncio.create_task(_watch_standby(proc))


async def _watch_standby(proc: asyncio.subprocess.Process) -> None:
    line = await proc.stdout.readline()
    if line.strip() == b"READY" and STANDBY["proc"] is proc:
        STANDBY["ready"] = True
        log.info("standby bot warm (pid %s)", proc.pid)
        return
    # It died booting, or printed nonsense. Either way it is not a standby.
    code = await proc.wait()
    if STANDBY["proc"] is proc:
        STANDBY["proc"], STANDBY["ready"] = None, False
        log.error("standby bot exited %s before READY — retrying in 30s", code)
        await asyncio.sleep(30)
        if STANDBY["proc"] is None:
            await _spawn_standby()


async def _spawn_standby_later(delay: float) -> None:
    await asyncio.sleep(delay)
    await _spawn_standby()


def _take_standby() -> asyncio.subprocess.Process | None:
    proc = STANDBY["proc"]
    if not (WARM_ENABLED and STANDBY["ready"] and proc and proc.returncode is None):
        return None
    STANDBY["proc"], STANDBY["ready"] = None, False
    return proc


@app.get("/")
async def reception(request: Request) -> HTMLResponse:
    """The 'Call Reception' page. In production this lives on the hotel's site.

    The page carries a second door — "check in with your code" — and that page
    lives on the API, not on this box. This container knows the API as
    host.docker.internal, an address that means nothing to the guest's phone,
    so the hostname the GUEST used to reach us is substituted in: a laptop gets
    localhost, a phone on the WiFi gets the PC's LAN IP, and a deployed box
    gets its public name. Override with SENA_CHECKIN_URL when the API has a
    proper address of its own (the Vercel case).
    """
    html = (WEB_DIR / "reception.html").read_text(encoding="utf-8")
    checkin = os.environ.get("SENA_CHECKIN_URL") or (
        f"{app.state.settings.sena_api_url.rstrip('/')}/api/sena/checkin"
    )
    checkin = checkin.replace("host.docker.internal", request.url.hostname or "localhost")
    inject = f"<script>window.SENA_CHECKIN_URL = {json.dumps(checkin)};</script>"
    return HTMLResponse(html.replace("</head>", inject + "\n</head>", 1))


async def _resolve_hotel(settings: Settings, hotel_id: str | None) -> str:
    """
    Ask the API which hotel this is — the browser is not a source of truth about
    anything, and neither is this box's environment.

    Called WITHOUT a hotel_id, the API answers with its own default (in demo mode
    that is the demo hotel, whose id is minted fresh at every `npm run dev` and so
    cannot be pinned in any env file). Called WITH one, the API either confirms it
    exists or 404s. Either way, the id we put in the room is one the API vouched
    for.
    """
    async with httpx.AsyncClient(timeout=10) as http:
        r = await http.get(
            f"{settings.sena_api_url.rstrip('/')}/api/sena/hotel",
            params={"hotel_id": hotel_id} if hotel_id else None,
            headers={"x-sena-secret": settings.sena_secret},
        )
    if r.status_code == 401:
        raise HTTPException(500, "the switchboard's secret does not match the API")
    if r.status_code != 200:
        # Loudly. A reception line that answers for a hotel that does not exist is
        # worse than one that does not answer.
        raise HTTPException(404, f"unknown hotel: {hotel_id or '(no default either)'}")
    return r.json()["hotel_id"]


# One bot process per call means /connect is a fork bomb with a public URL
# unless it is capped. Five concurrent calls is generous for one hotel and one
# small box; a sixth caller hears "lines busy" instead of crashing the five.
MAX_CALLS = int(os.environ.get("SENA_MAX_CALLS", "5"))


@app.post("/connect")
async def connect(req: ConnectRequest) -> dict:
    settings: Settings = app.state.settings

    if len(BOTS) >= MAX_CALLS:
        raise HTTPException(503, "all reception lines are busy — please try again in a minute")

    hotel_id = await _resolve_hotel(
        settings, req.hotel_id or settings.default_hotel_id or None
    )

    room = f"sena-{secrets.token_urlsafe(9)}"

    def token(identity: str) -> str:
        return (
            api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
            .with_identity(identity)
            .with_grants(api.VideoGrants(room_join=True, room=room))
            .to_jwt()
        )

    guest_token = token("guest")
    bot_token = token("sena")

    # The bot must be in the room before the guest loses patience. The standby
    # is already booted — models loaded — and only has to join; hand it the room
    # over stdin and warm its replacement. Fall back to a cold spawn when the
    # standby is not there (first seconds after boot, or SENA_WARM_BOT=0) — slow,
    # but slow beats busy.
    job = {"room": room, "hotel_id": hotel_id, "token": bot_token}
    proc = _take_standby()
    if proc is not None:
        try:
            proc.stdin.write((json.dumps(job) + "\n").encode())
            await proc.stdin.drain()
            proc.stdin.close()
            # Its stdout pipe stays ours; drain it forever so the bot can never
            # block on a full pipe, whatever it prints.
            asyncio.create_task(proc.stdout.read())
            log.info("call %s → hotel %s (warm bot pid %s)", room, hotel_id, proc.pid)
        except (BrokenPipeError, ConnectionResetError):
            log.error("standby bot pid %s died at handoff — cold-spawning", proc.pid)
            proc = None
    if proc is None:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            str(Path(__file__).resolve().parent / "bot.py"),
            "--room", room,
            "--hotel-id", hotel_id,
            "--token", bot_token,
            cwd=str(Path(__file__).resolve().parent),
        )
        log.info("call %s → hotel %s (cold bot pid %s)", room, hotel_id, proc.pid)
    BOTS[room] = proc
    asyncio.create_task(_reap(room, proc))
    # The replacement standby waits half a minute: its torch imports would
    # otherwise fight THIS call's room join and greeting for the two cores this
    # box has. A second caller inside that window gets a cold bot — slow beats
    # stealing the current guest's first words.
    asyncio.create_task(_spawn_standby_later(30))

    # The PUBLIC address, never the bot's. The browser is not on the docker
    # network and cannot resolve "livekit" — see Settings for the split.
    return {"url": settings.livekit_public_url, "token": guest_token, "room": room}


async def _reap(room: str, proc: asyncio.subprocess.Process) -> None:
    code = await proc.wait()
    BOTS.pop(room, None)
    if code != 0:
        # The guest heard silence. Somebody should know why.
        log.error("bot for %s exited %s", room, code)
    else:
        log.info("bot for %s finished", room)
