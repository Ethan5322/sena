"""
Does the voice agent still fit the framework it is built on?

WHY THIS EXISTS. bot.py was first written against Pipecat 0.0.x. By the time it
was first run, Pipecat was on 1.5, and four things had moved underneath it:

    OpenAILLMContext                     → LLMContext (different module)
    llm.create_context_aggregator(ctx)   → LLMContextAggregatorPair(ctx)
    pipecat.transports.services.livekit  → pipecat.transports.livekit.transport
    WhisperSTTService(language="en")     → language=Language.EN

The last one is the frightening one. A string where an enum is expected was taken
without complaint and quietly ignored — so the agent would have started, greeted
the guest, and transcribed them with the wrong language setting. Nothing would
have looked broken.

`npm test` cannot catch any of this: it is Node, and this is Python. So this runs
in the same suite, and it is the two-second check that stands between a Pipecat
bump and a receptionist that cannot hear.

It imports and constructs. It does not make a call — that needs a microphone.

Run:  npm run test:agent
"""

from __future__ import annotations

import sys
from pathlib import Path

AGENT = Path(__file__).resolve().parent.parent / "voice-agent" / "agent"
sys.path.insert(0, str(AGENT))

failures: list[str] = []


def check(name: str, fn):
    try:
        fn()
        print(f"  ok    {name}")
    except Exception as err:  # noqa: BLE001
        print(f"  FAIL  {name}\n        {type(err).__name__}: {err}")
        failures.append(name)


print("\nthe agent still fits the framework\n")

# ── Every symbol bot.py reaches for ─────────────────────────────────────────
def _pipeline_symbols():
    from pipecat.adapters.schemas.function_schema import FunctionSchema  # noqa: F401
    from pipecat.adapters.schemas.tools_schema import ToolsSchema  # noqa: F401
    from pipecat.audio.vad.silero import SileroVADAnalyzer  # noqa: F401
    from pipecat.frames.frames import EndFrame, TTSSpeakFrame  # noqa: F401
    from pipecat.pipeline.pipeline import Pipeline  # noqa: F401
    from pipecat.pipeline.runner import PipelineRunner  # noqa: F401
    from pipecat.pipeline.task import PipelineParams, PipelineTask  # noqa: F401
    from pipecat.processors.aggregators.llm_context import LLMContext  # noqa: F401
    from pipecat.processors.aggregators.llm_response_universal import (  # noqa: F401
        LLMContextAggregatorPair,
    )
    from pipecat.services.anthropic.llm import AnthropicLLMService  # noqa: F401
    from pipecat.services.whisper.stt import WhisperSTTService  # noqa: F401
    from pipecat.transcriptions.language import Language  # noqa: F401
    from pipecat.transports.livekit.transport import (  # noqa: F401
        LiveKitParams,
        LiveKitTransport,
    )


check("every pipecat symbol bot.py imports still exists", _pipeline_symbols)


# ── The subtle one: the enum, not the string ───────────────────────────────
def _language_is_an_enum():
    from pipecat.transcriptions.language import Language

    lang = Language("en")
    assert lang is Language.EN, f"Language('en') gave {lang!r}"


check("Whisper's language is an enum, and 'en' still resolves to it", _language_is_an_enum)


# ── The tools, as the model will actually receive them ─────────────────────
def _tools_build():
    import json

    from pipecat.adapters.schemas.function_schema import FunctionSchema
    from pipecat.adapters.schemas.tools_schema import ToolsSchema

    cfg = json.loads((AGENT.parent / "agent-config.json").read_text(encoding="utf-8"))
    schema = ToolsSchema(
        standard_tools=[
            FunctionSchema(
                name=t["name"],
                description=t["description"],
                properties=t["input_schema"].get("properties", {}),
                required=t["input_schema"].get("required", []),
            )
            for t in cfg["tools"]
        ]
    )
    assert len(schema.standard_tools) == 11, f"expected 11 tools, built {len(schema.standard_tools)}"


check("all eleven tools build into a ToolsSchema the LLM accepts", _tools_build)


# ── The context, exactly as bot.py constructs it ───────────────────────────
def _context_builds():
    import json

    from pipecat.adapters.schemas.function_schema import FunctionSchema
    from pipecat.adapters.schemas.tools_schema import ToolsSchema
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair

    cfg = json.loads((AGENT.parent / "agent-config.json").read_text(encoding="utf-8"))
    tools = ToolsSchema(
        standard_tools=[
            FunctionSchema(
                name=t["name"],
                description=t["description"],
                properties=t["input_schema"].get("properties", {}),
                required=t["input_schema"].get("required", []),
            )
            for t in cfg["tools"]
        ]
    )
    ctx = LLMContext(
        messages=[
            {"role": "system", "content": "you are Sena"},
            {"role": "assistant", "content": cfg["firstMessage"]},
        ],
        tools=tools,
    )
    pair = LLMContextAggregatorPair(ctx)
    assert pair.user() is not None
    assert pair.assistant() is not None


check("the context and its aggregator pair construct", _context_builds)


# ── Our own modules ────────────────────────────────────────────────────────
def _our_modules():
    import bot  # noqa: F401
    import config  # noqa: F401
    import piper_tts  # noqa: F401
    import sena_client  # noqa: F401
    import server  # noqa: F401

    assert hasattr(piper_tts, "PiperTTSService")
    assert hasattr(sena_client, "SenaClient")
    assert callable(bot.run_bot)
    assert server.app is not None


check("bot, server, piper_tts, sena_client and config all import", _our_modules)


def _prompt_renders():
    """Every {{...}} in system-prompt.md must be fillable, or Sena reads braces aloud."""
    import config

    rendered = config.render_system_prompt(
        {
            "hotel_name": "Jacaranda Court Hotel",
            "currency": "ZAR",
            "check_in_time": "14:00",
            "check_out_time": "10:00",
            "hold_minutes": "20",
            "cancellation_policy": "Free until 48 hours before arrival.",
            "early_late_policy": "Subject to availability.",
            "today": "2026-07-14",
        }
    )
    assert "{{" not in rendered, "a placeholder survived rendering"
    assert "Jacaranda" in rendered


check("the system prompt renders with no placeholder left behind", _prompt_renders)


def _piper_fails_loudly():
    """A missing voice must break at STARTUP, not on the first thing Sena says."""
    from piper_tts import PiperTTSService

    try:
        PiperTTSService(voice_model="/nope/does-not-exist.onnx", piper_binary="/nope/piper")
    except FileNotFoundError:
        return  # correct
    raise AssertionError("a missing piper voice did NOT raise — it would fail mid-call instead")


check("a missing Piper voice fails at startup, not mid-call", _piper_fails_loudly)


print()
if failures:
    print(f"{len(failures)} failed\n")
    sys.exit(1)
print("the agent fits pipecat 1.5.0\n")
