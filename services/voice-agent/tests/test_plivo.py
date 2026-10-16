import json

import pytest

from voice_agent.plivo import (
    InvalidStreamStart,
    parse_extra_headers,
    read_start,
    verify_v3_get_signature,
)

# Generated with plivo-python's utils/signature_v3.py (the reference implementation).
REFERENCE = {
    "token": "plivo-test-auth-token",
    "nonce": "12345678901234567890",
    "url": "https://agent.example.com/stream?z=last&attempt=a%2Bb",
    "signature": "kpKacvgGzuLa2dMrX9Fc2cVFbQJTCvK4dW/atUKmn90=",
}


def test_upgrade_signature_matches_reference_implementation():
    r = REFERENCE
    assert verify_v3_get_signature(r["token"], r["url"], r["nonce"], r["signature"])
    assert verify_v3_get_signature(r["token"], r["url"], r["nonce"], f"AAAA,{r['signature']}")
    assert not verify_v3_get_signature(r["token"] + "x", r["url"], r["nonce"], r["signature"])
    assert not verify_v3_get_signature(r["token"], r["url"], r["nonce"] + "0", r["signature"])
    assert not verify_v3_get_signature(
        r["token"], r["url"].replace("last", "first"), r["nonce"], r["signature"]
    )
    assert not verify_v3_get_signature(r["token"], r["url"], None, r["signature"])
    assert not verify_v3_get_signature(r["token"], r["url"], r["nonce"], None)


def test_extra_headers_parse_plivo_format_and_tolerate_prefixes():
    assert parse_extra_headers("attemptId=a-1;sessionToken=x.y-z_") == {
        "attemptId": "a-1",
        "sessionToken": "x.y-z_",
    }
    assert parse_extra_headers("X-PH-attemptId=a-1") == {"attemptId": "a-1"}
    assert parse_extra_headers({"attemptId": "a-1"}) == {"attemptId": "a-1"}
    assert parse_extra_headers(None) == {}
    assert parse_extra_headers("broken;=x;novalue=") == {}


class FakeWebSocket:
    def __init__(self, messages: list[dict]):
        self._messages = [json.dumps(m) for m in messages]

    async def receive_text(self) -> str:
        return self._messages.pop(0)


def start_event(extra="attemptId=a-1;sessionToken=tok", where="top"):
    message = {"event": "start", "start": {"streamId": "s-1", "callId": "c-1"}}
    if where == "top":
        message["extra_headers"] = extra
    else:
        message["start"]["extraHeaders"] = extra
    return message


async def test_start_event_yields_call_identity_and_session():
    start = await read_start(FakeWebSocket([{"event": "connected"}, start_event()]))
    assert (start.stream_id, start.call_id, start.attempt_id, start.session_token) == (
        "s-1",
        "c-1",
        "a-1",
        "tok",
    )
    nested = await read_start(FakeWebSocket([start_event(where="start")]))
    assert nested.attempt_id == "a-1"


async def test_start_event_without_session_headers_is_rejected():
    with pytest.raises(InvalidStreamStart):
        await read_start(FakeWebSocket([start_event(extra="attemptId=a-1")]))
    with pytest.raises(InvalidStreamStart):
        await read_start(FakeWebSocket([{"event": "media"}] * 5))
