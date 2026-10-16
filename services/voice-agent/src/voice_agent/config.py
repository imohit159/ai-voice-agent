"""Typed, validated configuration for the voice agent.

Values come from the process environment. In local development the
repository-root .env is loaded too, without overriding real environment values.
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError

_ROOT_ENV = Path(__file__).resolve().parents[4] / ".env"


class Settings(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    host: str = "127.0.0.1"
    port: int = Field(default=7860, ge=1, le=65535)
    # Private base URL of the Node API, the only database writer.
    api_internal_url: str = "http://127.0.0.1:3000"
    internal_token: SecretStr = Field(min_length=32)
    gemini_api_key: SecretStr | None = None
    sarvam_api_key: SecretStr | None = None
    plivo_auth_id: str | None = None
    plivo_auth_token: SecretStr | None = None
    # The public wss:// URL Plivo connects to; Plivo signs exactly this URL.
    stream_url: str | None = None
    log_level: str = "INFO"

    @property
    def plivo_enabled(self) -> bool:
        return bool(self.plivo_auth_id and self.plivo_auth_token and self.stream_url)


_ENV_NAMES = {
    "host": "VOICE_AGENT_HOST",
    "port": "VOICE_AGENT_PORT",
    "api_internal_url": "API_INTERNAL_URL",
    "internal_token": "VOICE_AGENT_INTERNAL_TOKEN",
    "gemini_api_key": "GEMINI_API_KEY",
    "sarvam_api_key": "SARVAM_API_KEY",
    "plivo_auth_id": "PLIVO_AUTH_ID",
    "plivo_auth_token": "PLIVO_AUTH_TOKEN",
    "stream_url": "VOICE_AGENT_STREAM_URL",
    "log_level": "VOICE_AGENT_LOG_LEVEL",
}


def load_settings(environ: dict[str, str] | None = None) -> Settings:
    if environ is None:
        if _ROOT_ENV.exists():
            load_dotenv(_ROOT_ENV, override=False)
        environ = dict(os.environ)
    values = {field: environ[name] for field, name in _ENV_NAMES.items() if environ.get(name)}
    try:
        return Settings(**values)
    except ValidationError as error:
        # Report variable names only; values may be secrets.
        fields = {str(issue["loc"][0]) for issue in error.errors()}
        names = sorted(_ENV_NAMES.get(field, field) for field in fields)
        raise SystemExit(f"Invalid voice agent configuration: {', '.join(names)}") from None
