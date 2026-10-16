"""Conversation tools: record the customer's decision, then end the call.

The model's arguments are untrusted. Node validates every outcome against the
use case before recording it; this module only relays and reports back.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import EndWorkerFrame, FunctionCallResultProperties
from pipecat.services.llm_service import FunctionCallParams, LLMService

from voice_agent.node_client import NodeApiError, SessionApi

OUTCOMES = {
    "confirmed": "The customer explicitly confirmed this order as it is.",
    "cancel_requested": "The customer wants to cancel the order.",
    "change_requested": "The customer wants something changed (item, address, time).",
    "callback_requested": "The customer asked to be called back at another time.",
    "wrong_person": "The person is not the customer, or would not confirm who they are.",
    "needs_follow_up": "Anything else: unclear answers, questions you cannot answer, complaints.",
}

RECORD_OUTCOME = FunctionSchema(
    name="record_outcome",
    description=(
        "Record the customer's decision about this order. Call it exactly once, as soon as "
        "the decision is clear and before saying goodbye."
    ),
    properties={
        "outcome": {
            "type": "string",
            "enum": list(OUTCOMES),
            "description": " ".join(f"{name}: {meaning}" for name, meaning in OUTCOMES.items()),
        },
        "summary": {
            "type": "string",
            "description": (
                "One factual English sentence of what the customer said, including any change "
                "they asked for or when they want a call back."
            ),
        },
        "callback_at": {
            "type": "string",
            "description": (
                "Only for callback_requested, when the customer gave a time: ISO 8601 with the "
                "+05:30 offset, e.g. 2026-10-17T18:00:00+05:30. Omit if no clear time."
            ),
        },
    },
    required=["outcome", "summary"],
)

END_CALL = FunctionSchema(
    name="end_call",
    description="Hang up. Call it only after you have said goodbye.",
    properties={},
    required=[],
)


# Spoken if the model hangs up without saying goodbye; Bulbul reads Devanagari best.
GOODBYES = {
    "Hindi": "धन्यवाद, आपका दिन शुभ हो।",
    "Hindi and English": "धन्यवाद, आपका दिन शुभ हो।",
    "English": "Thank you, have a good day.",
}


@dataclass
class CallState:
    outcome: str | None = None
    agent_spoke_after_outcome: bool = False
    ended_by_agent: bool = False

    def agent_spoke(self) -> None:
        if self.outcome is not None:
            self.agent_spoke_after_outcome = True


def register_tools(
    llm: LLMService,
    node: SessionApi,
    attempt_id: str,
    session_token: str,
    say: Callable[[str], Awaitable[None]] | None = None,
    goodbye: str = GOODBYES["English"],
) -> CallState:
    """`say` speaks fixed text where the pipeline has its own TTS (the cascade)."""
    state = CallState()

    async def record_outcome(params: FunctionCallParams) -> None:
        args = params.arguments
        try:
            await node.record_outcome(
                attempt_id,
                session_token,
                str(args.get("outcome", "")),
                str(args.get("summary", "")),
                str(args["callback_at"]) if args.get("callback_at") else None,
            )
        except NodeApiError as error:
            logger.info(f"Outcome rejected for attempt {attempt_id}: HTTP {error.status}")
            await params.result_callback(
                {"recorded": False, "error": error.detail or "The outcome was not accepted."}
            )
            return
        state.outcome = str(args.get("outcome"))
        await params.result_callback(
            {"recorded": True, "next": "Thank the customer in one short sentence, then end_call."}
        )

    async def end_call(params: FunctionCallParams) -> None:
        state.ended_by_agent = True
        if state.outcome is None:
            logger.info(f"Attempt {attempt_id} ended by the agent without an outcome")
        await params.result_callback(
            {"ending": True}, properties=FunctionCallResultProperties(run_llm=False)
        )
        # Never hang up on a customer in silence.
        if say and not state.agent_spoke_after_outcome:
            await say(goodbye)
        # Downstream, so the goodbye already queued is played before the call ends.
        await params.llm.push_frame(EndWorkerFrame(reason="agent ended the call"))

    # Recording must survive the customer talking over the agent.
    llm.register_function("record_outcome", record_outcome, cancel_on_interruption=False)
    llm.register_function("end_call", end_call, cancel_on_interruption=False)
    return state


TOOLS = ToolsSchema(standard_tools=[RECORD_OUTCOME, END_CALL])
