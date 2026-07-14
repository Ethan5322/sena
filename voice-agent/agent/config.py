"""
Everything Sena needs to know before she opens her mouth.

Two sources, and the split is deliberate:

  agent-config.json   what is true about Sena wherever she runs — the greeting,
                      the model, the eleven tools. Reviewed like prose, diffed
                      like prose, and identical in dev and production.

  the environment     what is true about THIS box — where LiveKit is, which Piper
                      voice is on disk, which secret opens the tool endpoint.

If you find yourself putting a hostname in the JSON or a tool description in the
environment, you have them the wrong way round.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

VOICE_AGENT_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = VOICE_AGENT_DIR / "agent-config.json"
PROMPT_PATH = VOICE_AGENT_DIR / "system-prompt.md"


def _require(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise RuntimeError(
            f"{name} is not set. The agent will not start without it — "
            f"copy .env.example to .env.local and fill it in."
        )
    return v


@dataclass(frozen=True)
class Settings:
    # Where the brain lives: the Node API with the router, the gates and the DB.
    sena_api_url: str
    sena_secret: str

    # Where the audio lives.
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str

    # The three pieces of the pipeline.
    anthropic_api_key: str
    whisper_model: str
    piper_binary: str
    piper_voice: str

    # Which hotel this agent answers for when a room does not say. In production,
    # leave it empty: the room name carries the hotel, and a fallback that quietly
    # answers as the wrong hotel is worse than a call that fails loudly.
    default_hotel_id: str

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            sena_api_url=_require("SENA_API_URL"),
            sena_secret=_require("SENA_WEBHOOK_SECRET"),
            livekit_url=_require("LIVEKIT_URL"),
            livekit_api_key=_require("LIVEKIT_API_KEY"),
            livekit_api_secret=_require("LIVEKIT_API_SECRET"),
            anthropic_api_key=_require("ANTHROPIC_API_KEY"),
            whisper_model=os.environ.get("WHISPER_MODEL", "").strip(),
            piper_binary=os.environ.get("PIPER_BINARY", "piper").strip(),
            piper_voice=_require("PIPER_VOICE"),
            default_hotel_id=os.environ.get("SENA_DEFAULT_HOTEL_ID", "").strip(),
        )


class AgentConfig:
    """agent-config.json, with the bits the code actually reaches for named."""

    def __init__(self, raw: dict):
        self._raw = raw

    @classmethod
    def load(cls) -> "AgentConfig":
        return cls(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))

    @property
    def first_message(self) -> str:
        return self._raw["firstMessage"]

    @property
    def model(self) -> str:
        return self._raw["model"]["model"]

    @property
    def temperature(self) -> float:
        return float(self._raw["model"]["temperature"])

    @property
    def max_tokens(self) -> int:
        return int(self._raw["model"]["max_tokens"])

    @property
    def tools(self) -> list[dict]:
        """Anthropic tool shape, passed to the Messages API untouched."""
        return self._raw["tools"]

    @property
    def tool_names(self) -> list[str]:
        return [t["name"] for t in self._raw["tools"]]

    @property
    def stt_model(self) -> str:
        return self._raw["stt"]["model"]

    @property
    def stt_language(self) -> str:
        return self._raw["stt"]["language"]

    @property
    def max_duration_seconds(self) -> int:
        return int(self._raw["max_duration_seconds"])

    @property
    def silence_timeout_seconds(self) -> int:
        return int(self._raw["silence_timeout_seconds"])


def render_system_prompt(prompt_vars: dict[str, str]) -> str:
    """
    Fill the {{...}} holes in system-prompt.md from the hotel's own row.

    A missed placeholder is not cosmetic. Sena reads what is in front of her, so
    an unfilled {{cancellation_policy}} is Sena saying the literal characters
    "{{cancellation_policy}}" to a guest asking for a refund. We would rather the
    agent refuse to start.
    """
    prompt = PROMPT_PATH.read_text(encoding="utf-8")

    for key, value in prompt_vars.items():
        prompt = prompt.replace("{{" + key + "}}", str(value))

    leftover = {m for m in _placeholders(prompt)}
    if leftover:
        raise RuntimeError(
            f"system-prompt.md still has unfilled placeholders: {sorted(leftover)}. "
            f"Add them to prompt_vars in api/sena/hotel.mjs."
        )

    return prompt


def _placeholders(text: str) -> set[str]:
    import re

    return set(re.findall(r"\{\{([a-z_]+)\}\}", text))
