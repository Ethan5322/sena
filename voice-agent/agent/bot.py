"""
Sena — one call.

This is the process that replaced Vapi. It joins a LiveKit room as a participant
and runs the loop that used to be somebody's platform:

    guest's audio  →  faster-whisper  →  Claude (+ the eleven tools)  →  Piper  →  guest's ears

Everything here is either open source or already paid for. There is no per-minute
voice bill, no TTS bill, and no telephony bill — the only meter running is the
Anthropic API, which was always running.

One process per call, spawned by server.py and dead when the room empties. That
is deliberate: a crashed call takes down one guest's conversation, not the hotel's
switchboard, and there is no long-lived state to corrupt between calls.

WHERE A REAL PHONE NUMBER PLUGS IN
----------------------------------
Nothing below knows it is talking to a browser. LiveKit has a SIP bridge, so a
real inbound number is added by pointing a SIP trunk (Telnyx, Twilio, Vonage) at
LiveKit and having it drop the caller into a room exactly like the one this bot
joins. This file does not change. What changes:

  * the room's metadata carries the DIALLED number instead of a hotel id, and
    src/router.mjs resolves the hotel from it — that path is still there and
    still works (see resolveHotelId).
  * escalate_to_human becomes a real transfer instead of "a person will call
    you back".

That is the whole migration, and it is why we are not building for it today.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams

# RNNoise cleans the guest's audio before anything downstream hears it. If the
# wheel is ever missing (a partial rebuild), the import fails loudly here rather
# than silently dropping noise suppression on a live call — but we still let the
# bot run without it, because a call with noise beats no call.
try:
    from pipecat.audio.filters.rnnoise_filter import RNNoiseFilter
except Exception:  # noqa: BLE001
    RNNoiseFilter = None
from pipecat.frames.frames import EndFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.services.ollama.llm import OLLamaLLMService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.transcriptions.language import Language
from pipecat.transports.livekit.transport import LiveKitParams, LiveKitTransport

from config import AgentConfig, Settings, render_system_prompt
from piper_tts import PiperTTSService
from sena_client import SenaClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-5s %(name)s: %(message)s",
)
log = logging.getLogger("sena.bot")


class WarmParts:
    """Everything a call needs that does not need the call.

    On a small box these constructions cost 15–60 seconds (Whisper dominates),
    and a guest in a silent room pays every one of them. Building them is
    separated from run_bot so the standby process (see warm_and_wait) can do it
    BEFORE a guest exists. The only work left for the call itself is the hotel
    context fetch and the LiveKit room join.
    """

    def __init__(self) -> None:
        self.settings = Settings.from_env()
        self.cfg = AgentConfig.load()

        # Silero decides when the guest has stopped talking. RNNoise now removes
        # the room noise UPSTREAM of this (see the transport), so the VAD no
        # longer has to be cranked deaf to survive a café — which would also
        # miss a soft-spoken guest. These are moderate: confident enough not to
        # trip on a stray click, sensitive enough to hear someone speaking
        # quietly. stop_secs 0.8 lets a guest pause mid-sentence without Sena
        # jumping in.
        self.vad = SileroVADAnalyzer(
            params=VADParams(confidence=0.7, min_volume=0.6, start_secs=0.2, stop_secs=0.8)
        )

        # Local Whisper — the model loads HERE, at construction. 'small' is the
        # floor: 'base' mishears letters, and a guest spelling out an email
        # address into a model that hears "m" as "n" produces a booking that
        # never reaches them.
        #
        # `language` is Pipecat's Language enum, not a string — passing "en"
        # here is accepted silently and then ignored, which is the worst kind
        # of wrong.
        self.stt = WhisperSTTService(
            model=self.settings.whisper_model or self.cfg.stt_model,
            language=Language(self.cfg.stt_language),
        )

        self.tts = PiperTTSService(
            voice_model=self.settings.piper_voice,
            piper_binary=self.settings.piper_binary,
        )

        # The brain. Claude in production; a hosted free tier (Groq et al, via
        # the OpenAI-compatible path) while there is no budget; a local model
        # through Ollama when there is no account at all. Same tools, same
        # context, same pipeline — the provider is one constructor. All take
        # temperature 0.3, because this agent quotes prices and policies and
        # creativity here is a defect regardless of who is thinking.
        settings, cfg = self.settings, self.cfg
        if settings.llm_provider == "ollama":
            log.warning(
                "brain: OLLAMA (%s) — free and local. Expect slow turns on a small "
                "CPU and clumsy tool use. This proves the plumbing, not the product.",
                settings.ollama_model,
            )
            self.llm = OLLamaLLMService(
                model=settings.ollama_model,
                base_url=settings.ollama_base_url,
                params=OLLamaLLMService.InputParams(temperature=cfg.temperature),
            )
        elif settings.llm_provider == "openai":
            log.info(
                "brain: OpenAI-compatible — %s at %s (a hosted free tier is a real "
                "demo brain; swap to Claude by changing LLM_PROVIDER when there is "
                "budget)",
                settings.llm_model,
                settings.llm_base_url,
            )
            self.llm = OpenAILLMService(
                api_key=settings.llm_api_key,
                base_url=settings.llm_base_url,
                model=settings.llm_model,
                params=OpenAILLMService.InputParams(temperature=cfg.temperature),
            )
        else:
            self.llm = AnthropicLLMService(
                api_key=settings.anthropic_api_key,
                model=cfg.model,
                params=AnthropicLLMService.InputParams(
                    temperature=cfg.temperature,
                    max_tokens=cfg.max_tokens,
                ),
            )


async def run_bot(room: str, hotel_id: str, token: str, parts: WarmParts | None = None) -> None:
    parts = parts or WarmParts()  # cold spawn builds everything now, slowly
    settings = parts.settings
    cfg = parts.cfg
    client = SenaClient(settings.sena_api_url, settings.sena_secret)

    # The identity of this call, as far as the database is concerned. The room
    # name IS the call id: it is unique, it is what LiveKit already knows, and it
    # is what you grep for when a guest complains.
    call = {"id": room, "hotel_id": hotel_id, "dialed_number": None, "from_number": None}

    # ── Which hotel, and what may Sena say about it ──────────────────────────
    # Fetched, never guessed. Every rate, time and policy Sena quotes comes from
    # the hotel's own row — CLAUDE.md's rule is that if it did not come from the
    # data, she does not know it.
    context_data = await client.hotel_context(hotel_id)
    system_prompt = render_system_prompt(context_data["prompt_vars"])

    # "Good morning / afternoon / evening" — in the HOTEL's timezone, not the
    # server's. A greeting that gets the time of day wrong sounds like a call
    # centre on another continent, which is exactly the impression to avoid.
    try:
        from zoneinfo import ZoneInfo
        from datetime import datetime

        tz = context_data["prompt_vars"].get("timezone") or "Africa/Johannesburg"
        hour = datetime.now(ZoneInfo(tz)).hour
    except Exception:
        hour = 12
    time_of_day = "morning" if hour < 12 else ("afternoon" if hour < 17 else "evening")

    greeting = (
        cfg.first_message
        .replace("{{hotel_name}}", context_data["prompt_vars"]["hotel_name"])
        .replace("{{time_of_day}}", time_of_day)
    )
    escalation_phone = context_data.get("escalation_phone")

    # ── The pipeline ────────────────────────────────────────────────────────
    # The transport is the one heavy piece that cannot be prebuilt: it carries
    # the room name and token, and those only exist once a guest calls.
    # RNNoise runs FIRST in the input chain: it scrubs the guest's audio so the
    # VAD and Whisper both receive a clean voice, not a voice buried in a café.
    # This is what lets Sena hold a conversation in a noisy room the way a paid
    # assistant does. Built once per call in parts is not possible (it holds
    # per-stream state), so it is constructed here; it is light.
    noise_filter = RNNoiseFilter() if RNNoiseFilter else None
    if noise_filter is None:
        log.warning("RNNoise unavailable — running WITHOUT noise suppression")

    transport = LiveKitTransport(
        url=settings.livekit_url,
        token=token,
        room_name=room,
        params=LiveKitParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_filter=noise_filter,
            vad_analyzer=parts.vad,
        ),
    )

    stt = parts.stt
    tts = parts.tts
    llm = parts.llm

    # ── The eleven tools ────────────────────────────────────────────────────
    # Registered from agent-config.json, so the names the model can call and the
    # names src/router.mjs implements come from ONE list. A tool the model knows
    # about but the router does not is the worst failure in the system: Sena
    # narrates a success that never happened, to a real guest, on a real call.
    tools = ToolsSchema(
        standard_tools=[
            FunctionSchema(
                name=t["name"],
                description=t["description"],
                properties=t["input_schema"].get("properties", {}),
                required=t["input_schema"].get("required", []),
            )
            for t in cfg.tools
        ]
    )

    # end_call is the one tool with a side effect on the pipeline itself, so the
    # bot has to watch for it rather than just forwarding it to the router.
    hang_up = asyncio.Event()
    greeted = asyncio.Event()

    def make_handler(name: str):
        async def handler(params):
            args = params.arguments or {}
            result = await client.call_tool(name, args, call)

            # There is no line to transfer to on a browser call. The router's
            # `say` carries the real handover (WhatsApp the manager directly —
            # the number is read aloud, digit by digit); this only fills in if
            # an older router said nothing. The owner has already been pinged.
            if name == "escalate_to_human":
                result.setdefault("transfer_to", escalation_phone)
                result.setdefault(
                    "say",
                    "There is no way to transfer this browser call. Give the guest "
                    f"this number — {result.get('transfer_to')} — tell them a person "
                    "will call them back, and end the call.",
                )

            await params.result_callback(result)

            if name == "end_call":
                hang_up.set()

        return handler

    for name in cfg.tool_names:
        llm.register_function(name, make_handler(name))

    # ── Context ─────────────────────────────────────────────────────────────
    # The greeting goes in as an assistant turn even though the model did not
    # generate it (see below), because a model that does not know it already said
    # hello will say hello again.
    context = LLMContext(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "assistant", "content": greeting},
        ],
        tools=tools,
    )
    aggregator = LLMContextAggregatorPair(context)

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            aggregator.user(),
            llm,
            tts,
            transport.output(),
            aggregator.assistant(),
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(allow_interruptions=True),
    )

    @transport.event_handler("on_first_participant_joined")
    async def _greet(transport, participant):  # noqa: ANN001
        # THE DISCLOSURE IS SPOKEN, NOT GENERATED.
        #
        # CLAUDE.md §0 requires Sena to say she is an AI within ten seconds, and
        # POPIA requires the recording consent in the same breath. If we asked the
        # model to produce that sentence, it would paraphrase it — sometimes
        # beautifully, sometimes without the word "AI" in it, and once in a
        # thousand calls not at all. So we say it verbatim, as audio, before the
        # model has any say in the matter.
        log.info("guest joined %s — greeting", room)
        greeted.set()
        # The guest's browser needs a beat to attach the bot's audio track
        # after joining. Speak instantly and the first words are lost — a real
        # guest heard only "…calls are recorded…" and concluded Sena never
        # greeted them at all. A short breath fixes the whole first impression.
        await asyncio.sleep(1.5)
        await task.queue_frames([TTSSpeakFrame(greeting)])

    @transport.event_handler("on_participant_left")
    async def _left(transport, participant, reason):  # noqa: ANN001
        log.info("guest left %s (%s)", room, reason)
        await task.queue_frames([EndFrame()])

    async def _watch_hangup() -> None:
        """end_call fired, or the call ran past its limit."""
        try:
            await asyncio.wait_for(hang_up.wait(), timeout=cfg.max_duration_seconds)
            log.info("end_call — hanging up %s", room)
        except asyncio.TimeoutError:
            # 15 minutes. A booking call runs 4–6; anything at 15 has gone wrong
            # and should have been with a human already.
            log.warning("%s hit max duration — hanging up", room)
        await task.queue_frames([EndFrame()])

    async def _watch_lonely() -> None:
        """Nobody ever arrived. A guest who gave up during the connect is not
        coming back through this room; free its slot instead of idling out the
        pipeline's five-minute timeout."""
        try:
            await asyncio.wait_for(greeted.wait(), timeout=90)
        except asyncio.TimeoutError:
            log.warning("%s: no guest within 90s — hanging up", room)
            await task.queue_frames([EndFrame()])

    runner = PipelineRunner()
    watcher = asyncio.create_task(_watch_hangup())
    lonely = asyncio.create_task(_watch_lonely())

    try:
        await runner.run(task)
    finally:
        watcher.cancel()
        lonely.cancel()

        # The transcript, for quality review and disputes (CLAUDE.md §9). Consent
        # was stated in the greeting — which is the greeting we just spoke,
        # verbatim, which is why that matters.
        transcript = "\n".join(
            f"{m.get('role')}: {m.get('content')}"
            for m in context.get_messages()
            if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
        )
        await client.call_ended(call, transcript, outcome=None)
        await client.aclose()
        log.info("call %s finished", room)


