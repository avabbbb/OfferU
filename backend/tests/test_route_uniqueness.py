"""Every (method, path) is registered exactly once.

FastAPI silently keeps the first duplicate. A shadowed
``POST /data/fresh-reset/proposal`` executed the protected reset directly on
an unprotected surface, so 「清空本地数据」 always failed with
「全清只能通过已确认的 Operation Registry 提案执行」 instead of creating the
reviewable Plan.
"""

from __future__ import annotations

import asyncio
import collections
import importlib
import pkgutil
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi.routing import APIRoute

from proposal_v2_fixtures import make_db


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


@pytest.fixture
def reset_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    database = make_db(tmp_path, monkeypatch)
    asyncio.run(database.start(create_schema=True))
    yield database
    asyncio.run(database.close())


def test_fresh_reset_proposal_endpoint_creates_a_reviewable_plan_without_clearing(reset_db):
    from app.routes import main_agent

    (route,) = [
        item
        for item in main_agent.router.routes
        if isinstance(item, APIRoute) and item.path == "/data/fresh-reset/proposal"
    ]
    outputs = asyncio.run(route.endpoint())
    assert outputs.get("requires_confirmation") is True
    assert outputs.get("executed") in (None, False)
    # freshResetApi.createProposal needs the persisted Plan to show the review.
    nodes = [node for group in outputs["plan"]["groups"] for node in group["nodes"]]
    assert [node["operation"] for node in nodes] == ["reset_local_business_data"]
