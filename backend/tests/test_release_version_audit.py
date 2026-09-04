from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from scripts.release.audit_version_consistency import audit_version_consistency


class ReleaseVersionAuditTests(unittest.TestCase):
    def _write_repo(self, root: Path, *, backend_version: str = "0.4.0") -> None:
        (root / "frontend" / "src-tauri").mkdir(parents=True)
        (root / "backend" / "app").mkdir(parents=True)
        (root / "frontend" / "package.json").write_text(
            json.dumps({"version": "0.4.0"}), encoding="utf-8"
        )
        (root / "frontend" / "src-tauri" / "tauri.conf.json").write_text(
            json.dumps({"version": "0.4.0"}), encoding="utf-8"
        )
        (root / "frontend" / "src-tauri" / "Cargo.toml").write_text(
            '[package]\nname = "app"\nversion = "0.4.0"\n', encoding="utf-8"
        )
        (root / "backend" / "app" / "cli.py").write_text(
            f'APP_VERSION = "{backend_version}"\n', encoding="utf-8"
        )
        (root / "backend" / "app" / "main.py").write_text(
            'app = FastAPI(\n    version="0.4.0",\n)\n', encoding="utf-8"
        )

    def test_accepts_matching_semver_declarations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_repo(root)
            result = audit_version_consistency(root)

        self.assertEqual(result["status"], "clear")
        self.assertEqual(result["version"], "0.4.0")
        self.assertEqual(len(result["sources"]), 5)
        self.assertEqual(result["findings"], [])

    def test_rejects_version_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_repo(root, backend_version="0.3.0")
            result = audit_version_consistency(root)

        self.assertEqual(result["status"], "fail")
        self.assertIn("release version declarations do not match", result["findings"])

    def test_rejects_missing_source_declaration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_repo(root)
            (root / "frontend" / "src-tauri" / "Cargo.toml").unlink()
            result = audit_version_consistency(root)

        self.assertEqual(result["status"], "fail")
        self.assertEqual(len(result["sources"]), 4)
        self.assertTrue(any("Cargo.toml" in item for item in result["findings"]))

    def test_rejects_health_version_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_repo(root)
            (root / "backend" / "app" / "main.py").write_text(
                'app = FastAPI(\n    version="0.3.0",\n)\n', encoding="utf-8"
            )
            result = audit_version_consistency(root)

        self.assertEqual(result["status"], "fail")
        self.assertIn("release version declarations do not match", result["findings"])


if __name__ == "__main__":
    unittest.main()
