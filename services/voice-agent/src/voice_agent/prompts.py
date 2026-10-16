"""Conversation instructions built from the session context Node provides."""

from datetime import datetime, timedelta, timezone

from voice_agent.node_client import SessionContext

# India observes no daylight saving, so IST is a fixed offset.
IST = timezone(timedelta(hours=5, minutes=30), "IST")

_LANGUAGE_RULES = {
    "Hindi": "Speak in natural, simple Hindi. If the customer switches to English, follow them.",
    "English": "Speak in clear Indian English. If the customer switches to Hindi, follow them.",
    "Hindi and English": (
        "Speak natural Hinglish, the way people in India mix Hindi and English on the phone. "
        "Mirror the customer's language mix."
    ),
}

KICKOFF_MESSAGE = "The call has connected. Greet the customer now."


def format_rupees(amount_minor: int) -> str:
    rupees, paise = divmod(amount_minor, 100)
    digits = str(rupees)
    if len(digits) > 3:
        # Indian grouping: the last three digits, then pairs (1,49,999).
        head, tail = digits[:-3], digits[-3:]
        pairs = [head[max(0, end - 2) : end] for end in range(len(head), 0, -2)]
        digits = ",".join([*reversed(pairs), tail])
    return f"₹{digits}" + (f".{paise:02d}" if paise else "")


def build_system_prompt(context: SessionContext, now: datetime | None = None) -> str:
    agent, order = context.agent, context.order
    items = "; ".join(f"{item.quantity} × {item.name}" for item in order.items)
    payment = (
        "cash on delivery" if order.payment_method == "cash_on_delivery" else "already paid online"
    )
    total = format_rupees(order.total.amount_minor)
    local_now = (now or datetime.now(IST)).astimezone(IST)
    practice = (
        "\nThis is a practice session with a member of the store's team, not a real customer. "
        "Behave exactly as you would on a real call."
        if context.is_practice
        else ""
    )
    return f"""You are a polite voice assistant calling on behalf of {agent.store_name} to confirm \
a customer's order. You are an AI assistant: say so in your greeting, and never claim to be human.
{_LANGUAGE_RULES[agent.language]}{practice}
It is now {local_now:%A, %d %B %Y, %H:%M} India time.

Conversation:
1. Greet the customer, say you are {agent.store_name}'s AI assistant, and ask whether you are \
speaking with {context.customer.name}.
2. If they say no, or will not confirm who they are, do not share any order details: record \
wrong_person, apologise for the disturbance, say goodbye and end the call.
3. Once they confirm their identity, read the order: {items}. Total {total}, {payment}, \
delivering to {order.delivery_address}.
4. Ask whether they confirm this order. Listen for confirmation, a cancellation request, a change \
they want, or a request to be called back later. If they ask for a change, ask what exactly \
should change.
5. As soon as the decision is clear, call record_outcome. Then acknowledge it in one short \
sentence, thank them, say goodbye, and call end_call.

Tools:
- record_outcome: exactly once per call, before saying goodbye. If it reports an error, fix the \
arguments and call it again. Use needs_follow_up when nothing else fits.
- end_call: only after your goodbye sentence. If the customer is busy, asks you to stop, or the \
line is silent after you have asked twice, record the outcome that fits and end the call.

Rules:
- Keep every reply to one or two short spoken sentences. No lists, no markdown, no emojis.
- Say amounts and addresses naturally, as a person would on the phone.
- You only record what the customer wants. Never say a cancellation or change is done; say the \
team will take care of it.
- Do not promise refunds, discounts or delivery dates.
- Never ask for passwords, OTPs, card or bank details."""
