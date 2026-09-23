"""Email adapters preserve the Registry boundary and the SPA callback route."""

import asyncio
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import HTTPException

from app.routes.email import oauth_callback, progress_candidates


def test_gmail_callback_returns_to_email_hash_route() -> None:
    operation = AsyncMock(return_value={"ok": True, "outputs": {"connected": True}})
    with patch("app.ops.execute_operation", operation):
        response = asyncio.run(oauth_callback(code="test-code", state="test-state"))

    target = urlsplit(response.headers["location"])
    assert (target.scheme, target.netloc, target.path) == (
        "http", "127.0.0.1:7410", "/",
    )
    assert target.fragment == "/email"
    assert parse_qs(target.query) == {"auth": ["success"]}
    operation.assert_awaited_once_with(
        "complete_gmail_oauth",
        {"code": "test-code", "state": "test-state"},
        surface="email_api",
    )


@pytest.mark.parametrize(
    ("result", "status"),
    [
        ({"ok": False, "errors": ["Authorization failed"]}, 400),
        ({"ok": True, "outputs": None}, 502),
    ],
)
def test_gmail_callback_does_not_redirect_on_operation_failure(result, status) -> None:
    with patch("app.ops.execute_operation", AsyncMock(return_value=result)):
        with pytest.raises(HTTPException) as error:
            asyncio.run(oauth_callback(code="test-code", state="test-state"))
    assert error.value.status_code == status


def test_progress_inbox_preserves_filters_and_registry_surface() -> None:
    outputs = {"items": [{"candidate_id": "candidate-1", "status": "pending"}]}
    operation = AsyncMock(return_value={"ok": True, "outputs": outputs})
    with patch("app.ops.execute_operation", operation):
        result = asyncio.run(progress_candidates(status="pending", disclosure="summary", limit=10))

    assert result == outputs
    operation.assert_awaited_once_with(
        "list_application_progress_candidates",
        {"status": "pending", "disclosure": "summary", "limit": 10},
        surface="email_api",
    )
