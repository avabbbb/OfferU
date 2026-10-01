from __future__ import annotations

import inspect
import logging
from collections import defaultdict
from typing import Any, Callable, DefaultDict, Optional

from app.agent.types import CancelToken


BEFORE_AGENT_START = "before_agent_start"
CONTEXT = "context"
BEFORE_TOOL_CALL = "before_tool_call"
AFTER_TOOL_CALL = "after_tool_call"
TURN_END = "turn_end"
SAVE_POINT = "save_point"
SETTLED = "settled"

_logger = logging.getLogger(__name__)


class HookRegistry:
    def __init__(self) -> None:
        self._callbacks: DefaultDict[str, list[Callable[..., Any]]] = defaultdict(list)

    def on(self, name: str, callback: Callable[..., Any]) -> None:
        self._callbacks[name].append(callback)

    def subscribe(self, name: str, callback: Callable[..., Any]) -> Callable[[], None]:
        self.on(name, callback)

        def unsubscribe() -> None:
            callbacks = self._callbacks.get(name)
            if not callbacks:
                return
            try:
                callbacks.remove(callback)
            except ValueError:
                return

        return unsubscribe

    async def emit(self, name: str, payload: Any = None, *, cancel: Optional[CancelToken] = None) -> Any:
        result = None
        for callback in list(self._callbacks.get(name, [])):
            if cancel and cancel.cancelled:
                break
            value = callback(payload)
            if inspect.isawaitable(value):
                value = await value
            if value is not None:
                result = value
            if cancel and cancel.cancelled:
                break
        return result
