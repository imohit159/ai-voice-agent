import pytest
from conftest import session_context
from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService
from pipecat.services.sarvam.llm import SarvamLLMService
from pipecat.services.sarvam.stt import SarvamSTTService
from pipecat.services.sarvam.tts import SarvamTTSService

from voice_agent.bot import ProviderNotConfigured, build_model_stage
from voice_agent.node_client import AgentConfig


def test_gemini_runs_as_a_single_realtime_stage(settings):
    stage = build_model_stage(session_context().agent, "prompt", settings)
    assert stage.processors == [stage.pair.user(), stage.llm]
    assert isinstance(stage.llm, GeminiLiveLLMService)


def test_sarvam_runs_as_a_cascade_with_the_snapshotted_models(settings):
    settings.sarvam_api_key = "test-sarvam-key"
    agent = AgentConfig.model_validate(
        {
            "voiceProvider": "sarvam",
            "model": "sarvam-105b-conversations",
            "sttModel": "saaras:v4",
            "ttsModel": "bulbul:v3",
            "language": "Hindi",
            "storeName": "Demo Store",
        }
    )
    stage = build_model_stage(agent, "prompt", settings)
    assert [type(s) for s in stage.processors] == [
        SarvamSTTService,
        type(stage.pair.user()),
        SarvamLLMService,
        SarvamTTSService,
    ]
    assert stage.llm is stage.processors[2]
    context = stage.pair.user().context
    assert context.get_messages()[0] == {"role": "system", "content": "prompt"}
    assert [tool.name for tool in context.tools.standard_tools] == ["record_outcome", "end_call"]


def test_missing_provider_key_is_reported_not_silently_substituted(settings):
    settings.gemini_api_key = None
    with pytest.raises(ProviderNotConfigured, match="GEMINI_API_KEY"):
        build_model_stage(session_context().agent, "prompt", settings)
