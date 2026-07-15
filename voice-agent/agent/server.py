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


class ConnectRequest(BaseModel):
    hotel_id: str | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail at boot if the environment is wrong, not on the first guest. A missing
    # ANTHROPIC_API_KEY should be a container that will not start, not a call
    # where Sena greets someone warmly and then goes silent forever.
    app.state.settings = Settings.from_env()
    log.info("sena switchboard up — api=%s livekit=%s", app.state.settings.sena_api_url, app.state.settings.livekit_url)
    yield
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
    return {"ok": True, "bots": len(BOTS)}


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


@app.post("/connect")
async def connect(req: ConnectRequest) -> dict:
    settings: Settings = app.state.settings

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

    # The bot joins first. If it started after the guest, the guest would sit in
    # an empty room listening to nothing, which reads as a dropped call — and the
    # on_first_participant_joined greeting would never fire.
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(Path(__file__).resolve().parent / "bot.py"),
        "--room", room,
        "--hotel-id", hotel_id,
        "--token", bot_token,
        cwd=str(Path(__file__).resolve().parent),
    )
    BOTS[room] = proc
    asyncio.create_task(_reap(room, proc))

    log.info("call %s → hotel %s (bot pid %s)", room, hotel_id, proc.pid)

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
