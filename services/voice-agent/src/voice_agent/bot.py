"""Builds and runs one conversation pipeline for a claimed voice session.

Both AI approaches share this bot: transport, turn handling, kickoff and
transcript capture are common; only the model stage differs.
"""

import asyncio
from dataclasses import dataclass

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService
from pipecat.services.llm_service import LLMService
from pipecat.services.sarvam.llm import SarvamLLMService
from pipecat.services.sarvam.stt import SarvamSTTService
from pipecat.services.sarvam.tts import SarvamTTSService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import BaseTransport
from pipecat.workers.runner import WorkerRunner

from voice_agent.config import Settings
from voice_agent.node_client import AgentConfig, EndReason, SessionApi, SessionContext
from voice_agent.prompts import KICKOFF_MESSAGE, build_system_prompt
from voice_agent.tools import GOODBYES, TOOLS, register_tools
from voice_agent.transcript import TranscriptRecorder

# Teardown allowance after the call's own limit; Plivo's time_limit normally ends it first.
_SESSION_GRACE_SECONDS = 30

_SPEECH_LANGUAGE = {
    "Hindi": Language.HI_IN,
    "English": Language.EN_IN,
    "Hindi and English": Language.HI_IN,
}


class ProviderNotConfigured(Exception):
    pass


@dataclass
class ModelStage:
    """The processors between transport input and output, and the pieces tools attach to."""

    processors: list[FrameProcessor]
    llm: LLMService
    pair: LLMContextAggregatorPair
    has_tts: bool = False


def build_model_stage(agent: AgentConfig, system_prompt: str, settings: Settings) -> ModelStage:
    if agent.voice_provider == "gemini":
        if not settings.gemini_api_key:
            raise ProviderNotConfigured("GEMINI_API_KEY")
        llm = GeminiLiveLLMService(
            api_key=settings.gemini_api_key.get_secret_value(),
            system_instruction=system_prompt,
            tools=TOOLS,
            settings=GeminiLiveLLMService.Settings(
                model=agent.model, language=_SPEECH_LANGUAGE[agent.language]
            ),
        )
        context = LLMContext([{"role": "user", "content": KICKOFF_MESSAGE}])
        # Gemini Live hears raw audio and detects turns server side; the pair
        # auto-detects realtime mode.
        pair = LLMContextAggregatorPair(context)
        return ModelStage([pair.user(), llm], llm, pair)

    if not settings.sarvam_api_key:
        raise ProviderNotConfigured("SARVAM_API_KEY")
    key = settings.sarvam_api_key.get_secret_value()
    # Mixed Hindi-English speech is transcribed best with auto-detection.
    mixed = agent.language == "Hindi and English"
    stt_language = None if mixed else _SPEECH_LANGUAGE[agent.language]
    stt = SarvamSTTService(
        api_key=key,
        settings=SarvamSTTService.Settings(model=agent.stt_model, language=stt_language),
    )
    llm = SarvamLLMService(api_key=key, settings=SarvamLLMService.Settings(model=agent.model))
    tts = SarvamTTSService(
        api_key=key,
        settings=SarvamTTSService.Settings(
            model=agent.tts_model, language=_SPEECH_LANGUAGE[agent.language]
        ),
    )
    context = LLMContext(
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": KICKOFF_MESSAGE},
        ],
        tools=TOOLS,
    )
    pair = LLMContextAggregatorPair(
        context, user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer())
    )
    return ModelStage([stt, pair.user(), llm, tts], llm, pair, has_tts=True)


async def run_conversation(
    transport: BaseTransport,
    session: SessionContext,
    settings: Settings,
    node: SessionApi,
    session_token: str,
    recorder: TranscriptRecorder,
) -> EndReason:
    """Runs until the agent ends the call, the caller leaves, the time limit passes, or it fails."""
    stage = build_model_stage(session.agent, build_system_prompt(session), settings)

    async def say(text: str) -> None:
        await stage.llm.push_frame(TTSSpeakFrame(text))

    state = register_tools(
        stage.llm,
        node,
        session.attempt_id,
        session_token,
        # Realtime models speak for themselves; only the cascade has a TTS stage.
        say=say if stage.has_tts else None,
        goodbye=GOODBYES[session.agent.language],
    )
    pair = stage.pair
    pipeline = Pipeline(
        [transport.input(), *stage.processors, transport.output(), pair.assistant()]
    )
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True),
        enable_rtvi=False,
        idle_timeout_secs=None,
    )

    @pair.user().event_handler("on_user_turn_message_added")
    async def _user_said(_aggregator, message):
        # The kickoff instruction is ours, not the customer's.
        if message.content != KICKOFF_MESSAGE:
            recorder.add("customer", message.content)

    @pair.assistant().event_handler("on_assistant_turn_stopped")
    async def _agent_said(_aggregator, message):
        recorder.add("agent", message.content)
        if message.content.strip():
            state.agent_spoke()

    @transport.event_handler("on_client_connected")
    async def _connected(_transport, _client):
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def _disconnected(_transport, _client):
        await worker.cancel(reason="client disconnected")

    recorder.start()
    runner = WorkerRunner(handle_sigint=False)
    try:
        await asyncio.wait_for(
            runner.run(worker), session.max_call_seconds + _SESSION_GRACE_SECONDS
        )
        return "completed" if state.ended_by_agent else "disconnected"
    except TimeoutError:
        await worker.cancel(reason="session time limit")
        return "timeout"
    except Exception as error:  # noqa: BLE001 - reported to Node as an errored session
        logger.error(
            f"Conversation failed for attempt {session.attempt_id}: {type(error).__name__}"
        )
        return "error"
    finally:
        await recorder.close()
