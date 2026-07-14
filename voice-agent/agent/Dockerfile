# Sena's voice agent — the switchboard, the bot, Whisper and Piper in one image.
#
# It is a fat image (~2GB) and that is the honest cost of a self-hosted voice
# stack: Whisper's weights and Torch are most of it. In exchange there is no
# per-minute voice bill, no TTS bill, and nothing leaves the box except the
# Anthropic call.

FROM python:3.12-slim

# espeak-ng is Piper's phonemiser; ffmpeg is Whisper's audio plumbing.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates espeak-ng ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ── Python (Piper, Whisper, Pipecat, the lot) ───────────────────────────────
# Piper installs as a pip package now — no binary download, no release tag to
# chase per platform. requirements.txt pins it.
WORKDIR /app/agent
COPY agent/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── The voice ───────────────────────────────────────────────────────────────
# Piper has NO South African English voice — only en_GB and en_US exist. South
# African English is non-rhotic like British RP, so en_GB-cori-medium lands far
# closer than any American voice. This is the sharpest regression from ElevenLabs
# (which could do a warm African English), and the one paid line item worth
# considering if the accent matters commercially. Everything else stays free.
#
# There is no Amharic voice here either, and that is not an oversight — Piper has
# none and neither does Coqui (CLAUDE.md §0). Whisper still HEARS Amharic.
ARG PIPER_VOICE=en_GB-cori-medium
RUN mkdir -p /voices && cd /voices \
 && BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/medium" \
 && curl -fsSL -o "${PIPER_VOICE}.onnx"      "${BASE}/${PIPER_VOICE}.onnx" \
 && curl -fsSL -o "${PIPER_VOICE}.onnx.json" "${BASE}/${PIPER_VOICE}.onnx.json"

# Bake Whisper's weights into the image. Downloading 'small' on the first call
# means the first guest waits ninety seconds for a greeting — and blames the
# hotel, not the cold start.
ARG WHISPER_MODEL=small
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"

COPY agent/ /app/agent/
COPY system-prompt.md agent-config.json /app/

# piper is a console script on PATH now, so the binary default in piper_tts.py
# ("piper") just works — no PIPER_BINARY needed.
ENV PIPER_VOICE=/voices/en_GB-cori-medium.onnx \
    WHISPER_MODEL=small \
    PYTHONUNBUFFERED=1

EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
