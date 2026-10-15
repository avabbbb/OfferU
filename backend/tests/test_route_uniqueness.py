"""Every (method, path) is registered exactly once.

FastAPI silently keeps the first duplicate. A shadowed
``POST /data/fresh-reset/proposal`` executed the protected reset directly on
an unprotected surface, so 「清空本地数据」 always failed with
「全清只能通过已确认的 Operation Registry 提案执行」 instead of creating the
reviewable Plan.
"""

from __future__ import annotations

import collections
import importlib
import pkgutil
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi.routing import APIRoute



def _routers():
    import app.routes as routes_pkg

    for module_info in pkgutil.iter_modules(routes_pkg.__path__):
        module = importlib.import_module(f"app.routes.{module_info.name}")
        for attr in dir(module):
            router = getattr(module, attr)
            if isinstance(router, APIRouter):
                yield f"{module_info.name}.{attr}", router


def test_no_router_registers_the_same_method_and_path_twice():
    duplicates = []
    for name, router in _routers():
        seen: dict[tuple[str, str], list[str]] = collections.defaultdict(list)
        for route in router.routes:
            if isinstance(route, APIRoute):
                for method in route.methods:
                    seen[(method, route.path)].append(route.endpoint.__name__)
        duplicates += [(name, key, value) for key, value in seen.items() if len(value) > 1]
    assert duplicates == []
