"""Client for the Node API's internal voice-session endpoints.

Mirrors packages/contracts/src/voice.ts. Node owns every write; this service
only claims a session, reports what was said and reports when it ended.
"""

from datetime import datetime
from typing import Literal, Protocol

import aiohttp
from pydantic import BaseModel, ConfigDict, Field

Transport = Literal["plivo", "webrtc"]
EndReason = Literal["completed", "disconnected", "timeout", "error"]
Role = Literal["customer", "agent"]

_TIMEOUT = aiohttp.ClientTimeout(total=10)


class _Model(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class AgentConfig(_Model):
    voice_provider: Literal["gemini", "sarvam"] = Field(alias="voiceProvider")
    model: str
    stt_model: str | None = Field(default=None, alias="sttModel")
    tts_model: str | None = Field(default=None, alias="ttsModel")
    language: Literal["Hindi", "English", "Hindi and English"]
    store_name: str = Field(alias="storeName")


class Customer(_Model):
    name: str


class OrderItem(_Model):
    name: str
    quantity: int


class OrderTotal(_Model):
    amount_minor: int = Field(alias="amountMinor")
    currency: Literal["INR"]


class Order(_Model):
    id: str
    items: list[OrderItem]
    total: OrderTotal
    payment_method: Literal["cash_on_delivery", "prepaid"] = Field(alias="paymentMethod")
    delivery_address: str = Field(alias="deliveryAddress")


class SessionContext(_Model):
    attempt_id: str = Field(alias="attemptId")
    transport: Transport
    is_practice: bool = Field(alias="isPractice")
    max_call_seconds: int = Field(alias="maxCallSeconds")
    agent: AgentConfig
    customer: Customer
    order: Order


class TranscriptEntry(_Model):
    role: Role
    text: str
    spoken_at: datetime


class NodeApiError(Exception):
    def __init__(self, status: int, detail: str = ""):
        super().__init__(f"Node API rejected the request (HTTP {status})")
        self.status = status
        # Node's validation message; safe to show the model so it can correct itself.
        self.detail = detail


class SessionApi(Protocol):
    """What a conversation needs from the API; NodeClient implements it."""

    async def claim(
        self,
        attempt_id: str,
        session_token: str,
        transport: Transport,
        provider_leg_id: str | None = None,
    ) -> "SessionContext": ...

    async def append_transcript(
        self, attempt_id: str, session_token: str, entries: list["TranscriptEntry"]
    ) -> None: ...

    async def record_outcome(
        self,
        attempt_id: str,
        session_token: str,
        outcome: str,
        summary: str,
        callback_at: str | None,
    ) -> None: ...

    async def end(self, attempt_id: str, session_token: str, reason: EndReason) -> None: ...


class NodeClient:
    def __init__(self, base_url: str, token: str, session: aiohttp.ClientSession):
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}
        self._session = session

    async def _post(self, path: str, body: dict) -> dict | None:
        async with self._session.post(
            f"{self._base_url}/internal/v1/voice-sessions{path}",
            json=body,
            headers=self._headers,
            timeout=_TIMEOUT,
            allow_redirects=False,
        ) as response:
            if response.status >= 400:
                try:
                    detail = (await response.json(content_type=None) or {}).get("error", "")
                except ValueError:
                    detail = ""
                raise NodeApiError(response.status, str(detail))
            return await response.json() if response.status != 204 else None

    async def claim(
        self,
        attempt_id: str,
        session_token: str,
        transport: Transport,
        provider_leg_id: str | None = None,
    ) -> SessionContext:
        body = {"attemptId": attempt_id, "sessionToken": session_token, "transport": transport}
        if provider_leg_id:
            body["providerLegId"] = provider_leg_id
        return SessionContext.model_validate(await self._post("/claim", body))

    async def append_transcript(
        self, attempt_id: str, session_token: str, entries: list[TranscriptEntry]
    ) -> None:
        await self._post(
            f"/{attempt_id}/transcript",
            {
                "sessionToken": session_token,
                "entries": [
                    {"role": e.role, "text": e.text, "spokenAt": e.spoken_at.isoformat()}
                    for e in entries
                ],
            },
        )

    async def record_outcome(
        self,
        attempt_id: str,
        session_token: str,
        outcome: str,
        summary: str,
        callback_at: str | None,
    ) -> None:
        body: dict = {"sessionToken": session_token, "outcome": outcome, "summary": summary}
        if callback_at:
            body["callbackAt"] = callback_at
        await self._post(f"/{attempt_id}/outcome", body)

    async def end(self, attempt_id: str, session_token: str, reason: EndReason) -> None:
        await self._post(f"/{attempt_id}/end", {"sessionToken": session_token, "reason": reason})
