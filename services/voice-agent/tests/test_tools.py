from types import SimpleNamespace

from pipecat.frames.frames import EndWorkerFrame

from voice_agent.node_client import NodeApiError
from voice_agent.tools import OUTCOMES, RECORD_OUTCOME, register_tools


class FakeLLM:
    def __init__(self):
        self.handlers = {}
        self.pushed = []

    def register_function(self, name, handler, **_options):
        self.handlers[name] = handler

    async def push_frame(self, frame, *_args):
        self.pushed.append(frame)


class FakeNode:
    def __init__(self, reject_with: str | None = None):
        self.reject_with = reject_with
        self.outcomes = []

    async def record_outcome(self, attempt_id, token, outcome, summary, callback_at):
        if self.reject_with:
            raise NodeApiError(422, self.reject_with)
        self.outcomes.append((attempt_id, token, outcome, summary, callback_at))


async def call(llm, name, arguments):
    results = []

    async def result_callback(result, properties=None):
        results.append((result, properties))

    await llm.handlers[name](
        SimpleNamespace(arguments=arguments, llm=llm, result_callback=result_callback)
    )
    return results


def test_outcome_choices_match_the_contract():
    assert RECORD_OUTCOME.properties["outcome"]["enum"] == [
        "confirmed",
        "cancel_requested",
        "change_requested",
        "callback_requested",
        "wrong_person",
        "needs_follow_up",
    ]
    assert set(OUTCOMES) == set(RECORD_OUTCOME.properties["outcome"]["enum"])


async def test_record_outcome_relays_to_node_and_reports_back():
    llm, node = FakeLLM(), FakeNode()
    state = register_tools(llm, node, "a-1", "tok")
    results = await call(
        llm,
        "record_outcome",
        {
            "outcome": "callback_requested",
            "summary": "Call tomorrow 6pm.",
            "callback_at": "2026-10-17T18:00:00+05:30",
        },
    )
    assert node.outcomes == [
        ("a-1", "tok", "callback_requested", "Call tomorrow 6pm.", "2026-10-17T18:00:00+05:30")
    ]
    assert results[0][0]["recorded"] is True
    assert state.outcome == "callback_requested"


async def test_a_rejected_outcome_tells_the_model_why():
    llm = FakeLLM()
    state = register_tools(
        llm, FakeNode(reject_with="callbackAt must be in the future."), "a-1", "tok"
    )
    results = await call(
        llm, "record_outcome", {"outcome": "callback_requested", "summary": "x x x"}
    )
    assert results[0][0] == {"recorded": False, "error": "callbackAt must be in the future."}
    assert state.outcome is None


async def test_end_call_ends_the_pipeline_after_queued_speech():
    llm = FakeLLM()
    state = register_tools(llm, FakeNode(), "a-1", "tok")
    results = await call(llm, "end_call", {})
    assert state.ended_by_agent
    assert results[0][1].run_llm is False
    assert len(llm.pushed) == 1 and isinstance(llm.pushed[0], EndWorkerFrame)


async def test_end_call_speaks_a_goodbye_when_the_model_did_not():
    spoken = []

    async def say(text):
        spoken.append(text)

    llm = FakeLLM()
    state = register_tools(llm, FakeNode(), "a-1", "tok", say=say, goodbye="Bye.")
    await call(llm, "record_outcome", {"outcome": "confirmed", "summary": "Confirmed."})
    await call(llm, "end_call", {})
    assert spoken == ["Bye."]

    llm = FakeLLM()
    state = register_tools(llm, FakeNode(), "a-1", "tok", say=say, goodbye="Bye.")
    await call(llm, "record_outcome", {"outcome": "confirmed", "summary": "Confirmed."})
    state.agent_spoke()
    await call(llm, "end_call", {})
    assert spoken == ["Bye."], "no second goodbye after the model said one"
