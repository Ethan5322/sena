# Sena's voice agent — the switchboard, the bot, Whisper and Piper in one image.
#
# It is a fat image (~2GB) and that is the honest cost of a self-hosted voice
# stack: Whisper's weights and Torch are most of it. In exchange there is no
# per-minute voice bill, no TTS bill, and nothing leaves the box except the
# Anthropic call.

FROM python:3.12-slim

# piper needs espeak-ng for phonemisation; ffmpeg is Whisper's audio plumbing.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates espeak-ng ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ── Piper ───────────────────────────────────────────────────────────────────
# The binary, and one voice. en_ZA-tom-medium is a South African English voice —
# a guest in Pretoria should not feel they have been routed to a call centre
# abroad, and the accent is most of that feeling.
#
# NOTE: there is no Amharic voice here, and that is not an oversight. Piper has
# none, and neither does Coqui. CLAUDE.md §0 lists Amharic as a requirement and
# the free stack cannot meet it — the decision to ship English-first is recorded
# there. If an Amharic voice appears, it drops in as one more .onnx file.
ARG PIPER_VERSION=2023.11.14-2
RUN curl -fsSL -o /tmp/piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
 && tar -xzf /tmp/piper.tar.gz -C /opt \
 && ln -s /opt/piper/piper /usr/local/bin/piper \
 && rm /tmp/piper.tar.gz

ARG PIPER_VOICE=en_ZA-tom-medium
RUN mkdir -p /voices && cd /voices \
 && BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_ZA/tom/medium" \
 && curl -fsSL -o "${PIPER_VOICE}.onnx"      "${BASE}/${PIPER_VOICE}.onnx" \
 && curl -fsSL -o "${PIPER_VOICE}.onnx.json" "${BASE}/${PIPER_VOICE}.onnx.json"

# ── Python ──────────────────────────────────────────────────────────────────
WORKDIR /app/agent
COPY agent/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake Whisper's weights into the image. Downloading 'small' on the first call
# means the first guest waits ninety seconds for a greeting — and blames the
# hotel, not the cold start.
ARG WHISPER_MODEL=small
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"

COPY agent/ /app/agent/
COPY system-prompt.md agent-config.json /app/

ENV PIPER_BINARY=/usr/local/bin/piper \
    PIPER_VOICE=/voices/en_ZA-tom-medium.onnx \
    WHISPER_MODEL=small \
    PYTHONUNBUFFERED=1

EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
