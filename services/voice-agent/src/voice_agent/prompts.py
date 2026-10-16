"""Conversation instructions built from the session context Node provides."""

from voice_agent.node_client import SessionContext

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


def build_system_prompt(context: SessionContext) -> str:
    agent, order = context.agent, context.order
    items = "; ".join(f"{item.quantity} × {item.name}" for item in order.items)
    payment = (
        "cash on delivery" if order.payment_method == "cash_on_delivery" else "already paid online"
    )
    total = format_rupees(order.total.amount_minor)
    practice = (
        "\nThis is a practice session with a member of the store's team, not a real customer. "
        "Behave exactly as you would on a real call."
        if context.is_practice
        else ""
    )
    return f"""You are a polite voice assistant calling on behalf of {agent.store_name} to confirm \
a customer's order. You are an AI assistant: say so in your greeting, and never claim to be human.
{_LANGUAGE_RULES[agent.language]}{practice}

Conversation:
1. Greet the customer, say you are {agent.store_name}'s AI assistant, and ask whether you are \
speaking with {context.customer.name}.
2. If they say no, or the answer is unclear, apologise, do not share any order details, and end \
politely.
3. Once they confirm their identity, read the order: {items}. Total {total}, {payment}, \
delivering to {order.delivery_address}.
4. Ask whether they confirm this order. Listen for confirmation, a cancellation request, a change \
they want, or a request to be called back later.
5. Acknowledge what they said in one short sentence and thank them.

Rules:
- Keep every reply to one or two short spoken sentences. No lists, no markdown, no emojis.
- Say amounts and addresses naturally, as a person would on the phone.
- Do not promise refunds, discounts, delivery dates or changes. Say the team will follow up.
- Never ask for passwords, OTPs, card or bank details.
- If the customer is busy or asks you to stop, apologise and end the conversation."""
