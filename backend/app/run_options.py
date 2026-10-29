"""Per-run choices from the Agent composer.

The route binds them around one Run; the LLM layer reads which model config and
reasoning effort to use, and the action gate reads whether every write asks first.
ContextVars follow the Run into the tasks it spawns, so nothing is threaded by hand.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Iterator


@dataclass(frozen=True)
class RunOptions:
    # id of an entry in llm_api_configs; empty means the active config
    llm_config_id: str = ""
    # empty, low, medium or high; empty sends no reasoning_effort
    reasoning_effort: str = ""
    # auto: only irreversible writes wait for the user; ask: every write does
    approval_mode: str = "auto"
    # ids of image attachments the user sent with this message
    image_attachments: tuple[str, ...] = ()


_RUN_OPTIONS: ContextVar[RunOptions] = ContextVar("offeru_run_options", default=RunOptions())


def current_run_options() -> RunOptions:
    return _RUN_OPTIONS.get()


@contextmanager
def use_run_options(options: RunOptions) -> Iterator[None]:
    token = _RUN_OPTIONS.set(options)
    try:
        yield
    finally:
        _RUN_OPTIONS.reset(token)
