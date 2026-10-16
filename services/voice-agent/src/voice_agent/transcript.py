"""Batches what was said and delivers it to the Node API without blocking the conversation."""

import asyncio
from datetime import UTC, datetime

from loguru import logger

from voice_agent.node_client import NodeClient, Role, TranscriptEntry

_FLUSH_INTERVAL_SECONDS = 2.0
_MAX_BATCH = 50


class TranscriptRecorder:
    def __init__(self, node: NodeClient, attempt_id: str, session_token: str):
        self._node = node
        self._attempt_id = attempt_id
        self._token = session_token
        self._pending: list[TranscriptEntry] = []
        self._task: asyncio.Task | None = None

    def add(self, role: Role, text: str) -> None:
        text = text.strip()
        if text:
            self._pending.append(
                TranscriptEntry(role=role, text=text[:4000], spoken_at=datetime.now(UTC))
            )

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(_FLUSH_INTERVAL_SECONDS)
            await self.flush()

    async def flush(self) -> None:
        while self._pending:
            batch, self._pending = self._pending[:_MAX_BATCH], self._pending[_MAX_BATCH:]
            try:
                await self._node.append_transcript(self._attempt_id, self._token, batch)
            except Exception as error:  # noqa: BLE001 - a lost batch must not end the call
                logger.warning(
                    f"Transcript batch not stored for attempt {self._attempt_id}: "
                    f"{type(error).__name__}"
                )

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
        await self.flush()
