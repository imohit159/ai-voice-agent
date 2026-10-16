"""Builds and runs one conversation pipeline for a claimed voice session.

Both AI approaches share this bot: transport, turn handling, kickoff and
transcript capture are common; only the model stage differs.
"""

import asyncio

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService
from pipecat.services.sarvam.llm import SarvamLLMService
from pipecat.services.sarvam.stt import SarvamSTTService
from pipecat.services.sarvam.tts import SarvamTTSService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import BaseTransport
from pipecat.workers.runner import WorkerRunner

from voice_agent.config import Settings
from voice_agent.node_client import AgentConfig, EndReason, SessionContext
from voice_agent.prompts import KICKOFF_MESSAGE, build_system_prompt
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


def build_model_stage(
    agent: AgentConfig, system_prompt: str, settings: Settings
) -> tuple[list[FrameProcessor], LLMContext, LLMContextAggregatorPair]:
    """Returns the processors between transport input and output, plus the shared context."""
    if agent.voice_provider == "gemini":
        if not settings.gemini_api_key:
            raise ProviderNotConfigured("GEMINI_API_KEY")
        llm = GeminiLiveLLMService(
            api_key=settings.gemini_api_key.get_secret_value(),
            system_instruction=system_prompt,
            settings=GeminiLiveLLMService.Settings(
                model=agent.model, language=_SPEECH_LANGUAGE[agent.language]
            ),
        )
        context = LLMContext([{"role": "user", "content": KICKOFF_MESSAGE}])
        # Gemini Live hears raw audio and detects turns server side; the pair
        # auto-detects realtime mode.
        pair = LLMContextAggregatorPair(context)
        return [pair.user(), llm], context, pair

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
        ]
    )
    pair = LLMContextAggregatorPair(
        context, user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer())
    )
    return [stt, pair.user(), llm, tts], context, pair


async def run_conversation(
    transport: BaseTransport,
    session: SessionContext,
    settings: Settings,
    recorder: TranscriptRecorder,
) -> EndReason:
    """Runs until the caller leaves, the time limit passes, or the pipeline fails."""
    stages, _context, pair = build_model_stage(
        session.agent, build_system_prompt(session), settings
    )
    pipeline = Pipeline([transport.input(), *stages, transport.output(), pair.assistant()])
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
        return "disconnected"
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
