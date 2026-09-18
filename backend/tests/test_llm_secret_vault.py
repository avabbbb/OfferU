from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app import llm_config_store
from app.services import llm_secret_vault as vault
from app.services import runtime_credentials


class FakeVault:
    """In-memory stand-in for the OS keyring."""

    def __init__(self, fail_writes: bool = False, fail_after_write: bool = False):
        self.items: dict[str, dict] = {}
        self.fail_writes = fail_writes
        self.fail_after_write = fail_after_write

    def store(self, reference: str, payload: dict) -> None:
        if self.fail_writes:
            raise RuntimeError("denied")
        self.items[reference] = dict(payload)
        if self.fail_after_write:
            raise RuntimeError("interrupted after write")

    def load(self, reference: str) -> dict:
        if reference not in self.items:
            raise RuntimeError("系统钥匙串中的连接凭据不存在")
        return dict(self.items[reference])

    def delete(self, reference: str) -> None:
        self.items.pop(reference, None)

    def install(self):
        return patch.multiple(
            "app.services.credential_store",
            store_secret_sync=self.store,
            load_secret_sync=self.load,
            delete_secret_sync=self.delete,
        )


def config_payload(api_key: str = "sk-real-key", **updates) -> dict:
    return {
        "llm_api_configs": [
            {
                "id": "cfg-1",
                "provider_id": "deepseek",
                "service_name": "DeepSeek",
                "model": "deepseek-v4-flash",
                "base_url": "https://api.deepseek.com",
                "api_key": api_key,
                "credential_ref": "",
                "is_active": True,
                **updates,
            }
        ],
        "deepseek_api_key": api_key,
        "active_llm_api_key": api_key,
    }


