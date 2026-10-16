"""HTTP and WebSocket entry points of the voice agent.

Public: /plivo/stream (Plivo's signed audio stream) and /health.
Private, behind the shared service token: /internal/status and /practice/offer,
which only the Node API calls.
"""

import asyncio
import hmac
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal, Protocol

import aiohttp
from fastapi import FastAPI, Header, HTTPException, WebSocket
from loguru import logger
from pipecat.serializers.plivo import PlivoFrameSerializer
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pydantic import BaseModel, Field

from voice_agent.bot import ProviderNotConfigured, run_conversation
from voice_agent.config import Settings
from voice_agent.node_client import (
    EndReason,
    NodeApiError,
    NodeClient,
    SessionContext,
    TranscriptEntry,
    Transport,
)
from voice_agent.plivo import InvalidStreamStart, read_start, verify_v3_get_signature
from voice_agent.transcript import TranscriptRecorder

# WebSocket close codes: policy violation, and server unable to serve.
_POLICY_VIOLATION = 1008
_UNAVAILABLE = 1011


class SessionApi(Protocol):
    async def claim(
        self,
        attempt_id: str,
        session_token: str,
        transport: Transport,
        provider_leg_id: str | None = None,
    ) -> SessionContext: ...

    async def append_transcript(
        self, attempt_id: str, session_token: str, entries: list[TranscriptEntry]
    ) -> None: ...

    async def end(self, attempt_id: str, session_token: str, reason: EndReason) -> None: ...


class PracticeOffer(BaseModel):
    attempt_id: str = Field(alias="attemptId", max_length=64)
    session_token: str = Field(alias="sessionToken", max_length=2048)
    sdp: str = Field(max_length=100_000)
    type: Literal["offer"]


def create_app(settings: Settings, node: SessionApi | None = None) -> FastAPI:
    webrtc = SmallWebRTCRequestHandler()
    sessions: set[asyncio.Task] = set()
    api: dict[str, SessionApi] = {}

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        http = aiohttp.ClientSession()
        api["node"] = node or NodeClient(
            settings.api_internal_url, settings.internal_token.get_secret_value(), http
        )
        try:
            yield
        finally:
            for task in sessions:
                task.cancel()
            await asyncio.gather(*sessions, return_exceptions=True)
            await webrtc.close()
            await http.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def require_service_token(authorization: str | None) -> None:
        expected = f"Bearer {settings.internal_token.get_secret_value()}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="Service authentication required.")

    async def run_session(transport: BaseTransport, session: SessionContext, token: str) -> None:
        recorder = TranscriptRecorder(api["node"], session.attempt_id, token)
        reason: EndReason = "error"
        try:
            reason = await run_conversation(transport, session, settings, recorder)
        except ProviderNotConfigured as missing:
            logger.error(f"Cannot serve attempt {session.attempt_id}: {missing} is not set")
        finally:
            try:
                await api["node"].end(session.attempt_id, token, reason)
            except Exception as error:  # noqa: BLE001 - Node expires sessions it never hears end
                logger.warning(f"Session end not reported: {type(error).__name__}")
            logger.info(f"Voice session {session.attempt_id} ended: {reason}")

    def track(coroutine) -> None:
        task = asyncio.create_task(coroutine)
        sessions.add(task)
        task.add_done_callback(sessions.discard)

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok"}

    @app.get("/internal/status")
    async def status(authorization: str | None = Header(default=None)) -> dict:
        require_service_token(authorization)
        return {
            "providers": {
                "gemini": settings.gemini_api_key is not None,
                "sarvam": settings.sarvam_api_key is not None,
            }
        }

    @app.post("/practice/offer")
    async def practice_offer(
        offer: PracticeOffer, authorization: str | None = Header(default=None)
    ) -> dict:
        require_service_token(authorization)
        try:
            session = await api["node"].claim(offer.attempt_id, offer.session_token, "webrtc")
        except NodeApiError as error:
            raise HTTPException(status_code=409, detail="Practice session unavailable.") from error

        async def on_connection(connection: SmallWebRTCConnection) -> None:
            transport = SmallWebRTCTransport(
                connection, TransportParams(audio_in_enabled=True, audio_out_enabled=True)
            )
            track(run_session(transport, session, offer.session_token))

        try:
            answer = await webrtc.handle_web_request(
                SmallWebRTCRequest(sdp=offer.sdp, type="offer"), on_connection
            )
        except Exception as error:
            await api["node"].end(offer.attempt_id, offer.session_token, "error")
            raise HTTPException(status_code=400, detail="Invalid WebRTC offer.") from error
        if answer is None:
            raise HTTPException(status_code=502, detail="No WebRTC answer was produced.")
        return {"sdp": answer["sdp"], "type": "answer"}

    @app.websocket("/plivo/stream")
    async def plivo_stream(websocket: WebSocket) -> None:
        if not settings.plivo_enabled:
            await websocket.close(code=_UNAVAILABLE)
            return
        token = settings.plivo_auth_token.get_secret_value()  # type: ignore[union-attr]
        if not verify_v3_get_signature(
            token,
            settings.stream_url,  # type: ignore[arg-type]
            websocket.headers.get("x-plivo-signature-v3-nonce"),
            websocket.headers.get("x-plivo-signature-v3"),
        ):
            logger.warning("Rejected Plivo stream with an invalid signature")
            await websocket.close(code=_POLICY_VIOLATION)
            return
        await websocket.accept()
        try:
            start = await read_start(websocket)
            session = await api["node"].claim(
                start.attempt_id, start.session_token, "plivo", start.call_id
            )
        except (InvalidStreamStart, NodeApiError) as error:
            logger.warning(f"Rejected Plivo stream: {type(error).__name__}")
            await websocket.close(code=_POLICY_VIOLATION)
            return
        transport = FastAPIWebsocketTransport(
            websocket,
            FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                add_wav_header=False,
                # Plivo sends no Origin header; the signature above authenticates it.
                allowed_origins=[],
                serializer=PlivoFrameSerializer(
                    stream_id=start.stream_id,
                    call_id=start.call_id,
                    auth_id=settings.plivo_auth_id,
                    auth_token=token,
                ),
            ),
        )
        await run_session(transport, session, start.session_token)

    return app
