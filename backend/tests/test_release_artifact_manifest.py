from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from scripts.release.verify_release_artifacts import verify_release_artifacts


class ReleaseArtifactManifestTests(unittest.TestCase):
    def _write_release(self, root: Path, *, signed: bool = True) -> None:
        files = {
            "OfferU_0.4.0_x64-setup.exe": b"nsis installer",
            "OfferU_0.4.0_x64_en-US.msi": b"msi installer",
        }
        manifest = []
        checksum_lines = []
        for name, content in files.items():
            path = root / name
            path.write_bytes(content)
            checksum = hashlib.sha256(content).hexdigest()
            manifest.append({"name": name, "bytes": len(content), "sha256": checksum})
            checksum_lines.append(f"{checksum}  {name}")
        (root / "artifacts.json").write_text(json.dumps(manifest), encoding="utf-8")
        (root / "SHA256SUMS.txt").write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")
        (root / "version.json").write_text(
            json.dumps(
                {
                    "product": "OfferU",
                    "version": "0.4.0",
                    "target": "windows-x64",
                    "installers": list(files),
                    "signed": signed,
                }
            ),
            encoding="utf-8",
        )

    def test_verifies_manifest_checksums_version_and_signature(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_release(root)
            result = verify_release_artifacts(root, expected_version="0.4.0", require_signed=True)

        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["installer_count"], 2)
        self.assertTrue(result["signed"])

    def test_rejects_changed_installer_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_release(root)
            (root / "OfferU_0.4.0_x64-setup.exe").write_bytes(b"changed installer")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                verify_release_artifacts(root)

    def test_rejects_unsigned_release_when_signature_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_release(root, signed=False)
            with self.assertRaisesRegex(ValueError, "not marked as signed"):
                verify_release_artifacts(root, expected_version="0.4.0", require_signed=True)

    def test_rejects_manifest_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_release(root)
            manifest = json.loads((root / "artifacts.json").read_text(encoding="utf-8"))
            manifest[0]["name"] = "../outside.exe"
            (root / "artifacts.json").write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "files in the artifact root"):
                verify_release_artifacts(root)

    def test_rejects_symlink_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            target = parent / "release"
            target.mkdir()
            self._write_release(target)
            link = parent / "release-link"
            try:
                link.symlink_to(target, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symbolic links are unavailable in this Windows test environment")
            with self.assertRaisesRegex(ValueError, "directory must not be a symlink"):
                verify_release_artifacts(link)

    def test_rejects_symlink_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_release(root)
            outside = root.parent / f"offeru-manifest-outside-{root.name}.json"
            outside.write_text((root / "version.json").read_text(encoding="utf-8"), encoding="utf-8")
            version_path = root / "version.json"
            version_path.unlink()
            try:
                version_path.symlink_to(outside)
            except (OSError, NotImplementedError):
                self.skipTest("symbolic links are unavailable in this Windows test environment")
            try:
                with self.assertRaisesRegex(ValueError, "metadata file is a symlink"):
                    verify_release_artifacts(root)
            finally:
                outside.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
