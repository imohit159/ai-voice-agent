import pytest

from voice_agent.config import Settings
from voice_agent.node_client import SessionContext

INTERNAL_TOKEN = "internal-token-at-least-32-characters-long"
PLIVO_TOKEN = "plivo-test-auth-token"
STREAM_URL = "wss://agent.example.com/voice/plivo"


def session_context(**overrides) -> SessionContext:
    data = {
        "attemptId": "6f1c2a9e-3b0d-4c55-9f1e-8a2b7c0d4e11",
        "transport": "plivo",
        "isPractice": False,
        "maxCallSeconds": 180,
        "agent": {
            "voiceProvider": "gemini",
            "model": "gemini-3.8-live",
            "language": "Hindi and English",
            "storeName": "Demo Store",
        },
        "customer": {"name": "Asha"},
        "order": {
            "id": "ORD-1",
            "items": [{"name": "Wireless headphones", "quantity": 1}],
            "total": {"amountMinor": 149900, "currency": "INR"},
            "paymentMethod": "cash_on_delivery",
            "deliveryAddress": "Indiranagar, Bengaluru 560038",
        },
    }
    data.update(overrides)
    return SessionContext.model_validate(data)


@pytest.fixture
def settings() -> Settings:
    return Settings(
        internal_token=INTERNAL_TOKEN,
        gemini_api_key="test-gemini-key",
        plivo_auth_id="MATEST",
        plivo_auth_token=PLIVO_TOKEN,
        stream_url=STREAM_URL,
    )
