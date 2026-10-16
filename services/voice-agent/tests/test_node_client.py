from datetime import UTC, datetime

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from conftest import INTERNAL_TOKEN, session_context

from voice_agent.node_client import NodeApiError, NodeClient, TranscriptEntry
from voice_agent.transcript import TranscriptRecorder


@pytest.fixture
async def node_api():
    received: list[tuple[str, dict, str]] = []
    context = session_context().model_dump(by_alias=True, mode="json")

    async def handler(request: web.Request) -> web.Response:
        body = await request.json()
        received.append((request.path, body, request.headers.get("Authorization", "")))
        if body.get("sessionToken") == "bad":
            return web.Response(status=403)
        if request.path.endswith("/claim"):
            return web.json_response(context)
        return web.Response(status=204)

    app = web.Application()
    app.router.add_post("/internal/v1/voice-sessions/{tail:.*}", handler)
    server = TestServer(app)
    await server.start_server()
    async with aiohttp.ClientSession() as http:
        yield NodeClient(str(server.make_url("")), INTERNAL_TOKEN, http), received
    await server.close()


async def test_claim_sends_the_contract_and_parses_the_context(node_api):
    node, received = node_api
    context = await node.claim("a-1", "tok", "plivo", "leg-1")
    assert context.customer.name == "Asha"
    assert context.order.total.amount_minor == 149900
    path, body, auth = received[0]
    assert path == "/internal/v1/voice-sessions/claim"
    assert body == {
        "attemptId": "a-1",
        "sessionToken": "tok",
        "transport": "plivo",
        "providerLegId": "leg-1",
    }
    assert auth == f"Bearer {INTERNAL_TOKEN}"
    with pytest.raises(NodeApiError) as rejected:
        await node.claim("a-1", "bad", "webrtc")
    assert rejected.value.status == 403


async def test_transcript_is_batched_and_flushed_on_close(node_api):
    node, received = node_api
    recorder = TranscriptRecorder(node, "a-1", "tok")
    recorder.add("agent", "  Namaste, main Demo Store ki AI assistant hoon.  ")
    recorder.add("customer", "   ")
    recorder.add("customer", "Haan, boliye.")
    await recorder.close()
    path, body, _ = received[-1]
    assert path == "/internal/v1/voice-sessions/a-1/transcript"
    assert [(e["role"], e["text"]) for e in body["entries"]] == [
        ("agent", "Namaste, main Demo Store ki AI assistant hoon."),
        ("customer", "Haan, boliye."),
    ]
    await node.end("a-1", "tok", "disconnected")
    assert received[-1][1] == {"sessionToken": "tok", "reason": "disconnected"}


async def test_a_failed_transcript_batch_does_not_raise(node_api):
    node, _ = node_api
    recorder = TranscriptRecorder(node, "a-1", "bad")
    recorder.add("agent", "Hello")
    await recorder.close()


def test_entry_timestamps_are_timezone_aware():
    entry = TranscriptEntry(role="agent", text="x", spoken_at=datetime.now(UTC))
    assert entry.spoken_at.tzinfo is not None
