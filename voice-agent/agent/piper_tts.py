"""
Piper — Sena's voice. This is what replaced ElevenLabs.

WHY PIPER, AND NOT COQUI: Coqui the company shut down and its repo is archived,
and XTTS needs a GPU to synthesise faster than realtime. Piper is a single
binary, ~50MB per voice, and runs comfortably faster than realtime on a cheap
CPU. On a phone call, "runs on the box you already pay for" beats "sounds
slightly better" every time.

WHY THIS IS FASTER THAN ELEVENLABS WAS: there is no network hop. ElevenLabs cost
us ~250ms of round trip before the first sample; Piper costs a subprocess and a
few tens of milliseconds. That matters, because the rest of the free stack is
SLOWER — local Whisper is no Deepgram — and this is where we buy some of it back.

WHY WE DRIVE THE BINARY OURSELVES rather than use a Piper HTTP server: one fewer
moving part in docker-compose, and no second network hop inside our own box. The
cost is this file. It is a fair trade.

STREAMING: --output_raw makes Piper write headerless PCM straight to stdout, and
we hand it to the pipeline in chunks as it arrives. So Sena starts speaking while
the tail of the sentence is still being synthesised. Waiting for the whole
utterance would add its full synthesis time to the pause before she opens her
mouth, and the pause is the thing guests judge.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import AsyncGenerator

from pipecat.frames.frames import (
    ErrorFrame,
    Frame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)

# Pipecat moved TTSService between releases. Try the current home, fall back to
# the old one, and fail with something a human can act on rather than an
# ImportError six frames deep.
try:
    from pipecat.services.tts_service import TTSService
except ImportError:  # pragma: no cover - depends on installed pipecat version
    try:
        from pipecat.services.ai_services import TTSService  # type: ignore
    except ImportError as err:  # pragma: no cover
        raise ImportError(
            "Cannot find pipecat's TTSService. Your pipecat-ai version is not one "
            "this file knows about — see voice-agent/agent/requirements.txt for the "
            "pinned range."
        ) from err

log = logging.getLogger("sena.piper")

# ~20ms of 16-bit mono at 22.05kHz. Small enough that Sena starts speaking almost
# immediately; large enough that we are not thrashing the event loop per sample.
CHUNK_BYTES = 1024


class PiperTTSService(TTSService):
    """Local Piper. No API key, no network, no per-character bill."""

    def __init__(
        self,
        *,
        voice_model: str,
        piper_binary: str = "piper",
        sample_rate: int = 22050,
        **kwargs,
    ):
        super().__init__(sample_rate=sample_rate, **kwargs)

        self._binary = shutil.which(piper_binary) or piper_binary
        self._model = Path(voice_model)
        self._sample_rate = sample_rate

        # Fail HERE, at startup, not on the first thing Sena tries to say to a
        # real guest. A missing voice file is a five-second fix at boot and a
        # dead call at runtime.
        if not shutil.which(piper_binary) and not Path(piper_binary).exists():
            raise FileNotFoundError(
                f"piper binary not found: {piper_binary!r}. "
                "Install it (see docs/voice-stack.md) or set PIPER_BINARY."
            )
        if not self._model.exists():
            raise FileNotFoundError(
                f"piper voice not found: {self._model}. "
                "Download a .onnx voice and set PIPER_VOICE to its path."
            )

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text: str) -> AsyncGenerator[Frame, None]:
        """One utterance in, a stream of PCM frames out."""
        text = (text or "").strip()
        if not text:
            return

        log.debug("piper: %s", text[:80])
        await self.start_ttfb_metrics()

        proc = await asyncio.create_subprocess_exec(
            self._binary,
            "--model",
            str(self._model),
            "--output_raw",  # raw PCM on stdout: no WAV header, no temp file
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            yield TTSStartedFrame()

            # Piper reads one line of text and synthesises it. Closing stdin is
            # what tells it there is no more.
            proc.stdin.write(text.encode("utf-8") + b"\n")
            await proc.stdin.drain()
            proc.stdin.close()

            first = True
            while True:
                chunk = await proc.stdout.read(CHUNK_BYTES)
                if not chunk:
                    break
                if first:
                    # Time to first byte: the number that decides whether the
                    # guest thinks the line went dead.
                    await self.stop_ttfb_metrics()
                    first = False
                yield TTSAudioRawFrame(
                    audio=chunk,
                    sample_rate=self._sample_rate,
                    num_channels=1,
                )

            await proc.wait()
            if proc.returncode != 0:
                stderr = (await proc.stderr.read()).decode("utf-8", "replace")
                log.error("piper exited %s: %s", proc.returncode, stderr.strip())
                yield ErrorFrame(f"piper failed: {stderr.strip()[:200]}")

        finally:
            if proc.returncode is None:
                proc.kill()
            await self.stop_ttfb_metrics()
            yield TTSStoppedFrame()
