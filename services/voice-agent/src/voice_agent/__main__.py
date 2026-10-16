import sys

import uvicorn
from loguru import logger

from voice_agent.config import load_settings
from voice_agent.server import create_app


def main() -> None:
    settings = load_settings()
    # Pipecat logs conversation text at DEBUG; keep it out of production logs.
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level)
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        proxy_headers=False,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
