from __future__ import annotations

import unittest
import json
import tempfile
import sys
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import httpx2
from pydantic import ValidationError

from app.llm_presets import ENDPOINT_PROTOCOL_TEMPLATES


@contextmanager
def isolated_config():
    from app.config import Settings
    from app import config as app_config
    from app import runtime_paths
    from app.services import llm_secret_vault
    isolated_modules = ("app.llm_config_store", "app.routes.config")
    module_names_before = set(sys.modules).intersection(isolated_modules)

    with tempfile.TemporaryDirectory() as root:
        config_file = Path(root) / "config.json"
        settings = Settings(_env_file=None, database_url=f"sqlite+aiosqlite:///{Path(root) / 'test.db'}")
        try:
            with patch("app.runtime_paths.runtime_config_file", return_value=config_file), \
                 patch("app.config.get_settings", return_value=settings), \
                 patch.object(llm_secret_vault, "migrate_plaintext", return_value=False), \
                 patch.object(llm_secret_vault, "hydrate", return_value=None), \
                 patch.object(llm_secret_vault, "dehydrate", return_value=None):
                import app.llm_config_store as store
                with patch.object(store, "runtime_config_file", return_value=config_file):
                    import app.routes.config as routes
                    with patch.object(routes, "_current_config", None), \
                         patch.object(routes, "get_settings", return_value=settings):
                        yield routes
        finally:
            for module_name in reversed(isolated_modules):
                if module_name in module_names_before:
                    continue
                module = sys.modules.pop(module_name, None)
                if module is None or "." not in module_name:
                    continue
                parent_name, _, child_name = module_name.rpartition(".")
                parent = sys.modules.get(parent_name)
                if parent is not None and getattr(parent, child_name, None) is module:
                    delattr(parent, child_name)


class SseByteStream(httpx.AsyncByteStream):
    def __init__(self, payload: bytes):
        self.payload = payload
        self.closed = False

    async def __aiter__(self):
        yield self.payload

    async def aclose(self):
        self.closed = True


class AnthropicSseByteStream(httpx2.AsyncByteStream):
    def __init__(self, body: bytes):
        self.body = body
        self.closed = False

    async def __aiter__(self):
        yield self.body

    async def aclose(self) -> None:
        self.closed = True


class LlmProtocolTests(unittest.TestCase):
    def test_user_catalogue_contains_only_two_protocol_templates(self):
        self.assertEqual(
            [item["api_format"] for item in ENDPOINT_PROTOCOL_TEMPLATES],
            ["openai", "anthropic"],
        )
        self.assertTrue(all(not item.get("models") for item in ENDPOINT_PROTOCOL_TEMPLATES))

    def test_normalization_round_trips_protocol_and_capability_metadata(self):
        with isolated_config() as routes:
            cfg = routes.ConfigUpdate(llm_api_configs=[routes.LlmApiConfig(
                provider_id="custom-service", service_name="My service", model="my-model",
                base_url="https://example.test", api_key="sk-test", api_format="anthropic",
                credential_ref="llm/config/test", models={"standard": "my-model"},
                default_headers={"X-Route": "one"}, supports_json_mode=False,
            )])
            routes._normalize_llm_state(cfg)
            item = cfg.llm_api_configs[0]
            self.assertEqual(item.api_format, "anthropic")
            self.assertEqual(item.credential_ref, "llm/config/test")
            self.assertEqual(item.models, {"standard": "my-model"})
            self.assertEqual(item.default_headers, {"X-Route": "one"})
            self.assertFalse(item.supports_json_mode)

    def test_unknown_protocol_is_rejected(self):
        with isolated_config() as routes:
            with self.assertRaises(ValidationError):
                routes.LlmApiConfig(api_format="other")

    def test_normalization_preserves_reference_only_and_keyless_connections(self):
        with isolated_config() as routes:
            cfg = routes.ConfigUpdate(llm_api_configs=[
                routes.LlmApiConfig(id="locked", provider_id="custom", model="model",
                                    base_url="https://example.test/v1", credential_ref="llm/config/locked"),
                routes.LlmApiConfig(id="local", provider_id="custom", model="model",
                                    base_url="http://127.0.0.1:8080/custom"),
            ])
            routes._normalize_llm_state(cfg)
            self.assertEqual([item.id for item in cfg.llm_api_configs], ["locked", "local"])
            self.assertEqual(cfg.llm_api_configs[0].credential_ref, "llm/config/locked")
            self.assertEqual(cfg.llm_api_configs[1].base_url, "http://127.0.0.1:8080/custom")

    def test_explicit_empty_connection_list_does_not_restore_legacy_connections(self):
        with isolated_config() as routes:
            cfg = routes.ConfigUpdate(llm_api_configs=[], openai_api_key="test-legacy-secret")
            routes._normalize_llm_state(cfg)
            self.assertEqual(cfg.llm_api_configs, [])


class LlmProbeTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_openai_probe_rejects_empty_success_payload(self):
        from app.llm_config_store import probe_llm_endpoint

        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"choices": [{"message": {"content": ""}}]})

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            result = await probe_llm_endpoint("https://example.test/v1", "sk-test", "model", http_client=client)
        self.assertFalse(result["success"])


class LlmSdkTransportTests(unittest.IsolatedAsyncioTestCase):
    def _settings(self):
        return SimpleNamespace(llm_timeout=5, ssl_verify=True)

    async def test_openai_completion_uses_payload_and_closes_transport(self):
        from app.agents import llm

        async def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/v1/chat/completions")
            self.assertEqual(request.headers["x-route"], "test")
            body = request.read()
            self.assertIn(b'"model":"model"', body)
            return httpx.Response(200, json={"id": "chatcmpl-1", "choices": [{"message": {"content": "ok"}}]})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://example.test")
        resolved = {"api_format": "openai", "provider": "custom", "model": "model", "base_url": "https://example.test/v1", "api_key": "sk-test", "source": "test", "supports_json_mode": True, "default_headers": {"X-Route": "test"}}
        with patch.object(llm, "get_settings", return_value=self._settings()), patch.object(llm, "resolve_llm_client_config", return_value=resolved), patch.object(llm, "resolve_model_for_tier", return_value="model"), patch.object(llm, "_make_http_client", return_value=client):
            result = await llm.chat_completion([{"role": "user", "content": "Hi"}])
        self.assertEqual(result, "ok")

    async def test_anthropic_completion_uses_message_endpoint(self):
        from app.agents import llm

        async def handler(request: httpx2.Request) -> httpx2.Response:
            self.assertEqual(request.url.path, "/v1/messages")
            return httpx2.Response(200, json={"id": "msg_1", "type": "message", "role": "assistant", "model": "model", "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1}})

        client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler), base_url="https://example.test")
        resolved = {"api_format": "anthropic", "provider": "custom", "model": "model", "base_url": "https://example.test", "api_key": "sk-test", "source": "test", "supports_json_mode": True, "default_headers": {}}
        with patch.object(llm, "get_settings", return_value=self._settings()), patch.object(llm, "resolve_llm_client_config", return_value=resolved), patch.object(llm, "resolve_model_for_tier", return_value="model"), patch.object(llm, "_make_anthropic_http_client", return_value=client):
            result = await llm.chat_completion([{"role": "user", "content": "Hi"}])
        self.assertEqual(result, "ok")

    async def test_openai_stream_aggregates_text_and_closes_client_and_stream(self):
        from app.agents import llm

        stream_body = b"\n".join([
            b'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n',
            b'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}\n',
            b"data: [DONE]\n\n",
        ])
        body_stream = SseByteStream(stream_body)

        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=body_stream)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://example.test")
        resolved = {"api_format": "openai", "provider": "custom", "model": "model", "base_url": "https://example.test/v1", "api_key": "sk-test", "source": "test", "supports_json_mode": True, "default_headers": {}}
        with patch.object(llm, "get_settings", return_value=self._settings()), patch.object(llm, "resolve_llm_client_config", return_value=resolved), patch.object(llm, "resolve_model_for_tier", return_value="model"), patch.object(llm, "_make_http_client", return_value=client):
            result = "".join([chunk async for chunk in llm.chat_completion_stream([{"role": "user", "content": "Hi"}])])
        self.assertEqual(result, "ok!")
        self.assertTrue(client.is_closed)
        self.assertTrue(body_stream.closed)

    async def test_anthropic_stream_aggregates_text_and_closes_client_and_stream(self):
        from app.agents import llm

        events = [
            {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "content": [], "model": "model", "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "!"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 2}},
            {"type": "message_stop"},
        ]
        body_stream = AnthropicSseByteStream(b"".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode() for event in events))

        async def handler(request: httpx2.Request) -> httpx2.Response:
            return httpx2.Response(200, headers={"content-type": "text/event-stream"}, stream=body_stream)

        client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler), base_url="https://example.test")
        resolved = {"api_format": "anthropic", "provider": "custom", "model": "model", "base_url": "https://example.test", "api_key": "sk-test", "source": "test", "supports_json_mode": True, "default_headers": {}}
        with patch.object(llm, "get_settings", return_value=self._settings()), patch.object(llm, "resolve_llm_client_config", return_value=resolved), patch.object(llm, "resolve_model_for_tier", return_value="model"), patch.object(llm, "_make_anthropic_http_client", return_value=client):
            result = "".join([chunk async for chunk in llm.chat_completion_stream([{"role": "user", "content": "Hi"}])])
        self.assertEqual(result, "ok!")
        self.assertTrue(client.is_closed)
        self.assertTrue(body_stream.closed)

    async def test_openai_stream_aclose_closes_client_and_stream(self):
        from app.agents import llm

        body_stream = SseByteStream(b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')

        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=body_stream)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://example.test")
        resolved = {"api_format": "openai", "provider": "custom", "model": "model", "base_url": "https://example.test/v1", "api_key": "sk-test", "source": "test", "supports_json_mode": True, "default_headers": {}}
        with patch.object(llm, "get_settings", return_value=self._settings()), patch.object(llm, "resolve_llm_client_config", return_value=resolved), patch.object(llm, "resolve_model_for_tier", return_value="model"), patch.object(llm, "_make_http_client", return_value=client):
            generator = llm.chat_completion_stream([{"role": "user", "content": "Hi"}])
            await anext(generator)
            await generator.aclose()
        self.assertTrue(client.is_closed)
        self.assertTrue(body_stream.closed)

    async def test_anthropic_stream_aclose_closes_client_and_stream(self):
        from app.agents import llm

        body_stream = AnthropicSseByteStream(b'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n')

        async def handler(request: httpx2.Request) -> httpx2.Response:
            return httpx2.Response(200, headers={"content-type": "text/event-stream"}, stream=body_stream)

        client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler), base_url="https://example.test")
        resolved = {"api_format": "anthropic", "provider": "custom", "model": "model", "base_url": "https://example.test", "api_key": "sk-test", "source": "test", "supports_json_mode": True, "default_headers": {}}
        with patch.object(llm, "get_settings", return_value=self._settings()), patch.object(llm, "resolve_llm_client_config", return_value=resolved), patch.object(llm, "resolve_model_for_tier", return_value="model"), patch.object(llm, "_make_anthropic_http_client", return_value=client):
            generator = llm.chat_completion_stream([{"role": "user", "content": "Hi"}])
            await anext(generator)
            await generator.aclose()
        self.assertTrue(client.is_closed)
        self.assertTrue(body_stream.closed)

    async def test_stream_transport_error_closes_client(self):
        from app.agents import llm

        async def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("offline", request=request)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://example.test")
        resolved = {"api_format": "openai", "provider": "custom", "model": "model", "base_url": "https://example.test/v1", "api_key": "sk-test", "source": "test", "supports_json_mode": True, "default_headers": {}}
        with patch.object(llm, "get_settings", return_value=self._settings()), patch.object(llm, "resolve_llm_client_config", return_value=resolved), patch.object(llm, "resolve_model_for_tier", return_value="model"), patch.object(llm, "_make_http_client", return_value=client):
            result = "".join([chunk async for chunk in llm.chat_completion_stream([{"role": "user", "content": "Hi"}])])
        self.assertEqual(result, "")
        self.assertTrue(client.is_closed)

    async def test_anthropic_probe_uses_message_endpoint_and_nonempty_text(self):
        from app.llm_config_store import probe_llm_endpoint

        async def handler(request: httpx2.Request) -> httpx2.Response:
            self.assertEqual(request.url.path, "/v1/messages")
            return httpx2.Response(200, json={"id": "msg_1", "type": "message", "role": "assistant", "model": "model", "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}})

        transport = httpx2.MockTransport(handler)
        async with httpx2.AsyncClient(transport=transport) as client:
            result = await probe_llm_endpoint("https://example.test", "sk-test", "model", api_format="anthropic", http_client=client)
        self.assertTrue(result["success"])

    async def test_anthropic_probe_reports_transport_failure(self):
        from app.llm_config_store import probe_llm_endpoint

        async def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("offline", request=request)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            result = await probe_llm_endpoint("https://example.test", "sk-test", "model", api_format="anthropic", http_client=client)
        self.assertFalse(result["success"])


if __name__ == "__main__":
    unittest.main()
