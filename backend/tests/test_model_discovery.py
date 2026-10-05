from unittest.mock import AsyncMock, patch
import asyncio
from functools import wraps

import httpx
import pytest
from fastapi import HTTPException
from test_llm_protocols import isolated_config


def run_async(fn):
    @wraps(fn)
    def run(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))
    return run


@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
@run_async
async def test_models_use_saved_key_and_protocol_without_returning_credentials(protocol):
    with isolated_config() as routes:
        routes._current_config = routes.ConfigUpdate(llm_api_configs=[routes.LlmApiConfig(
            id="saved", base_url="https://provider.test/v1", api_key="fixture-secret", api_format=protocol,
        )])
        response = httpx.Response(200, json={"data": [{"id": "fixture-model", "display_name": "Fixture"}]})
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get.return_value = response
        with patch.object(routes, "_validate_external_base_url", AsyncMock(return_value=None)), patch("httpx.AsyncClient", return_value=client):
            result = await routes.fetch_models(routes.FetchModelsRequest(
                base_url="https://provider.test/v1", api_key="***", config_id="saved", api_format=protocol,
            ))
        headers = client.get.call_args.kwargs["headers"]
        assert headers == ({"x-api-key": "fixture-secret", "anthropic-version": "2023-06-01"}
                           if protocol == "anthropic" else {"Authorization": "Bearer fixture-secret"})
        assert result["models"] == [{"id": "fixture-model", "name": "Fixture", "owned_by": ""}]
        assert "fixture-secret" not in str(result)


@run_async
async def test_saved_key_cannot_be_sent_to_changed_endpoint():
    with isolated_config() as routes:
        routes._current_config = routes.ConfigUpdate(llm_api_configs=[routes.LlmApiConfig(
            id="saved", base_url="https://original.test/v1", api_key="fixture-secret",
        )])
        with patch.object(routes, "_validate_external_base_url", AsyncMock(return_value=None)), patch("httpx.AsyncClient") as client:
            with pytest.raises(HTTPException, match="接口地址已更改"):
                await routes.fetch_models(routes.FetchModelsRequest(base_url="https://changed.test/v1", config_id="saved"))
        client.assert_not_called()


@run_async
async def test_discovery_keeps_ssrf_guard_before_any_secret_or_network_access():
    with isolated_config() as routes:
        with patch.object(routes, "_validate_external_base_url", AsyncMock(return_value="禁止访问")), patch("httpx.AsyncClient") as client:
            with pytest.raises(HTTPException, match="禁止访问"):
                await routes.fetch_models(routes.FetchModelsRequest(base_url="http://169.254.169.254", api_key="fixture"))
        client.assert_not_called()