class LlmSecretVaultTests(unittest.TestCase):
    def test_dehydrate_moves_plaintext_into_vault(self):
        fake = FakeVault()
        with fake.install():
            payload = config_payload()
            vault.dehydrate(payload)

        item = payload["llm_api_configs"][0]
        self.assertEqual(item["api_key"], "")
        self.assertTrue(item["credential_ref"].startswith("llm/config/"))
        self.assertEqual(fake.items[item["credential_ref"]]["api_key"], "sk-real-key")
        self.assertEqual(payload["deepseek_api_key"], "")
        self.assertEqual(payload["active_llm_api_key"], "")

    def test_hydrate_restores_key_from_reference(self):
        fake = FakeVault()
        with fake.install():
            payload = config_payload()
            vault.dehydrate(payload)

            restored = {
                "llm_api_configs": [dict(payload["llm_api_configs"][0])],
                "deepseek_api_key": "",
                "secret_refs": dict(payload["secret_refs"]),
            }
            vault.hydrate(restored)

        self.assertEqual(restored["llm_api_configs"][0]["api_key"], "sk-real-key")
        self.assertEqual(restored["deepseek_api_key"], "sk-real-key")

    def test_masked_value_keeps_existing_reference(self):
        fake = FakeVault()
        with fake.install():
            payload = config_payload(api_key="sk-real-key")
            vault.dehydrate(payload)
            reference = payload["llm_api_configs"][0]["credential_ref"]

            payload["llm_api_configs"][0]["api_key"] = "sk-re******key"
            vault.dehydrate(payload)

        self.assertEqual(payload["llm_api_configs"][0]["credential_ref"], reference)
        self.assertEqual(fake.items[reference]["api_key"], "sk-real-key")

    def test_empty_key_preserves_existing_reference(self):
        fake = FakeVault()
        with fake.install():
            payload = config_payload()
            vault.dehydrate(payload)
            reference = payload["llm_api_configs"][0]["credential_ref"]
            self.assertIn(reference, fake.items)

            payload["llm_api_configs"][0]["api_key"] = ""
            vault.dehydrate(payload)

        self.assertIn(reference, fake.items)
        self.assertEqual(payload["llm_api_configs"][0]["credential_ref"], reference)

    def test_env_reference_stays_in_config_file(self):
        fake = FakeVault()
        with fake.install():
            payload = config_payload(api_key="env:DEEPSEEK_API_KEY")
            vault.dehydrate(payload)

        self.assertEqual(payload["llm_api_configs"][0]["api_key"], "env:DEEPSEEK_API_KEY")
        self.assertEqual(payload["llm_api_configs"][0]["credential_ref"], "")
        self.assertEqual(fake.items, {})

    def test_write_failure_is_fail_closed(self):
        fake = FakeVault(fail_writes=True)
        with fake.install():
            with self.assertRaises(vault.VaultUnavailableError):
                vault.dehydrate(config_payload())

    def test_partial_vault_write_is_cleaned_up(self):
        fake = FakeVault(fail_after_write=True)
        with fake.install(), self.assertRaises(vault.VaultUnavailableError):
            vault.dehydrate(config_payload())
        self.assertEqual(fake.items, {})

    def test_default_headers_share_the_connection_reference(self):
        fake = FakeVault()
        payload = config_payload(default_headers={"Authorization": "Bearer route-secret", "X-Route": "one"})
        with fake.install():
            vault.dehydrate(payload)
            item = payload["llm_api_configs"][0]
            reference = item["credential_ref"]
            self.assertEqual(item["default_headers"], {})
            self.assertEqual(fake.items[reference]["default_headers"]["Authorization"], "Bearer route-secret")
            vault.hydrate(payload)
        self.assertEqual(payload["llm_api_configs"][0]["default_headers"]["X-Route"], "one")

    def test_env_key_can_use_vault_backed_headers(self):
        fake = FakeVault()
        payload = config_payload(api_key="env:OFFERU_API_KEY", default_headers={"Authorization": "Bearer secret"})
        with fake.install():
            vault.dehydrate(payload)
            item = payload["llm_api_configs"][0]
            self.assertEqual(item["api_key"], "env:OFFERU_API_KEY")
            self.assertEqual(item["default_headers"], {})
            vault.hydrate(payload)
        self.assertEqual(payload["llm_api_configs"][0]["default_headers"]["Authorization"], "Bearer secret")

    def test_scraper_cookies_are_only_persisted_by_reference(self):
        fake = FakeVault()
        payload = {"boss_cookie": "wt2=secret", "zhilian_cookie": "zp=secret"}
        with fake.install():
            vault.dehydrate(payload)
            self.assertEqual(payload["boss_cookie"], "")
            self.assertEqual(payload["zhilian_cookie"], "")
            self.assertTrue(payload["secret_refs"]["boss_cookie"].startswith("scraper/boss_cookie/"))
            vault.hydrate(payload)
        self.assertEqual(payload["boss_cookie"], "wt2=secret")
        self.assertEqual(payload["zhilian_cookie"], "zp=secret")

    def test_runtime_cookie_reader_hydrates_the_vault_reference(self):
        fake = FakeVault()
        with tempfile.TemporaryDirectory(dir="H:/tmp/offeru") as root:
            config_file = Path(root) / "config.json"
            payload = {"boss_cookie": "wt2=secret"}
            with fake.install():
                vault.dehydrate(payload)
                config_file.write_text(json.dumps(payload), encoding="utf-8")
                with patch.object(runtime_credentials, "runtime_config_file", return_value=config_file):
                    self.assertEqual(runtime_credentials.load_scraper_cookie("boss_cookie"), "wt2=secret")

    def test_migrate_plaintext_is_idempotent(self):
        fake = FakeVault()
        with fake.install():
            raw = config_payload()
            self.assertTrue(vault.migrate_plaintext(raw))
            self.assertEqual(raw["llm_api_configs"][0]["api_key"], "")
            self.assertFalse(vault.migrate_plaintext(raw))

    def test_missing_credential_reads_empty(self):
        fake = FakeVault()
        with fake.install():
            self.assertEqual(vault.read_key(vault.config_ref("nope")), "")

    def test_hydrate_read_failure_is_visible_in_vault_status(self):
        fake = FakeVault()
        payload = config_payload(api_key="", credential_ref="llm/config/missing")
        with fake.install(), patch("app.services.credential_store.probe_backend", return_value=""):
            vault.hydrate(payload)
            status = vault.status(force=True)
        self.assertFalse(status["available"])
        self.assertEqual(status["read_error_count"], 1)
        self.assertNotIn("llm/config/missing", status["error"])

    def test_reference_only_config_is_preserved(self):
        fake = FakeVault()
        reference = vault.config_ref("existing")
        fake.items[reference] = {"api_key": "sk-existing-key"}
        payload = config_payload(api_key="", credential_ref=reference)
        with fake.install():
            vault.dehydrate(payload)
        self.assertEqual(payload["llm_api_configs"][0]["credential_ref"], reference)
        self.assertEqual(fake.items[reference]["api_key"], "sk-existing-key")

    def test_migration_failure_leaves_payload_unchanged(self):
        fake = FakeVault(fail_writes=True)
        payload = config_payload()
        original = json.loads(json.dumps(payload))
        with fake.install(), self.assertRaises(vault.VaultUnavailableError):
            vault.migrate_plaintext(payload)
        self.assertEqual(payload, original)

    def test_replace_failure_preserves_file_and_removes_new_reference(self):
        fake = FakeVault()
        with tempfile.TemporaryDirectory(dir="H:/tmp/offeru") as root:
            config_file = Path(root) / "config.json"
            config_file.write_text('{"existing":true}', encoding="utf-8")
            with fake.install(), patch.object(llm_config_store, "runtime_config_file", return_value=config_file), \
                    patch("app.llm_config_store.os.replace", side_effect=OSError("denied")), \
                    self.assertRaises(OSError):
                llm_config_store.save_llm_config_file(config_payload())
            self.assertEqual(config_file.read_text(encoding="utf-8"), '{"existing":true}')
            self.assertEqual(fake.items, {})

    def test_successful_rotation_deletes_only_the_replaced_reference(self):
        fake = FakeVault()
        with tempfile.TemporaryDirectory(dir="H:/tmp/offeru") as root:
            config_file = Path(root) / "config.json"
            with fake.install(), patch.object(llm_config_store, "runtime_config_file", return_value=config_file):
                first = llm_config_store.save_llm_config_file(config_payload(api_key="sk-first"))
                first_ref = first["llm_api_configs"][0]["credential_ref"]
                second_payload = config_payload(api_key="sk-second", credential_ref=first_ref)
                second = llm_config_store.save_llm_config_file(second_payload)
            second_ref = second["llm_api_configs"][0]["credential_ref"]
            self.assertNotEqual(first_ref, second_ref)
            self.assertNotIn(first_ref, fake.items)
            self.assertIn(second_ref, fake.items)


if __name__ == "__main__":
    unittest.main()
