"""Server-sent events for the dashboard: one queue per open browser tab."""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator


class EventHub:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()

    def publish(self, kind: str, data: Any = None) -> None:
        message = {"type": kind, "data": data}
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                pass  # a stalled tab loses events, it refetches on reconnect

    async def stream(self) -> AsyncIterator[str]:
        queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._subscribers.add(queue)
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=20)
                    yield f"data: {json.dumps(message, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            self._subscribers.discard(queue)
