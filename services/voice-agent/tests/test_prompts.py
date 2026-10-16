from conftest import session_context

from voice_agent.prompts import build_system_prompt, format_rupees


def test_rupees_use_indian_grouping():
    assert format_rupees(149900) == "₹1,499"
    assert format_rupees(14999950) == "₹1,49,999.50"
    assert format_rupees(99) == "₹0.99"
    assert format_rupees(1234567800) == "₹1,23,45,678"


def test_prompt_verifies_identity_before_order_details_and_follows_language():
    prompt = build_system_prompt(session_context())
    assert "speaking with Asha" in prompt
    assert prompt.index("speaking with Asha") < prompt.index("Wireless headphones")
    assert "do not share any order details" in prompt
    assert "₹1,499" in prompt and "cash on delivery" in prompt
    assert "Hinglish" in prompt
    assert "practice session" not in prompt
    practice = build_system_prompt(session_context(isPractice=True, transport="webrtc"))
    assert "practice session" in practice
