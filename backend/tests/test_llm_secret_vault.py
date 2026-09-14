from __future__ import annotations

import unittest
from unittest.mock import patch

from app.services import llm_secret_vault as vault


class FakeVault:
    """In-memory stand-in for the OS keyring."""

    def __init__(self, fail_writes: bool = False):
        self.items: dict[str, dict] = {}
        self.fail_writes = fail_writes

    def store(self, reference: str, payload: dict) -> None:
        if self.fail_writes:
            raise RuntimeError("denied")
        self.items[reference] = dict(payload)

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
        self.assertEqual(item["credential_ref"], vault.config_ref("cfg-1"))
        self.assertEqual(fake.items[vault.config_ref("cfg-1")]["api_key"], "sk-real-key")
        self.assertEqual(payload["deepseek_api_key"], "")
        self.assertEqual(payload["active_llm_api_key"], "")

    def test_hydrate_restores_key_from_reference(self):
        fake = FakeVault()
        with fake.install():
            payload = config_payload()
            vault.dehydrate(payload)

            restored = {"llm_api_configs": [dict(payload["llm_api_configs"][0])], "deepseek_api_key": ""}
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

    def test_clearing_key_removes_credential(self):
        fake = FakeVault()
        with fake.install():
            payload = config_payload()
            vault.dehydrate(payload)
            reference = vault.config_ref("cfg-1")
            self.assertIn(reference, fake.items)

            payload["llm_api_configs"][0]["api_key"] = ""
            vault.dehydrate(payload)

        self.assertNotIn(reference, fake.items)
        self.assertEqual(payload["llm_api_configs"][0]["credential_ref"], "")

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


if __name__ == "__main__":
    unittest.main()
