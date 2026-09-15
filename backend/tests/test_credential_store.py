from __future__ import annotations

import unittest
from unittest.mock import patch

from app.services import credential_store


class _BackendModule:
    def __init__(self, backend: object):
        self.backend = backend

    def get_keyring(self) -> object:
        return self.backend


def _backend(module: str, name: str = "Backend") -> object:
    return type(name, (), {"__module__": module})()


class CredentialStoreTests(unittest.TestCase):
    def test_windows_native_backend_is_allowed(self) -> None:
        module = _BackendModule(_backend("keyring.backends.Windows", "WinVaultKeyring"))
        with patch.object(credential_store.sys, "platform", "win32"):
            credential_store._validate_native_backend(module)

    def test_plaintext_backend_is_rejected(self) -> None:
        module = _BackendModule(_backend("keyrings.alt.file", "PlaintextKeyring"))
        with patch.object(credential_store.sys, "platform", "win32"), self.assertRaises(RuntimeError):
            credential_store._validate_native_backend(module)

    def test_linux_secret_service_is_allowed(self) -> None:
        module = _BackendModule(_backend("keyring.backends.SecretService", "Keyring"))
        with patch.object(credential_store.sys, "platform", "linux"):
            credential_store._validate_native_backend(module)


if __name__ == "__main__":
    unittest.main()
