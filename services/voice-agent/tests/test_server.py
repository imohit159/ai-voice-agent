import base64
import hashlib
import hmac

import pytest
from conftest import INTERNAL_TOKEN, PLIVO_TOKEN, STREAM_URL, session_context
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from voice_agent.node_client import NodeApiError
from voice_agent.server import create_app


class FakeNode:
    def __init__(self, reject: bool = False):
        self.reject = reject
        self.claims: list[tuple] = []
        self.ended: list[tuple] = []

    async def claim(self, attempt_id, session_token, transport, provider_leg_id=None):
        self.claims.append((attempt_id, session_token, transport, provider_leg_id))
        if self.reject:
            raise NodeApiError(409)
        return session_context(transport=transport)

    async def append_transcript(self, attempt_id, session_token, entries):
        pass

    async def end(self, attempt_id, session_token, reason):
        self.ended.append((attempt_id, reason))


def plivo_headers(url=STREAM_URL, token=PLIVO_TOKEN, nonce="n-1"):
    digest = hmac.new(token.encode(), f"{url}.{nonce}".encode(), hashlib.sha256).digest()
    return {
        "x-plivo-signature-v3": base64.b64encode(digest).decode(),
        "x-plivo-signature-v3-nonce": nonce,
    }


def client(settings, node):
    return TestClient(create_app(settings, node))


def test_internal_status_requires_the_service_token(settings):
    with client(settings, FakeNode()) as http:
        assert http.get("/internal/status").status_code == 401
        assert (
            http.get("/internal/status", headers={"Authorization": "Bearer wrong"}).status_code
            == 401
        )
        response = http.get(
            "/internal/status", headers={"Authorization": f"Bearer {INTERNAL_TOKEN}"}
        )
        assert response.json() == {"providers": {"gemini": True, "sarvam": False}}
        assert http.get("/health").json() == {"status": "ok"}


def test_practice_offer_requires_the_service_token_and_a_claimable_session(settings):
    offer = {"attemptId": "a-1", "sessionToken": "tok", "sdp": "v=0", "type": "offer"}
    node = FakeNode(reject=True)
    with client(settings, node) as http:
        assert http.post("/practice/offer", json=offer).status_code == 401
        response = http.post(
            "/practice/offer", json=offer, headers={"Authorization": f"Bearer {INTERNAL_TOKEN}"}
        )
        assert response.status_code == 409
        assert node.claims == [("a-1", "tok", "webrtc", None)]


def test_plivo_stream_with_a_bad_signature_is_closed_before_accepting(settings):
    node = FakeNode()
    with client(settings, node) as http:
        with pytest.raises(WebSocketDisconnect) as closed:
            with http.websocket_connect(
                "/plivo/stream", headers=plivo_headers(token="wrong")
            ) as ws:
                ws.receive_text()
        assert closed.value.code == 1008
        assert node.claims == []


def test_plivo_stream_claims_with_the_call_leg_and_closes_when_refused(settings):
    node = FakeNode(reject=True)
    start = {
        "event": "start",
        "start": {"streamId": "s-1", "callId": "leg-1"},
        "extra_headers": "attemptId=a-1;sessionToken=tok",
    }
    with client(settings, node) as http:
        with http.websocket_connect("/plivo/stream", headers=plivo_headers()) as ws:
            ws.send_json(start)
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_text()
        assert closed.value.code == 1008
        assert node.claims == [("a-1", "tok", "plivo", "leg-1")]


def test_plivo_stream_is_unavailable_without_plivo_configuration(settings):
    settings.plivo_auth_token = None
    with client(settings, FakeNode()) as http:
        with pytest.raises(WebSocketDisconnect) as closed:
            with http.websocket_connect("/plivo/stream", headers=plivo_headers()) as ws:
                ws.receive_text()
        assert closed.value.code == 1011
