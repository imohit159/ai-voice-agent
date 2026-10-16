"""Plivo audio-stream admission: upgrade signature and the stream's start message."""

import asyncio
import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlsplit

from fastapi import WebSocket

START_TIMEOUT_SECONDS = 10
_MAX_MESSAGES_BEFORE_START = 5


def verify_v3_get_signature(
    auth_token: str, url: str, nonce: str | None, signature: str | None
) -> bool:
    """Plivo V3 signature for a GET (the WebSocket upgrade), per plivo-python's signature_v3."""
    if not nonce or not signature or len(signature) > 2048:
        return False
    parts = urlsplit(url)
    canonical = f"{parts.scheme}://{parts.netloc}{parts.path}"
    query = sorted(parse_qsl(parts.query, keep_blank_values=True))
    if query:
        canonical += "?" + "&".join(f"{key}={value}" for key, value in query)
    expected = base64.b64encode(
        hmac.new(auth_token.encode(), f"{canonical}.{nonce}".encode(), hashlib.sha256).digest()
    ).decode()
    candidates = (candidate.strip() for candidate in signature.split(","))
    return any(hmac.compare_digest(expected, candidate) for candidate in candidates)


def parse_extra_headers(raw: object) -> dict[str, str]:
    """Plivo delivers <Stream extraHeaders> as "k1=v1;k2=v2" (or, defensively, a JSON object)."""
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}
    if not isinstance(raw, str):
        return {}
    headers: dict[str, str] = {}
    for pair in raw.split(";"):
        key, _, value = pair.partition("=")
        if key.strip() and value:
            # Plivo may prefix custom headers on SIP legs; accept either form.
            name = key.strip().removeprefix("X-PH-").removeprefix("x-ph-")
            headers[name] = value.strip()
    return headers


@dataclass(frozen=True)
class PlivoStart:
    stream_id: str
    call_id: str
    attempt_id: str
    session_token: str


class InvalidStreamStart(Exception):
    pass


async def read_start(websocket: WebSocket) -> PlivoStart:
    """Reads Plivo's start event, which carries the call identity and our extra headers."""

    async def first_start() -> dict:
        for _ in range(_MAX_MESSAGES_BEFORE_START):
            message = json.loads(await websocket.receive_text())
            if message.get("event") == "start":
                return message
        raise InvalidStreamStart("No start event received.")

    try:
        message = await asyncio.wait_for(first_start(), START_TIMEOUT_SECONDS)
    except (TimeoutError, ValueError) as error:
        raise InvalidStreamStart("No valid start event received.") from error
    start = message.get("start") or {}
    extra = parse_extra_headers(
        message.get("extra_headers")
        or message.get("extraHeaders")
        or start.get("extraHeaders")
        or start.get("extra_headers")
    )
    stream_id, call_id = start.get("streamId"), start.get("callId")
    attempt_id, token = extra.get("attemptId"), extra.get("sessionToken")
    if not (stream_id and call_id and attempt_id and token):
        raise InvalidStreamStart("Start event is missing call identity.")
    return PlivoStart(stream_id, call_id, attempt_id, token)