def warm_and_wait() -> tuple[dict, WarmParts]:
    """Boot everything a call needs BEFORE there is a call.

    On a small box the imports above plus the model constructions cost 30–60
    seconds — billed, without this, to a guest sitting in a silent room (a real
    guest hung up waiting; that is where this function comes from). The
    switchboard spawns this process ahead of time; we build every room-agnostic
    piece of the pipeline, announce READY on stdout, and block until a room
    assignment arrives on stdin. stdout is the protocol channel — all logging
    goes to stderr, so the one READY line is all the switchboard will ever read.
    """
    parts = WarmParts()

    print("READY", flush=True)
    line = sys.stdin.readline()
    if not line:
        # The switchboard closed without work — shutdown, not an error.
        sys.exit(0)
    return json.loads(line), parts


def main() -> None:
    parser = argparse.ArgumentParser(description="Sena — one voice call")
    parser.add_argument("--room")
    parser.add_argument("--hotel-id")
    parser.add_argument("--token", help="LiveKit token for the BOT, not the guest")
    parser.add_argument(
        "--warm",
        action="store_true",
        help="preload models, print READY, then take the room assignment on stdin",
    )
    args = parser.parse_args()

    parts = None
    if args.warm:
        job, parts = warm_and_wait()
        room, hotel_id, token = job["room"], job["hotel_id"], job["token"]
    elif args.room and args.hotel_id and args.token:
        room, hotel_id, token = args.room, args.hotel_id, args.token
    else:
        parser.error("--room, --hotel-id and --token are required unless --warm")

    try:
        asyncio.run(run_bot(room, hotel_id, token, parts))
    except KeyboardInterrupt:
        pass
    except Exception:
        log.exception("bot died")
        sys.exit(1)


if __name__ == "__main__":
    main()
