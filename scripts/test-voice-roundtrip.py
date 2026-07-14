"""
Sena speaks, and Sena hears — proven, with real audio.

Every other test checks that the voice code IMPORTS. This one checks that it
WORKS: it drives Piper exactly as piper_tts.py does, writes real audio, and feeds
that audio to faster-whisper exactly as bot.py does. If the loop closes — if
Whisper hears back most of what Piper said — the voice half of Sena functions.

It is the closest thing to a phone call that a CI machine, with no microphone,
can run.

WHY IT IS NOT IN `npm test`. It needs the Piper voice file on disk (~60MB) and it
runs Whisper over real audio, which is seconds, not milliseconds. So it is opt-in:

    npm run test:voice

The import test (test-agent-imports.py) runs every time and catches API drift.
This runs when you have changed something about the audio itself and want to hear
that it still lands.

WHAT "PASS" MEANS. 70% word overlap on the 'base' model. Not 100%: 'base' is the
fast, rough model and it mishears a word or two ('checking in' → 'checking and').
That is expected and it is why production runs 'small'. We are proving the
pipeline carries speech, not benchmarking the model.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def find_voice() -> Path | None:
    """Wherever the developer or the container put the voice."""
    env = os.environ.get("PIPER_VOICE")
    if env and Path(env).exists():
        return Path(env)
    for p in [
        ROOT / ".venv/voices/en_GB-cori-medium.onnx",
        Path("/voices/en_GB-cori-medium.onnx"),
    ]:
        if p.exists():
            return p
    return None


def find_piper() -> str | None:
    import shutil

    for c in [
        str(ROOT / ".venv/Scripts/piper.exe"),
        str(ROOT / ".venv/bin/piper"),
        "piper",
    ]:
        if os.path.exists(c) or shutil.which(c):
            return c
    return None


def main() -> int:
    voice = find_voice()
    piper = find_piper()

    if not voice or not piper:
        print("\n  SKIP  voice round-trip — Piper or its voice is not installed")
        print("        the voice ships in the docker image; to test on the host:")
        print("        .venv/Scripts/pip install piper-tts faster-whisper")
        print("        and download en_GB-cori-medium into .venv/voices/\n")
        return 0

    print("\nSena speaks, and Sena hears\n")

    sentence = "I would like to book a room for two nights, checking in on Friday."
    wav = Path(tempfile.gettempdir()) / "sena-roundtrip.wav"

    # 1. PIPER SPEAKS — same binary, same flags as piper_tts.py.
    subprocess.run(
        [piper, "--model", str(voice), "-f", str(wav)],
        input=sentence.encode("utf-8"),
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    w = wave.open(str(wav))
    dur = w.getnframes() / w.getframerate()
    rate = w.getframerate()
    w.close()
    print(f"  Piper spoke  : \"{sentence}\"")
    print(f"                 {dur:.2f}s of {rate}Hz audio, {wav.stat().st_size} bytes")

    # The rate piper_tts.py hands to the pipeline. If Piper ever changes it, the
    # audio plays back chipmunked or slow, and this is where we find out.
    if rate != 22050:
        print(f"  FAIL  Piper is {rate}Hz but piper_tts.py assumes 22050Hz")
        return 1

    # 2. WHISPER LISTENS — same model class as bot.py.
    from faster_whisper import WhisperModel

    model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(wav), language="en")
    heard = " ".join(s.text for s in segments).strip()
    print(f"  Whisper heard: \"{heard}\"")

    # 3. DID THE LOOP CLOSE?
    words = lambda s: set(re.sub(r"[^a-z ]", "", s.lower()).split())
    spoken = words(sentence)
    overlap = len(spoken & words(heard)) / len(spoken)
    print(f"  word overlap : {overlap:.0%}")

    wav.unlink(missing_ok=True)

    if overlap >= 0.70:
        print(f"\n  the voice stack carries speech, end to end\n")
        return 0
    print(f"\n  FAIL  only {overlap:.0%} of the sentence survived the round trip\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
