"""
Sena's voice agent, talking to Sena's brain.

The agent runs a language model that a caller is actively trying to talk into
things. It is the least trusted component in the system, so it gets no database
credentials and no business logic — it gets an HTTP endpoint and a shared secret.
Everything that MATTERS (the double-confirmation gate, the room-hold lock, the
refusal to confirm an unpaid booking) is enforced on the other side of this wire,
in src/router.mjs, where a persuasive guest cannot reach it.

This module is that wire, and nothing else.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger("sena.client")


class SenaClient:
    """The eleven tools, the hotel's prompt variables, and the end-of-call report."""

    def __init__(self, base_url: str, secret: str, timeout: float = 20.0):
        if not base_url:
            raise ValueError("SENA_API_URL is empty — the agent has nothing to call")
        if not secret:
            raise ValueError("SENA_WEBHOOK_SECRET is empty — the tool endpoint will 401 every call")

        self._base = base_url.rstrip("/")
        # The same secret src/router.mjs checks in constant time. Without it, that
        # endpoint is a public API for reserving a hotel's whole inventory.
        self._headers = {"x-sena-secret": secret, "content-type": "application/json"}
        # Generous, because a tool call can be a Paystack round trip and an SMTP
        # send. But NOT unbounded: a guest listening to silence hangs up, and a
        # hung request is worse than a failed one.
        self._http = httpx.AsyncClient(timeout=timeout)

    async def aclose(self) -> None:
        await self._http.aclose()

    # ── The hotel Sena is answering for ──────────────────────────────────────

    async def hotel_context(self, hotel_id: str) -> dict[str, Any]:
        """The {{...}} variables that fill voice-agent/system-prompt.md."""
        r = await self._http.get(
            f"{self._base}/api/sena/hotel",
            params={"hotel_id": hotel_id},
            headers=self._headers,
        )
        r.raise_for_status()
        return r.json()

    # ── Tools ────────────────────────────────────────────────────────────────

    async def call_tool(self, tool: str, args: dict[str, Any], call: dict[str, Any]) -> dict[str, Any]:
        """
        Run one tool. Returns the router's result object, which the model reads.

        `ok: false` is NOT an error here. It is the router refusing — the room
        went, the hold lapsed, the guest was never double-confirmed — and it
        carries a `say` line telling Sena the honest thing to tell the guest. It
        goes straight back to the model as a normal tool result.

        A genuine failure (the router is down, the secret is wrong, the network
        died) is different, and is handled below: we do not raise into the voice
        pipeline, because an exception mid-call is silence, and silence is a
        guest hanging up. We hand the model an instruction to escalate instead.
        """
        try:
            r = await self._http.post(
                f"{self._base}/api/sena/tool",
                json={"type": "tool-call", "tool": tool, "args": args, "call": call},
                headers=self._headers,
            )

            if r.status_code == 401:
                # Misconfiguration, not a guest problem. Loud in the log, calm on
                # the call.
                log.error("tool %s: 401 — SENA_WEBHOOK_SECRET does not match the API", tool)
                return self._escalate("the tool endpoint rejected our secret")

            r.raise_for_status()
            body = r.json()
            result = body.get("result", body)
            log.info("tool %s → %s", tool, "ok" if result.get("ok") else result.get("reason"))
            return result

        except Exception as err:  # noqa: BLE001 — anything at all, the call must survive it
            log.exception("tool %s failed: %s", tool, err)
            return self._escalate(str(err))

    @staticmethod
    def _escalate(detail: str) -> dict[str, Any]:
        """
        What Sena is told when the machinery breaks.

        Never the error itself. The prompt's rule is: do not explain an error to
        a guest, escalate. So the model gets an instruction it can act on, and
        the detail stays in the log where an engineer will read it.
        """
        return {
            "ok": False,
            "reason": "internal_error",
            "_detail": detail,
            "say": "Something went wrong on our side. Apologise, and escalate to a person.",
        }

    # ── The end of the call ──────────────────────────────────────────────────

    async def call_ended(self, call: dict[str, Any], transcript: str, outcome: str | None) -> None:
        """
        The transcript, for quality review and disputes (CLAUDE.md §9).

        Consent to record was stated in the greeting. If the greeting is ever
        edited to drop that sentence, this call becomes unlawful — the two are
        tied together on purpose, in voice-agent/agent-config.json.
        """
        try:
            await self._http.post(
                f"{self._base}/api/sena/tool",
                json={
                    "type": "call-ended",
                    "call": call,
                    "transcript": transcript,
                    "outcome": outcome,
                },
                headers=self._headers,
            )
        except Exception as err:  # noqa: BLE001
            # The call is already over. Losing the transcript is bad; crashing the
            # shutdown path and leaking the room is worse.
            log.exception("could not save transcript: %s", err)
